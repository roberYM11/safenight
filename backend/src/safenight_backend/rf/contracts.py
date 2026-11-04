"""Safe, data-only random forest artifacts and explicit training provenance."""

from dataclasses import dataclass
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True, slots=True)
class ArtifactError(ValueError):
    """A local model artifact violates its declared immutable contract."""

    code: str


class Boundary(BaseModel):
    """Immutable finite JSON boundary."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False
    )


class Location(Boundary):
    """A training sensor location, retained for the serving support boundary."""

    sensor_id: str = Field(min_length=1)
    lat: float = Field(ge=33, le=39)
    lon: float = Field(ge=124, le=132)


class TrainingRow(Location):
    """Normalized corrected observation with an engineered target, never an outcome label."""

    time: str = Field(min_length=1)
    lux: float = Field(ge=0, le=200000)
    noise_db: float = Field(ge=0, le=150)
    safety_index: float = Field(ge=0, le=100)


class FeatureBounds(Boundary):
    """The observed input domain; values beyond it do not receive a score."""

    lux_min: float
    lux_max: float
    noise_min: float
    noise_max: float


class TreeNode(Boundary):
    """One data-only tree node; no deserialization of executable Python objects."""

    feature: int
    threshold: float
    left: int
    right: int
    value: float = Field(ge=0, le=100)


class ForestPayload(Boundary):
    """The trained sklearn forest exported as numerical nodes."""

    format: Literal["safenight-rf-json-v1"] = "safenight-rf-json-v1"
    feature_version: Literal["environment-v1"] = "environment-v1"
    features: tuple[Literal["lux"], Literal["noise_db"]] = ("lux", "noise_db")
    bounds: FeatureBounds
    trees: tuple[tuple[TreeNode, ...], ...] = Field(min_length=1, max_length=256)
    locations: tuple[Location, ...] = Field(min_length=1)


class ModelMetadata(Boundary):
    """Audit metadata for the reduced experimental proxy model."""

    name: Literal["RandomForestRegressor"] = "RandomForestRegressor"
    version: str
    experimental: Literal[True] = True
    target: Literal["safety_index"] = "safety_index"
    target_source: str
    features: tuple[Literal["lux"], Literal["noise_db"]] = ("lux", "noise_db")
    training_rows: int
    training_sensors: int
    training_sha256: str
    artifact_sha256: str
    validation_mae: float
    validation_r2: float
    validation_note: str
    train_groups: tuple[str, ...]
    test_groups: tuple[str, ...]
    evaluation_train_rows: int
    evaluation_test_rows: int
    random_state: Literal[42] = 42
    trees: Literal[114] = 114
    max_depth: Literal[18] = 18
    min_samples_leaf: Literal[3] = 3
    bounds: FeatureBounds
    training_locations: tuple[Location, ...]
    source_observations_sha256: str
    source_predictions_sha256: str
