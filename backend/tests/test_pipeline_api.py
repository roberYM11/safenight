"""Provider wire fixtures through real PostgreSQL and the public ASGI API."""

import json
import os
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import httpx2
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.schema import CreateSchema, DropSchema

from safenight_backend import runner
from safenight_backend.config import Settings
from safenight_backend.db import make_engine, session_factory
from safenight_backend.main import create_app
from safenight_backend.migrations import initialize
from safenight_backend.models import ObservationRevision, RawObject, SourceCheckpoint, SourceRun
from safenight_backend.runner import CollectionRequest, collect

START = datetime(2026, 11, 2, 15, tzinfo=UTC)
END = datetime(2026, 11, 3, 15, tzinfo=UTC)
pytestmark = pytest.mark.anyio


@dataclass(frozen=True, slots=True)
class Environment:
    engine: AsyncEngine
    settings: Settings


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def environment() -> AsyncIterator[Environment]:
    url = os.environ.get("SAFENIGHT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set SAFENIGHT_TEST_DATABASE_URL for real PostgreSQL pipeline tests")
    original = make_engine(url)
    schema = "pipeline_" + uuid4().hex
    async with original.begin() as connection:
        await connection.execute(CreateSchema(schema))
    scoped_url = make_url(url).update_query_dict({"options": "-csearch_path=" + schema})
    engine = make_engine(scoped_url.render_as_string(hide_password=False))
    settings = Settings(
        _env_file=None,
        database_url=SecretStr(scoped_url.render_as_string(hide_password=False)),
        sdot_api_key=SecretStr("sdot-fixture-key"),
        cctv_api_key=SecretStr("cctv-fixture-key"),
        max_pages=2,
    )
    try:
        await initialize(engine)
        yield Environment(engine, settings)
    finally:
        await engine.dispose()
        async with original.begin() as connection:
            await connection.execute(DropSchema(schema, cascade=True))
        await original.dispose()


def sdot_body(total: int = 1) -> bytes:
    return json.dumps(
        {
            "sDoTEnv": {
                "list_total_count": total,
                "RESULT": {"CODE": "INFO-000"},
                "row": [
                    {
                        "SERIAL": "fixture-sensor",
                        "SENSING_TIME": "2026-11-03_01:00:00",
                        "DATE": "2026-11-03 01:05:00",
                        "DATA_NO": "1",
                        "AVG_INTE_ILLU": "24",
                        "AVG_NOISE": "48",
                    }
                ],
            }
        }
    ).encode()


def cctv_body(page: int) -> bytes:
    indices = range(100) if page == 1 else range(100, 101)
    return json.dumps(
        {
            "response": {
                "header": {"resultCode": "0"},
                "body": {
                    "totalCount": 101,
                    "pageNo": page,
                    "numOfRows": 100,
                    "items": {
                        "item": [
                            {
                                "OPN_ATMY_GRP_CD": "fixture-authority",
                                "MNG_NO": str(index),
                                "WGS84_LAT": "37.5",
                                "WGS84_LOT": "127.0",
                                "CAM_CNTOM": "4",
                                "DAT_CRTR_YMD": "2026-11-03",
                                "DAT_UPDT_PNT": "2026-11-03 01:00:00",
                            }
                            for index in indices
                        ]
                    },
                },
            }
        }
    ).encode()


def install_wire(
    monkeypatch: pytest.MonkeyPatch, wire: Callable[[httpx2.Request], httpx2.Response]
) -> None:
    def factory() -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(wire))

    monkeypatch.setattr(runner, "create_client", factory)


async def test_complete_pages_are_committed_and_read_by_api(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: two CCTV pages and a sensor page served at the HTTP transport boundary.
    def wire(request: httpx2.Request) -> httpx2.Response:
        body = (
            sdot_body()
            if request.url.host == "openapi.seoul.go.kr"
            else cctv_body(
                int(request.url.params.get("pageNo", "1")),
            )
        )
        return httpx2.Response(200, content=body)

    install_wire(monkeypatch, wire)
    app = create_app(environment.settings)
    # When: actual source runners persist all pages and the API reads the same database.
    first = await collect(
        environment.engine, environment.settings, CollectionRequest("sdot", START, END)
    )
    second = await collect(
        environment.engine,
        environment.settings,
        CollectionRequest("cctv", START, END, full_snapshot=True),
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://fixture",
        ) as client,
    ):
        observations = await client.get("/observations")
        assessment = await client.get("/assessments/fixture-sensor")
        sources = await client.get("/sources")
    # Then: real stored observations are visible while an absent model produces no score.
    assert first.status == "success"
    assert (second.status, second.fetched, second.inserted) == ("success", 101, 101)
    assert observations.status_code == 200
    assert observations.json()[0]["payload"]["noise_db"] == 48
    assert assessment.status_code == 200
    assert assessment.json()["score"] is None
    assert all(row["source"] != "cctv" for row in sources.json())


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (b"{", "sdot_invalid_payload"),
        (sdot_body(2), "page_count_mismatch"),
        (sdot_body(1001), "page_budget_exceeded"),
        (b'{"RESULT":{"CODE":"ERROR-301"}}', "sdot_provider_rejected"),
    ],
)
async def test_failed_provider_batch_is_archived_without_checkpoint(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
    body: bytes,
    code: str,
) -> None:
    # Given: malformed, incomplete, page-budget, or HTTP-200 application error responses.
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=body))
    settings = environment.settings.model_copy(update={"max_pages": 1})
    # When: the actual collection orchestration handles the provider failure.
    outcome = await collect(environment.engine, settings, CollectionRequest("sdot", START, END))
    # Then: original bytes and failed run survive, but no measurements/cursor are published.
    assert (outcome.status, outcome.error_code) == ("failed", code)
    async with session_factory(environment.engine)() as session:
        assert await session.scalar(select(func.count()).select_from(RawObject)) == 1
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 0
        assert await session.get(SourceCheckpoint, "sdot") is None
        run = await session.get(SourceRun, outcome.run_id)
        assert run is not None
        assert (run.status, run.error_code) == ("failed", code)


async def test_replayed_provider_pages_do_not_duplicate_database_revisions(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: a source run already committed one provider page.
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=sdot_body()))
    request = CollectionRequest("sdot", START, END)
    await collect(environment.engine, environment.settings, request)
    # When: the same complete page is collected again.
    outcome = await collect(environment.engine, environment.settings, request)
    # Then: a second successful run has no newly inserted revision.
    assert (outcome.status, outcome.inserted) == ("success", 0)
    async with session_factory(environment.engine)() as session:
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 1
        assert await session.scalar(select(func.count()).select_from(SourceRun)) == 2


async def test_repeated_page_inside_one_download_never_advances_checkpoint(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: the provider ignores the page argument and repeats page one.
    body = sdot_body(1001)
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=body))
    # When: collection requests the second page of the same source window.
    outcome = await collect(
        environment.engine, environment.settings, CollectionRequest("sdot", START, END)
    )
    # Then: original bytes survive, while the incomplete batch is never published.
    assert (outcome.status, outcome.error_code) == ("failed", "repeated_provider_page")
    async with session_factory(environment.engine)() as session:
        assert await session.scalar(select(func.count()).select_from(RawObject)) == 1
        assert await session.scalar(select(func.count()).select_from(ObservationRevision)) == 0
        assert await session.get(SourceCheckpoint, "sdot") is None
