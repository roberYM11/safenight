"""Real DB feature revisions track location changes and preserve unknown facilities."""

import io
from datetime import UTC, datetime

import httpx
import httpx2
import pytest
from openpyxl import Workbook
from test_pipeline_api import END, START, Environment, install_wire, sdot_body

from safenight_backend.location_import import import_locations
from safenight_backend.main import create_app
from safenight_backend.runner import CollectionRequest, collect

pytestmark = pytest.mark.anyio
pytest_plugins = ("test_pipeline_api",)


def workbook(latitude: float) -> bytes:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.append(["모델 시리얼(*)", "위도", "경도"])
    sheet.append(["fixture-sensor", latitude, 127.0])
    output = io.BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


async def test_location_snapshot_changes_feature_lineage_without_inventing_camera_count(
    environment: Environment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given: a sensor measurement and an officially shaped earlier location snapshot.
    install_wire(monkeypatch, lambda _: httpx2.Response(200, content=sdot_body()))
    await collect(environment.engine, environment.settings, CollectionRequest("sdot", START, END))
    await import_locations(environment.engine, workbook(37.5), datetime(2026, 3, 10, tzinfo=UTC))
    app = create_app(environment.settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://fixture",
        ) as client,
    ):
        before = (await client.get("/features/fixture-sensor")).json()
        # When: a new effective location snapshot is imported for the same sensor.
        await import_locations(
            environment.engine, workbook(37.6), datetime(2026, 11, 2, tzinfo=UTC)
        )
        after = (await client.get("/features/fixture-sensor")).json()
    # Then: coordinates and lineage change; unknown CCTV coverage remains unknown.
    assert (before["lat"], after["lat"]) == (37.5, 37.6)
    assert before["revision"] != after["revision"]
    assert after["cctv_count"] is None
