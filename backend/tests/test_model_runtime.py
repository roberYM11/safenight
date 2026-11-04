"""Replaceable model factories retain shared serving behavior without RF dependencies."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final

import pytest

from safenight_backend import model_runtime
from safenight_backend.map_schemas import MapModelInfo
from safenight_backend.model_runtime import build_runtime
from safenight_backend.serving import (
    AssessmentService,
    AssessmentStatus,
    FeatureVector,
    PredictionError,
    ServingPolicy,
)
from safenight_backend.serving.runtime import RuntimeAdapter, ServiceRuntime

NOW: Final = datetime(2026, 11, 4, tzinfo=UTC)
FEATURES: Final = FeatureVector(
    sensor_id="fixture-sensor",
    observed_at=NOW - timedelta(minutes=1),
    lux=24,
    noise_db=48,
    revision="fixture-revision",
)


@dataclass(frozen=True, slots=True)
class ArithmeticFixture:
    """A non-RF test algorithm that responds to the actual input measurements."""

    offset: float = 0
    version: str = "fixture-arithmetic-v1"
    feature_version: str = "environment-v1"

    def predict(self, features: FeatureVector) -> float:
        if features.lux is None or features.noise_db is None:
            raise PredictionError(code="fixture_missing_measurement")
        return features.lux / 2 + features.noise_db / 4 + self.offset


def fixture_runtime(offset: float = 0) -> ServiceRuntime:
    predictor = ArithmeticFixture(offset=offset)
    return ServiceRuntime(
        AssessmentService(
            predictor,
            ServingPolicy(
                required_features=("lux", "noise_db"),
                supported_sensor_ids=frozenset({"fixture-sensor"}),
            ),
        ),
        MapModelInfo(name="ArithmeticFixture", version=predictor.version, status="ready"),
    )


@pytest.mark.parametrize(("offset", "expected"), [(0, 24), (10, 34)])
def test_replacement_factory_controls_prediction_without_random_forest_files(
    offset: float, expected: float, tmp_path: Path
) -> None:
    # Given: a replacement algorithm and a directory with no RF artifacts.
    calls: list[Path] = []

    def factory(directory: Path) -> RuntimeAdapter:
        calls.append(directory)
        return fixture_runtime(offset)

    # When: startup loads once and repeated requests use that runtime.
    runtime = build_runtime(tmp_path, factory=factory)
    first = runtime.assess(FEATURES, NOW)
    second = runtime.assess(FEATURES.model_copy(update={"lux": 44}), NOW)
    # Then: the selected adapter processes real input and preserves lineage.
    assert calls == [tmp_path]
    assert (first.status, first.score, second.score) == (
        AssessmentStatus.SCORED,
        expected,
        expected + 10,
    )
    assert first.model_version == runtime.info.version == "fixture-arithmetic-v1"
    assert first.feature_revision == "fixture-revision"


def test_normal_server_loading_uses_single_model_factory_seam(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Given: the dedicated model factory is replaced in trusted server code.
    monkeypatch.setattr(model_runtime, "load_model", lambda _: fixture_runtime(10))
    # When: normal startup does not supply a test-only factory parameter.
    runtime = build_runtime(tmp_path)
    # Then: the same default path used by safenight serve loads the new model.
    assert runtime.assess(FEATURES, NOW).score == 34


def test_replacement_adapter_preserves_freshness_abstention(tmp_path: Path) -> None:
    # Given: a compatible replacement adapter and stale source measurements.
    runtime = build_runtime(tmp_path, factory=lambda _: fixture_runtime())
    stale = FEATURES.model_copy(update={"observed_at": NOW - timedelta(hours=31)})
    # When: the replacement model receives stale data.
    result = runtime.assess(stale, NOW)
    # Then: model replacement cannot turn stale input into a numerical score.
    assert (result.status, result.score) == (AssessmentStatus.STALE, None)


def test_unconfigured_model_never_invokes_factory() -> None:
    # Given: no model directory has been configured.
    calls: list[Path] = []

    def factory(directory: Path) -> RuntimeAdapter:
        calls.append(directory)
        return fixture_runtime()

    # When: normal startup builds its model boundary.
    runtime = build_runtime(None, factory=factory)
    result = runtime.assess(FEATURES, NOW)
    # Then: neither an artifact nor a prediction is manufactured.
    assert not calls
    assert not runtime.model_loaded
    assert (result.status, result.score) == (AssessmentStatus.MODEL_UNAVAILABLE, None)


def test_explicit_service_override_takes_precedence_over_artifact_factory(tmp_path: Path) -> None:
    # Given: an injected adapter differs from the configured factory result.
    explicit = fixture_runtime(10)
    # When: existing create_app service injection is forwarded to the runtime builder.
    runtime = build_runtime(tmp_path, explicit.service, lambda _: fixture_runtime())
    # Then: the explicit service retains its original precedence.
    assert runtime.assess(FEATURES, NOW).score == 34
