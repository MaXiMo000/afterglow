from __future__ import annotations

import pytest

from app.settings import ConfigError, load_settings

BASE = {
    "AFTERGLOW_ENV": "prod",
    "AFTERGLOW_ALLOWED_HOSTS": "afterglow.dev",
    "AFTERGLOW_PUBLIC_ORIGIN": "https://afterglow.dev",
}


def test_valid_prod() -> None:
    s = load_settings(BASE)
    assert s.is_prod
    assert s.allowed_hosts == ("afterglow.dev",)


def test_defaults_to_prod() -> None:
    env = {k: v for k, v in BASE.items() if k != "AFTERGLOW_ENV"}
    assert load_settings(env).is_prod


@pytest.mark.parametrize("hosts", ["*", "*.afterglow.dev", "", " , ", "a b", "host/evil", "host:80"])
def test_rejects_bad_hosts(hosts: str) -> None:
    with pytest.raises(ConfigError):
        load_settings({**BASE, "AFTERGLOW_ALLOWED_HOSTS": hosts})


@pytest.mark.parametrize(
    "origin",
    [
        "http://afterglow.dev",
        "https://afterglow.dev/path",
        "https://u:p@afterglow.dev",
        "javascript:alert(1)",
        "afterglow.dev",
    ],
)
def test_prod_rejects_bad_origin(origin: str) -> None:
    with pytest.raises(ConfigError):
        load_settings({**BASE, "AFTERGLOW_PUBLIC_ORIGIN": origin})


def test_dev_allows_http_origin() -> None:
    s = load_settings({**BASE, "AFTERGLOW_ENV": "dev", "AFTERGLOW_PUBLIC_ORIGIN": "http://localhost:5173"})
    assert s.public_origin == "http://localhost:5173"


@pytest.mark.parametrize("key", ["AFTERGLOW_ALLOWED_HOSTS", "AFTERGLOW_PUBLIC_ORIGIN"])
def test_missing_setting_fails_closed(key: str) -> None:
    with pytest.raises(ConfigError):
        load_settings({k: v for k, v in BASE.items() if k != key})


def test_unknown_env_rejected() -> None:
    with pytest.raises(ConfigError):
        load_settings({**BASE, "AFTERGLOW_ENV": "debug"})
