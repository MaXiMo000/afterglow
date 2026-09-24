"""Rate limits and concurrency caps (SECURITY T11), keyed by an HMAC of the client IP.

ponytail: in-process state, correct for one API process. Running several replicas needs these counters in
Postgres or Redis; until then the global caps are per replica.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from collections import OrderedDict
from dataclasses import dataclass


def client_id(ip_key: bytes, ip: str) -> str:
    """Stable pseudonym for a client IP. The raw IP is never stored or logged (SECURITY T6)."""
    return hmac.new(ip_key, ip.encode(), hashlib.sha256).hexdigest()[:32]


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
    """Concurrent-use cap per key and overall (open SSE streams)."""

    def __init__(self, per_key: int, total: int) -> None:
        self.per_key, self.total = per_key, total
        self._open: dict[str, int] = {}

    def enter(self, key: str) -> bool:
        if sum(self._open.values()) >= self.total or self._open.get(key, 0) >= self.per_key:
            return False
        self._open[key] = self._open.get(key, 0) + 1
        return True

    def leave(self, key: str) -> None:
        n = self._open.get(key, 0) - 1
        if n > 0:
            self._open[key] = n
        else:
            self._open.pop(key, None)
