"""Public map contracts; experimental model scores remain distinct from observed measurements."""

from typing import ClassVar, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from safenight_backend.serving import AssessmentStatus


class MapModelInfo(BaseModel):
    """Describe the actual loaded model and the meaning of its validation metrics."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    name: str = "RandomForestRegressor"
    version: str | None = None
    experimental: Literal[True] = True
    target: Literal["safety_index"] = "safety_index"
    features: tuple[str, ...] = ("lux", "noise_db")
    training_rows: int | None = None
    validation_mae: float | None = None
    validation_r2: float | None = None
    validation_note: str = (
        "기존 규칙 지수를 근사한 실험용 모델입니다. 실제 범죄·사고 확률이 아닙니다."
    )
    status: Literal["ready", "unavailable"] = "unavailable"


class MapSensor(BaseModel):
    """One sensor's latest available observation and its nullable assessment."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True, allow_inf_nan=False)
    sensor_id: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    district: str
    neighborhood: str
    observed_at: AwareDatetime
    lux: float | None
    noise_db: float | None
    score: float | None = Field(ge=0, le=100)
    status: AssessmentStatus
    feature_revision: str


class MapResponse(BaseModel):
    """A current read through the model, observation and location revisions."""

    model_config: ClassVar[ConfigDict] = ConfigDict(frozen=True)
    generated_at: AwareDatetime
    model: MapModelInfo
    sensors: tuple[MapSensor, ...]
    total_sensors: int
    unlocated_sensors: int
