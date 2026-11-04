"""Read-only data and assessment API with an injected trusted model boundary."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated

import anyio
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from safenight_backend.camera_contracts import CameraDiscovery, SearchArea
from safenight_backend.camera_discovery import discover_nearby
from safenight_backend.config import Settings
from safenight_backend.db import make_engine, session_factory
from safenight_backend.features import build_features
from safenight_backend.map_data import read_map
from safenight_backend.map_schemas import MapResponse
from safenight_backend.migrations import initialize
from safenight_backend.model_runtime import RuntimeFactory, build_runtime
from safenight_backend.models import (
    CurrentObservation,
    ObservationRevision,
    SourceCheckpoint,
    SourceRun,
)
from safenight_backend.responses import FastJSONResponse
from safenight_backend.schemas import HealthResponse, ObservationResponse, SourceStatus
from safenight_backend.serving import Assessment, AssessmentService, FeatureVector


class ConfigurationError(ValueError):
    """Server startup requires an explicitly configured PostgreSQL connection."""


# Each nested handler is a separate HTTP path, not a combined request-time decision tree.
def create_app(  # noqa: C901
    settings: Settings,
    service: AssessmentService | None = None,
    *,
    runtime_factory: RuntimeFactory | None = None,
) -> FastAPI:
    """Compose a model-independent API; future models are injected here in trusted code."""
    if not settings.database_url.get_secret_value():
        raise ConfigurationError
    engine = make_engine(settings.database_url.get_secret_value())
    factory = session_factory(engine)
    runtime = build_runtime(settings.model_bundle_dir, service, runtime_factory)
    router = APIRouter()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        await initialize(engine)
        try:
            yield
        finally:
            await engine.dispose()

    app = FastAPI(
        title="SafeNight backend",
        version="0.1.0",
        lifespan=lifespan,
        default_response_class=FastJSONResponse,
    )

    @router.get("/health/live")
    async def live() -> HealthResponse:
        return HealthResponse(status="alive")

    @router.get("/health/ready")
    async def ready() -> HealthResponse:
        try:
            async with factory() as session:
                _ = await session.execute(text("SELECT 1"))
        except SQLAlchemyError:
            raise HTTPException(503, "database_unavailable") from None
        return HealthResponse(status="ready", model_registered=runtime.model_loaded)

    @router.get("/sources")
    async def sources() -> list[SourceStatus]:
        result: list[SourceStatus] = []
        async with factory() as session:
            for source, configured in (
                ("sdot", bool(settings.sdot_api_key.get_secret_value())),
                ("cctv", bool(settings.cctv_api_key.get_secret_value())),
                ("sensor_locations", settings.sensor_locations_file.exists()),
                ("streetlights", False),
                ("securitylights", False),
            ):
                checkpoint = await session.get(SourceCheckpoint, source)
                run = await session.scalar(
                    select(SourceRun)
                    .where(SourceRun.source == source)
                    .order_by(SourceRun.started_at.desc())
                    .limit(1)
                )
                baseline = await session.scalar(
                    select(SourceRun.id)
                    .where(
                        SourceRun.source == source,
                        SourceRun.status == "success",
                        SourceRun.full_snapshot.is_(True),
                    )
                    .limit(1)
                )
                result.append(
                    SourceStatus(
                        source=source,
                        configured=configured,
                        covered_until=checkpoint.covered_until if checkpoint else None,
                        last_status=run.status if run else None,
                        last_error=run.error_code if run else None,
                        full_baseline=baseline is not None,
                    )
                )
        return result

    @router.get("/observations")
    async def observations(
        source: str = "sdot",
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> list[ObservationResponse]:
        async with factory() as session:
            rows = await session.scalars(
                select(ObservationRevision)
                .join(
                    CurrentObservation,
                    CurrentObservation.revision_id == ObservationRevision.id,
                )
                .where(ObservationRevision.source == source)
                .order_by(ObservationRevision.observed_at.desc(), ObservationRevision.entity_id)
                .limit(limit)
            )
            return [ObservationResponse.model_validate(row) for row in rows]

    async def load_features(sensor_id: str) -> FeatureVector | None:
        async with factory.begin() as session:
            row = await session.scalar(
                select(ObservationRevision)
                .join(
                    CurrentObservation,
                    CurrentObservation.revision_id == ObservationRevision.id,
                )
                .where(
                    ObservationRevision.source == "sdot", ObservationRevision.entity_id == sensor_id
                )
                .order_by(ObservationRevision.observed_at.desc())
                .limit(1)
            )
            return await build_features(session, row) if row else None

    @router.get("/features/{sensor_id}")
    async def features(sensor_id: str) -> FeatureVector | None:
        return await load_features(sensor_id)

    @router.get("/assessments/{sensor_id}")
    async def assessment(sensor_id: str) -> Assessment:
        return await anyio.to_thread.run_sync(
            runtime.assess, await load_features(sensor_id), datetime.now(UTC)
        )

    @router.get("/map")
    async def map_view() -> MapResponse:
        async with factory.begin() as session:
            return await read_map(session, runtime)

    @router.get("/cctv/nearby")
    async def nearby_cctv(
        lat: Annotated[float, Query(ge=-90, le=90)],
        lon: Annotated[float, Query(ge=-180, le=180)],
        radius_m: Annotated[int, Query(ge=50, le=5000)] = 1000,
    ) -> CameraDiscovery:
        async with factory() as session:
            return await discover_nearby(
                session, SearchArea(lat=lat, lon=lon, radius_m=radius_m), settings
            )

    app.include_router(router)
    app.include_router(router, prefix="/api")
    if settings.web_dist is not None:
        app.mount("/", StaticFiles(directory=settings.web_dist, html=True), name="website")

    return app
