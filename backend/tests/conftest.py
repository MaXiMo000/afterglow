from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


@pytest.fixture
def prod_settings() -> Settings:
    return Settings(env="prod", allowed_hosts=("afterglow.test",), public_origin="https://afterglow.test")


@pytest.fixture
def client(prod_settings: Settings) -> TestClient:
    return TestClient(
        create_app(prod_settings), base_url="https://afterglow.test", raise_server_exceptions=False
    )
