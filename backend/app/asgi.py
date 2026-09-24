"""ASGI entry point for uvicorn: `uvicorn app.asgi:app`. Settings are validated on import."""

from app.main import create_app

app = create_app()
