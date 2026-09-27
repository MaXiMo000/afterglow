"""Client keys and concurrency caps (SECURITY T11): unit tests, no database."""

from __future__ import annotations

import pytest

from app.limits import Gate, client_id, client_network

KEY = b"k" * 32


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:fffe", True),  # one /64: one client
        ("2001:db8:1:2::1", "2001:db8:1:3::1", False),
        ("::ffff:203.0.113.7", "203.0.113.7", True),  # IPv4-mapped is the IPv4 client
        ("203.0.113.7", "203.0.113.8", False),
        ("2001:DB8:1:2::1", "2001:db8:1:2::1", True),
    ],
)
def test_ipv6_clients_are_keyed_by_64(a: str, b: str, same: bool) -> None:
    assert (client_id(KEY, a) == client_id(KEY, b)) is same


def test_client_network_forms() -> None:
    assert client_network("2001:db8:1:2:3:4:5:6") == "2001:db8:1:2::/64"
    assert client_network("203.0.113.7") == "203.0.113.7"
    assert client_network("unknown") == "unknown"


def test_leaked_stream_slot_expires() -> None:
    now = [0.0]
    g = Gate(per_key=1, total=1, max_age=300, clock=lambda: now[0])
    assert g.enter("a")  # never left: its generator was cancelled before it started
    assert not g.enter("a") and not g.enter("b")
    now[0] = 299.0
    assert not g.enter("b")
    now[0] = 301.0
    assert g.enter("b")
    g.leave("a")  # a late leave for an expired slot is harmless
    assert not g.enter("c")
    g.leave("b")
    assert g.enter("c")
