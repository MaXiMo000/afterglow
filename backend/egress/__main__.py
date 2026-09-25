"""CONNECT-only forward proxy with an exact host allowlist: `python -m egress` (listens on :3128).

The worker's network is `internal`, so it cannot reach anything but this container. This proxy then allows
only `CONNECT github.com:443`, and only if github.com resolves to a public address (no DNS-rebinding into
private ranges). It never sees plaintext: TLS is end to end between git and GitHub.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket

ALLOWED = frozenset({("github.com", 443)})
MAX_HEADER = 8192
IDLE_TIMEOUT = 120.0


def allowed_target(request_line: bytes) -> tuple[str, int] | None:
    """Parse `CONNECT host:port HTTP/1.x`; return the target only if it is on the allowlist."""
    parts = request_line.rstrip(b"\r\n").split(b" ")
    if len(parts) != 3 or parts[0] != b"CONNECT" or not parts[2].startswith(b"HTTP/1."):
        return None
    host, sep, port = parts[1].decode("ascii", "replace").lower().rpartition(":")
    if not sep or not port.isdigit():
        return None
    target = (host, int(port))
    return target if target in ALLOWED else None


def public_address(infos: list[tuple[object, ...]]) -> str | None:
    """First resolved address that is globally routable, else None."""
    for info in infos:
        addr = str(info[4][0])  # type: ignore[index]
        if ipaddress.ip_address(addr).is_global:
            return addr
    return None


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT):
            writer.write(data)
            await writer.drain()
    except (TimeoutError, ConnectionError):
        pass
    finally:
        writer.close()


async def handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    try:
        head = await asyncio.wait_for(client_r.readuntil(b"\r\n\r\n"), 10)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ConnectionError):
        client_w.close()
        return
    target = allowed_target(head.split(b"\r\n", 1)[0])
    if target is None:
        client_w.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        client_w.close()
        return
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(target[0], target[1], type=socket.SOCK_STREAM)
        addr = public_address(list(infos))
        if addr is None:
            raise OSError("no public address")
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(addr, target[1]), 10)
    except (OSError, TimeoutError):
        client_w.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        client_w.close()
        return
    client_w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
    await asyncio.gather(_pipe(client_r, up_w), _pipe(up_r, client_w))


async def serve(host: str, port: int) -> None:
    server = await asyncio.start_server(handle, host, port, limit=MAX_HEADER)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(serve(os.environ.get("EGRESS_HOST", "0.0.0.0"), int(os.environ.get("EGRESS_PORT", "3128"))))  # noqa: S104  # nosec B104
