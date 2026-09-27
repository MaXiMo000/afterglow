"""Rate limits and concurrency caps (SECURITY T11), keyed by an HMAC of the client IP.

ponytail: in-process state, correct for one API process. Running several replicas needs these counters in
Postgres or Redis; until then the global caps are per replica.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass


def client_network(ip: str) -> str:
    """The unit one client controls: an IPv4 address, or an IPv6 /64. One home or phone usually gets a whole
    /64, so keying by the full IPv6 address would let a single client rotate past every limit."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return f"{ipaddress.IPv6Network((addr, 64), strict=False).network_address}/64"
    return str(addr)


def client_id(ip_key: bytes, ip: str) -> str:
    """Stable pseudonym for a client network. The raw IP is never stored or logged (SECURITY T6)."""
    return hmac.new(ip_key, client_network(ip).encode(), hashlib.sha256).hexdigest()[:32]


@dataclass(slots=True)
class _Bucket:
    tokens: float
    stamp: float


class RateLimiter:
    """Token bucket per key: `rate` requests per `per` seconds, bursting up to `rate`."""

    def __init__(self, rate: int, per: float, max_keys: int = 100_000) -> None:
        self.rate, self.per, self.max_keys = rate, per, max_keys
        self._buckets: OrderedDict[str, _Bucket] = OrderedDict()

    def check(self, key: str) -> float:
        """0 if allowed (and a token is taken), else seconds until the next token."""
        now = time.monotonic()
        b = self._buckets.pop(key, None) or _Bucket(float(self.rate), now)
        b.tokens = min(self.rate, b.tokens + (now - b.stamp) * self.rate / self.per)
        b.stamp = now
        self._buckets[key] = b
        if len(self._buckets) > self.max_keys:  # bounded memory under a spray of IPs
            self._buckets.popitem(last=False)
        if b.tokens >= 1:
            b.tokens -= 1
            return 0.0
        return (1 - b.tokens) * self.per / self.rate


class Gate:
    """Concurrent-use cap per key and overall (open SSE streams).

    A slot expires after `max_age` seconds even if `leave` never runs (a stream cancelled before its generator
    started skips its `finally`), so a leaked slot cannot lock a client, or everyone, out for good.
    """

    def __init__(
        self, per_key: int, total: int, max_age: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.per_key, self.total, self.max_age, self.clock = per_key, total, max_age, clock
        self._open: dict[str, list[float]] = {}  # key -> start times of open slots, oldest first

    def _prune(self, now: float) -> None:
        for key in [k for k, starts in self._open.items() if starts[0] <= now - self.max_age]:
            live = [t for t in self._open[key] if t > now - self.max_age]
            if live:
                self._open[key] = live
            else:
                del self._open[key]

    def enter(self, key: str) -> bool:
        now = self.clock()
        self._prune(now)
        if sum(map(len, self._open.values())) >= self.total or len(self._open.get(key, ())) >= self.per_key:
            return False
        self._open.setdefault(key, []).append(now)
        return True

    def leave(self, key: str) -> None:
        starts = self._open.get(key)
        if not starts:
            return  # already expired
        starts.pop(0)
        if not starts:
            del self._open[key]
