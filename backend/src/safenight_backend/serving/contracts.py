"""Typed boundaries for timestamped features and model assessments."""

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import ClassVar, Literal, Protocol, override

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

type FeatureName = Literal["lat", "lon", "lux", "noise_db", "cctv_count"]


class FeatureVector(BaseModel):
    """Validated feature revision; absent measurements remain explicitly absent."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False
    )

    sensor_id: str = Field(min_length=1)
    observed_at: AwareDatetime
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    lux: float | None = Field(default=None, ge=0)
    noise_db: float | None = Field(default=None, ge=0, le=200)
    cctv_count: int | None = Field(default=None, ge=0, strict=True)
    feature_version: str = Field(default="environment-v1", min_length=1)
    revision: str = Field(min_length=1)


class Predictor(Protocol):
    """Trusted immutable model adapter loaded outside the HTTP request path."""

    @property
    def version(self) -> str:
        """Return the immutable artifact version."""
        ...

    @property
    def feature_version(self) -> str:
        """Return the exact feature contract expected by this artifact."""
        ...

    def predict(self, features: FeatureVector) -> float:
        """Return a 0..100 score or raise a declared PredictionError."""
        ...


@dataclass(frozen=True, slots=True)
class PredictionError(Exception):
    """Declared adapter failure; unexpected programming errors are not hidden."""

    code: str

    @override
    def __str__(self) -> str:
        """Expose a stable failure code without serializing feature values."""
        return self.code


@dataclass(frozen=True, slots=True)
class ServingPolicy:
    """Trusted versioned policy; support must be configured for a registered model.

    The default empty support set deliberately scores no sensor. Registering an
    adapter alone cannot imply that its training covers every sensor in the DB.
    """

    version: str = "serving-v1"
    max_age: timedelta = timedelta(hours=30)
    required_features: tuple[FeatureName, ...] = ("lux", "noise_db", "cctv_count")
    supported_sensor_ids: frozenset[str] = frozenset()


class AssessmentStatus(StrEnum):
    """Stable machine-readable serving outcomes."""

    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE"
    STALE = "STALE"
    SCHEMA_MISMATCH = "SCHEMA_MISMATCH"
    UNSUPPORTED = "UNSUPPORTED"
    MODEL_ERROR = "MODEL_ERROR"
    SCORED = "SCORED"


class Assessment(BaseModel):
    """Assessment lineage with an explicit nullable score and no invented confidence."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False
    )

    score: float | None = Field(default=None, ge=0, le=100)
    status: AssessmentStatus
    observed_at: AwareDatetime | None
    assessed_at: AwareDatetime | None
    model_version: str | None
    feature_version: str | None
    feature_revision: str | None
    policy_version: str
