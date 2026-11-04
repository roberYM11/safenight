"""Public responses omit provider keys and database connection strings."""

from datetime import datetime
from typing import ClassVar

from pydantic import BaseModel, ConfigDict, JsonValue


class ObservationResponse(BaseModel):
    """A selected observation with source and immutable revision lineage."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True, from_attributes=True)
    id: str
    source: str
    entity_id: str
    observed_at: datetime
    published_at: datetime
    lat: float | None
    lon: float | None
    payload: dict[str, JsonValue]


class SourceStatus(BaseModel):
    """Configuration readiness is separate from successful ingestion."""

    source: str
    configured: bool
    covered_until: datetime | None
    last_status: str | None
    last_error: str | None
    full_baseline: bool


class HealthResponse(BaseModel):
    """Readiness health, separate from scientific model readiness."""

    status: str
    model_registered: bool = False
