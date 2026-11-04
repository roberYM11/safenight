"""Map endpoints read latest real DB revisions and coexist with built website assets."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import httpx2
import pytest
from sqlalchemy import func, select
from test_feature_lineage import workbook
from test_model_runtime import fixture_runtime
from test_pipeline_api import END, START, Environment, install_wire, sdot_body

from safenight_backend.db import session_factory
from safenight_backend.location_import import import_locations
from safenight_backend.main import create_app
from safenight_backend.models import FeatureSnapshot
from safenight_backend.runner import CollectionRequest, collect
from safenight_backend.serving.runtime import RuntimeAdapter

pytestmark = pytest.mark.anyio
pytest_plugins = ("test_pipeline_api",)


async def test_map_reads_latest_sensor_revision_and_keeps_api_routes_above_static_site(
    environment: Environment, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Given: two measurements for one sensor, a location, and built static HTML.
    payload = json.loads(sdot_body())
    original = payload["sDoTEnv"]["row"][0]
    newer = original | {
        "SENSING_TIME": "2026-11-03_02:00:00",
        "DATE": "2026-11-03 02:05:00",
        "AVG_INTE_ILLU": "99",
    }
    payload["sDoTEnv"]["row"] = [original, newer]
    payload["sDoTEnv"]["list_total_count"] = 2
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=json.dumps(payload).encode()))
    await collect(environment.engine, environment.settings, CollectionRequest("sdot", START, END))
    await import_locations(environment.engine, workbook(37.5), datetime(2026, 3, 10, tzinfo=UTC))
    (tmp_path / "index.html").write_text("<title>SafeNight fixture site</title>")
    settings = environment.settings.model_copy(update={"web_dist": tmp_path})
    app = create_app(settings)
    # When: browser-style and legacy API paths read the same running ASGI app.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client,
    ):
        response = await client.get("/api/map")
        legacy = await client.get("/map")
        sources = await client.get("/api/sources")
        home = await client.get("/")
    # Then: the latest sample appears once with nullable score and consistent lineage.
    assert response.status_code == legacy.status_code == sources.status_code == 200
    assert home.status_code == 200
    assert "SafeNight fixture site" in home.text
    data = response.json()
    assert (data["total_sensors"], data["unlocated_sensors"], len(data["sensors"])) == (1, 0, 1)
    sensor = data["sensors"][0]
    assert (sensor["lat"], sensor["lon"], sensor["lux"]) == (37.5, 127.0, 99)
    assert sensor["observed_at"].startswith("2026-11-03T02:00:00")
    assert sensor["score"] is None
    assert sensor["status"] == "MODEL_UNAVAILABLE"
    assert data["model"]["experimental"] is True
    assert legacy.json()["sensors"][0]["feature_revision"] == sensor["feature_revision"]
    async with session_factory(environment.engine)() as session:
        assert await session.scalar(select(func.count()).select_from(FeatureSnapshot)) == 1


async def test_map_reports_unlocated_sensor_without_inventing_a_coordinate(
    environment: Environment, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given: a real stored observation with no sensor location available.
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=sdot_body()))
    await collect(environment.engine, environment.settings, CollectionRequest("sdot", START, END))
    app = create_app(environment.settings)
    # When: the map API reads that observation.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client,
    ):
        response = await client.get("/api/map")
    # Then: it counts the missing location without placing an invented map marker.
    data = response.json()
    assert (data["total_sensors"], data["unlocated_sensors"], data["sensors"]) == (1, 1, [])


async def test_replacement_factory_serves_map_and_single_assessment_consistently(
    environment: Environment, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Given: real stored measurements and a non-RF replacement algorithm.
    payload = json.loads(sdot_body())
    recent = datetime.now(UTC) - timedelta(minutes=1)
    payload["sDoTEnv"]["row"][0]["SENSING_TIME"] = recent.isoformat()
    payload["sDoTEnv"]["row"][0]["DATE"] = recent.isoformat()
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=json.dumps(payload).encode()))
    start = recent.replace(hour=0, minute=0, second=0, microsecond=0)
    await collect(
        environment.engine,
        environment.settings,
        CollectionRequest("sdot", start, start + timedelta(days=1)),
    )
    await import_locations(environment.engine, workbook(37.5), datetime(2026, 3, 10, tzinfo=UTC))
    calls: list[Path] = []

    def replacement(directory: Path) -> RuntimeAdapter:
        calls.append(directory)
        return fixture_runtime(10)

    settings = environment.settings.model_copy(update={"model_bundle_dir": tmp_path})
    app = create_app(settings, runtime_factory=replacement)
    # When: both unchanged API paths read through the replacement runtime.
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client,
    ):
        map_response = await client.get("/api/map")
        single_response = await client.get("/api/assessments/fixture-sensor")
    # Then: one startup load supplies the same score and model version to both routes.
    assert calls == [tmp_path]
    assert map_response.status_code == single_response.status_code == 200
    data = map_response.json()
    assert len(data["sensors"]) == 1
    assert data["sensors"][0]["score"] == single_response.json()["score"] == 34
    assert data["model"]["version"] == single_response.json()["model_version"]
