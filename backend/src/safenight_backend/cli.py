"""Server and source jobs have independent lifecycles and safe operational output."""

from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

import anyio
import typer
import uvicorn

from safenight_backend.config import Settings
from safenight_backend.db import make_engine
from safenight_backend.http_client import create_client
from safenight_backend.ingestion.locations import parse_locations
from safenight_backend.location_import import import_locations
from safenight_backend.main import create_app
from safenight_backend.migrations import initialize
from safenight_backend.runner import CollectionRequest, SourceName, collect
from safenight_backend.schedule import run_due, scheduler

app = typer.Typer(help="SafeNight server, source jobs and schema management")


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    """Start the read-only API; it never starts its own scheduler."""
    uvicorn.run(create_app(Settings()), host=host, port=port)


async def initialize_database(settings: Settings) -> None:
    """Apply the versioned initial schema without deleting existing observations."""
    engine = make_engine(settings.database_url.get_secret_value())
    try:
        await initialize(engine)
    finally:
        await engine.dispose()


@app.command()
def migrate() -> None:
    """Create/verify the initial schema version."""
    anyio.run(initialize_database, Settings())
    typer.echo("schema_ready")


@app.command("collect")
def collect_command(
    source: Annotated[str, typer.Argument(help="sdot or cctv")],
    day: Annotated[str, typer.Option(help="KST day YYYY-MM-DD")],
    full_snapshot: bool = False,
) -> None:
    """Collect a complete source window; page limits never publish partial results."""
    if source not in {"sdot", "cctv"}:
        message = "source must be sdot or cctv"
        raise typer.BadParameter(message)
    source_name: SourceName = "sdot" if source == "sdot" else "cctv"
    start = datetime.combine(date.fromisoformat(day), time.min, tzinfo=ZoneInfo("Asia/Seoul"))
    settings = Settings()

    async def execute() -> None:
        engine = make_engine(settings.database_url.get_secret_value())
        try:
            await initialize(engine)
            result = await collect(
                engine,
                settings,
                CollectionRequest(
                    source_name,
                    start,
                    start + timedelta(days=1),
                    full_snapshot,
                ),
            )
            typer.echo(asdict(result))
            if result.status == "failed":
                raise typer.Exit(1)
        finally:
            await engine.dispose()

    anyio.run(execute)


@app.command()
def schedule(once: bool = False) -> None:
    """Run the independent daily scheduler, or execute its current due decisions once."""
    settings = Settings()

    async def execute() -> None:
        engine = make_engine(settings.database_url.get_secret_value())
        try:
            await initialize(engine)
            if once:
                typer.echo(await run_due(engine, settings, datetime.now(UTC)))
            else:
                await scheduler(engine, settings)
        finally:
            await engine.dispose()

    anyio.run(execute)


@app.command("download-locations")
def download_locations() -> None:
    """Fetch the official public sensor-location XLSX; no additional API key is needed."""
    settings = Settings()

    async def execute() -> None:
        async with create_client() as client:
            response = await client.post(
                "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false",
                data={"infId": "OA-22833", "infSeq": "3", "seq": "20260310", "seqNo": ""},
            )
            _ = response.raise_for_status()
            locations = parse_locations(response.content)
            settings.sensor_locations_file.parent.mkdir(parents=True, exist_ok=True)
            _ = settings.sensor_locations_file.write_bytes(response.content)
            engine = make_engine(settings.database_url.get_secret_value())
            try:
                await initialize(engine)
                inserted = await import_locations(
                    engine,
                    response.content,
                    datetime(2026, 3, 10, tzinfo=ZoneInfo("Asia/Seoul")),
                )
            finally:
                await engine.dispose()
            typer.echo(
                {
                    "sensor_locations": len(locations),
                    "file": str(settings.sensor_locations_file),
                    "inserted_revisions": inserted,
                }
            )

    anyio.run(execute)
