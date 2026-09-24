"""Egress proxy allowlist (SECURITY T1, T4)."""

from __future__ import annotations

import asyncio
import socket

import pytest

from egress.__main__ import allowed_target, handle, public_address


@pytest.mark.parametrize(
    ("line", "ok"),
    [
        (b"CONNECT github.com:443 HTTP/1.1", True),
        (b"CONNECT GitHub.com:443 HTTP/1.1", True),
        (b"CONNECT github.com:22 HTTP/1.1", False),
        (b"CONNECT evil.example:443 HTTP/1.1", False),
        (b"CONNECT github.com.evil.example:443 HTTP/1.1", False),
        (b"CONNECT api.github.com:443 HTTP/1.1", False),
        (b"CONNECT 140.82.112.3:443 HTTP/1.1", False),
        (b"GET http://github.com/ HTTP/1.1", False),
        (b"CONNECT github.com HTTP/1.1", False),
        (b"CONNECT github.com:443", False),
    ],
)
def test_allowlist(line: bytes, ok: bool) -> None:
    assert (allowed_target(line) is not None) is ok


def _info(addr: str) -> tuple[object, ...]:
    return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, 443))


def test_private_resolution_is_refused() -> None:
    for addr in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.17.0.1", "0.0.0.0"):
        assert public_address([_info(addr)]) is None
    assert public_address([_info("10.0.0.1"), _info("140.82.112.3")]) == "140.82.112.3"


async def _roundtrip(request: bytes) -> bytes:
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write(request)
        await w.drain()
        data = await asyncio.wait_for(r.read(200), 5)
        w.close()
    return data


def test_denied_request_gets_403() -> None:
    reply = asyncio.run(_roundtrip(b"CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n"))
    assert reply.startswith(b"HTTP/1.1 403")


def test_rebinding_to_private_address_gets_502(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(*_: object, **__: object) -> list[tuple[object, ...]]:
        return [_info("127.0.0.1")]

    probe = asyncio.new_event_loop()
    loop_cls = type(probe)
    probe.close()
    monkeypatch.setattr(loop_cls, "getaddrinfo", lambda self, *a, **k: fake_getaddrinfo(*a, **k))
    reply = asyncio.run(_roundtrip(b"CONNECT github.com:443 HTTP/1.1\r\n\r\n"))
    assert reply.startswith(b"HTTP/1.1 502")
