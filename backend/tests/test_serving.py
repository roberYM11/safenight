"""Serving behavior with a deterministic fixture adapter, not a validated model."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

import pytest
from pydantic import ValidationError

from safenight_backend.serving import (
    AssessmentService,
    AssessmentStatus,
    FeatureVector,
    PredictionError,
    ServingPolicy,
    assess,
)

NOW: Final = datetime(2026, 11, 4, 0, tzinfo=UTC)
FEATURES: Final = FeatureVector(
    sensor_id="fixture-A",
    observed_at=NOW - timedelta(hours=1),
    lux=30,
    noise_db=50,
    cctv_count=2,
    revision="revision-1",
)
POLICY: Final = ServingPolicy(supported_sensor_ids=frozenset({"fixture-A"}))


@dataclass(frozen=True, slots=True)
class FixturePredictor:
    """Return a fixed adapter result to test serving decisions independently."""

    result: float = 37.5
    version: str = "fixture-model-v1"
    feature_version: str = "environment-v1"

    def predict(self, features: FeatureVector) -> float:
        return self.result + 0 * len(features.sensor_id)


@dataclass(frozen=True, slots=True)
class FailedPredictor:
    """Represent a model adapter that reports an expected runtime failure."""

    version: str = "fixture-failed-v1"
    feature_version: str = "environment-v1"

    def predict(self, features: FeatureVector) -> float:
        raise PredictionError(code=f"fixture_failure_{features.sensor_id}")


def test_no_model_when_observations_exist() -> None:
    # Given: real observations cannot substitute for a registered model.
    features = FEATURES
    # When: the default service is called.
    result = assess(features, None, NOW)
    # Then: it reports an absent model and never fabricates a score.
    assert (result.status, result.score, result.model_version) == (
        AssessmentStatus.MODEL_UNAVAILABLE,
        None,
        None,
    )


def test_score_when_supported_fixture_adapter_is_injected() -> None:
    # Given: a fixture model and an explicit sensor support policy.
    service = AssessmentService(FixturePredictor(), POLICY)
    # When: current compatible observations are assessed.
    result = service.assess(FEATURES, NOW)
    # Then: prediction and its exact lineage reach the caller together.
    assert (result.status, result.score) == (AssessmentStatus.SCORED, 37.5)
    assert (result.model_version, result.feature_version, result.feature_revision) == (
        "fixture-model-v1",
        "environment-v1",
        "revision-1",
    )
    assert result.observed_at == FEATURES.observed_at


def test_missing_data_when_model_exists() -> None:
    # Given: an injected adapter without an observation for this request.
    service = AssessmentService(FixturePredictor(), POLICY)
    # When: data lookup returns no feature vector.
    result = service.assess(None, NOW)
    # Then: the response carries an explicit data gap.
    assert (result.status, result.score) == (AssessmentStatus.DATA_UNAVAILABLE, None)


@pytest.mark.parametrize(
    ("hours_old", "expected"), [(30, AssessmentStatus.SCORED), (31, AssessmentStatus.STALE)]
)
def test_freshness_when_observation_age_reaches_policy_boundary(
    hours_old: int,
    expected: AssessmentStatus,
) -> None:
    # Given: observations at or beyond the thirty-hour freshness boundary.
    features = FEATURES.model_copy(update={"observed_at": NOW - timedelta(hours=hours_old)})
    service = AssessmentService(FixturePredictor(), POLICY)
    # When: the service assesses the observation.
    result = service.assess(features, NOW)
    # Then: the configured boundary is inclusive and older data abstains.
    assert result.status is expected


def test_future_observation_when_timestamp_is_ahead_of_request() -> None:
    # Given: a future-dated observation.
    features = FEATURES.model_copy(update={"observed_at": NOW + timedelta(seconds=1)})
    # When: an otherwise supported model assesses it.
    result = AssessmentService(FixturePredictor(), POLICY).assess(features, NOW)
    # Then: future observations cannot produce a present-time score.
    assert (result.status, result.score) == (AssessmentStatus.UNSUPPORTED, None)


def test_schema_mismatch_when_model_requires_different_features() -> None:
    # Given: a v2 model cannot read the v1 feature contract.
    model = FixturePredictor(feature_version="environment-v2")
    # When: a v1 observation reaches this model.
    result = AssessmentService(model, POLICY).assess(FEATURES, NOW)
    # Then: silent positional feature reinterpretation is prevented.
    assert (result.status, result.score) == (AssessmentStatus.SCHEMA_MISMATCH, None)


def test_support_when_registered_adapter_has_no_declared_sensors() -> None:
    # Given: loading an adapter alone does not prove its training support.
    service = AssessmentService(FixturePredictor())
    # When: an arbitrary sensor is requested.
    result = service.assess(FEATURES, NOW)
    # Then: the default empty support policy abstains.
    assert (result.status, result.score) == (AssessmentStatus.UNSUPPORTED, None)


def test_missing_cctv_when_feature_is_required_by_policy() -> None:
    # Given: unknown CCTV coverage is represented by None instead of zero.
    features = FEATURES.model_copy(update={"cctv_count": None})
    # When: the configured model requires the CCTV feature.
    result = AssessmentService(FixturePredictor(), POLICY).assess(features, NOW)
    # Then: the gap is surfaced without a false zero-count prediction.
    assert (result.status, result.score) == (AssessmentStatus.DATA_UNAVAILABLE, None)


@pytest.mark.parametrize("prediction", [float("nan"), float("inf"), -1, 101])
def test_invalid_prediction_when_adapter_violates_score_range(prediction: float) -> None:
    # Given: an adapter returns a nonfinite or out-of-range output.
    service = AssessmentService(FixturePredictor(result=prediction), POLICY)
    # When: the output crosses the response boundary.
    result = service.assess(FEATURES, NOW)
    # Then: invalid output is a model error with no fallback score.
    assert (result.status, result.score) == (AssessmentStatus.MODEL_ERROR, None)


def test_declared_prediction_failure_when_adapter_cannot_infer() -> None:
    # Given: a typed adapter failure.
    service = AssessmentService(FailedPredictor(), POLICY)
    # When: prediction is attempted.
    result = service.assess(FEATURES, NOW)
    # Then: callers receive an explicit failure without fabricated certainty.
    assert (result.status, result.score) == (AssessmentStatus.MODEL_ERROR, None)


def test_nonfinite_measurement_when_input_is_parsed() -> None:
    # Given: a corrupt numeric measurement at the external boundary.
    payload = FEATURES.model_dump() | {"noise_db": float("nan")}
    # When/Then: parsing rejects the payload before model invocation.
    with pytest.raises(ValidationError):
        FeatureVector.model_validate(payload)


def test_naive_timestamp_when_input_is_parsed() -> None:
    # Given: a source timestamp without an explicit timezone.
    payload = FEATURES.model_dump() | {"observed_at": NOW.replace(tzinfo=None)}
    # When/Then: parsing cannot silently assume a timezone.
    with pytest.raises(ValidationError):
        FeatureVector.model_validate(payload)
