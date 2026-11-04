# /// script
# requires-python = ">=3.12"
# dependencies = ["pgserver==0.1.4", "anyio"]
# ///
# Run from backend: uv run scripts/local_postgres.py
"""Start a local Unix-socket PostgreSQL for development, never for public hosting."""

from pathlib import Path

import anyio
import pgserver


async def main() -> None:
    """Retain a real PostgreSQL process until this development session stops."""
    directory = await anyio.to_thread.run_sync(lambda: Path("var/postgres").resolve())
    await anyio.to_thread.run_sync(lambda: directory.parent.mkdir(exist_ok=True))
    server = await anyio.to_thread.run_sync(
        lambda: pgserver.get_server(directory, cleanup_mode="stop")
    )
    try:
        print(server.get_uri().replace("postgresql://", "postgresql+psycopg://", 1), flush=True)
        await anyio.sleep_forever()
    finally:
        server.cleanup()


if __name__ == "__main__":
    anyio.run(main)
