"""The in-process hub that turns Postgres notifications into stream wake-ups (app/notify.py)."""

from __future__ import annotations

from app.notify import ALL, Hub


def test_hub_wakes_only_the_streams_following_a_job() -> None:
    hub = Hub()
    a1, a2, b = hub.subscribe("a"), hub.subscribe("a"), hub.subscribe("b")
    hub.notify("a")
    assert a1.is_set() and a2.is_set() and not b.is_set()
    hub.notify("unknown")  # a job nobody follows is ignored
    hub.notify(ALL)  # queue movement: only streams that also listen for it (queued ones)
    assert not b.is_set()
    hub.subscribe(ALL, b)
    hub.notify(ALL)
    assert b.is_set()
    hub.notify_all()  # after a reconnect everything is re-checked


def test_hub_forgets_streams_that_left() -> None:
    hub = Hub()
    ev = hub.subscribe("a")
    hub.unsubscribe("a", ev)
    hub.unsubscribe("a", ev)  # leaving twice is harmless
    hub.notify("a")
    assert not ev.is_set()
    assert hub._waiting == {}
