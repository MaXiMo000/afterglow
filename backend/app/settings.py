"""Runtime configuration, read from the environment and validated at startup (SECURITY T13, T18).

Invalid configuration raises instead of falling back to a permissive default: fail closed.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

Env = Literal["dev", "prod"]


class ConfigError(ValueError):
    """Raised when configuration is missing, unsafe or malformed."""


@dataclass(frozen=True, slots=True)
class Settings:
    env: Env
    allowed_hosts: tuple[str, ...]
    public_origin: str

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"


def _parse_hosts(raw: str) -> tuple[str, ...]:
    hosts = tuple(h.strip().lower() for h in raw.split(",") if h.strip())
    if not hosts:
        raise ConfigError("AFTERGLOW_ALLOWED_HOSTS must list at least one host")
    for host in hosts:
        if "*" in host:
            raise ConfigError("wildcards are not allowed in AFTERGLOW_ALLOWED_HOSTS")
        if not all(c.isalnum() or c in ".-" for c in host):
            raise ConfigError("AFTERGLOW_ALLOWED_HOSTS contains an invalid host")
    return hosts


def _parse_origin(raw: str, env: Env) -> str:
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError("AFTERGLOW_PUBLIC_ORIGIN must be an absolute http(s) origin")
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        raise ConfigError("AFTERGLOW_PUBLIC_ORIGIN must be a bare origin")
    if env == "prod" and parts.scheme != "https":
        raise ConfigError("AFTERGLOW_PUBLIC_ORIGIN must use https in prod")
    return f"{parts.scheme}://{parts.netloc}"


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    source = os.environ if environ is None else environ
    env: Env
    match source.get("AFTERGLOW_ENV", "prod"):
        case "dev":
            env = "dev"
        case "prod":
            env = "prod"
        case _:
            raise ConfigError("AFTERGLOW_ENV must be 'dev' or 'prod'")
    try:
        hosts_raw = source["AFTERGLOW_ALLOWED_HOSTS"]
        origin_raw = source["AFTERGLOW_PUBLIC_ORIGIN"]
    except KeyError as missing:
        raise ConfigError(f"missing required setting {missing.args[0]}") from None
    return Settings(
        env=env, allowed_hosts=_parse_hosts(hosts_raw), public_origin=_parse_origin(origin_raw, env)
    )
