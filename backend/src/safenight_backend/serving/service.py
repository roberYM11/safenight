"""Fail-closed synchronous inference over an injected trusted model adapter."""

from datetime import UTC, datetime
from math import isfinite
from typing import Final

from safenight_backend.serving.contracts import (
    Assessment,
    AssessmentStatus,
    FeatureName,
    FeatureVector,
    PredictionError,
    Predictor,
    ServingPolicy,
)

MAX_SCORE: Final = 100.0
DEFAULT_POLICY: Final = ServingPolicy()


class AssessmentService:
    """Capture one immutable model and policy per service instance.

    Build a new instance after an approved artifact changes. Actual model
    approval, artifact verification and distributed release coordination live
    outside this boundary. No arbitrary model deserialization occurs here.
    """

    def __init__(
        self, predictor: Predictor | None = None, policy: ServingPolicy = DEFAULT_POLICY
    ) -> None:
        """Inject a trusted loaded adapter and its supported serving envelope."""
        self._predictor: Predictor | None = predictor
        self._policy: ServingPolicy = policy

    @property
    def model_loaded(self) -> bool:
        """Report a loaded adapter rather than merely a database registration row."""
        return self._predictor is not None

    def assess(self, features: FeatureVector | None, now: datetime) -> Assessment:
        """Abstain on absent, stale, unsupported or incompatible evidence."""
        predictor = self._predictor
        assessed_at = now.astimezone(UTC) if now.utcoffset() is not None else None
        score: float | None = None
        if predictor is None:
            status = AssessmentStatus.MODEL_UNAVAILABLE
        elif features is None:
            status = AssessmentStatus.DATA_UNAVAILABLE
        elif assessed_at is None or features.observed_at > assessed_at:
            status = AssessmentStatus.UNSUPPORTED
        elif features.feature_version != predictor.feature_version:
            status = AssessmentStatus.SCHEMA_MISMATCH
        elif assessed_at - features.observed_at > self._policy.max_age:
            status = AssessmentStatus.STALE
        elif features.sensor_id not in self._policy.supported_sensor_ids:
            status = AssessmentStatus.UNSUPPORTED
        else:
            values: dict[FeatureName, float | int | None] = {
                "lat": features.lat,
                "lon": features.lon,
                "lux": features.lux,
                "noise_db": features.noise_db,
                "cctv_count": features.cctv_count,
            }
            if any(values[name] is None for name in self._policy.required_features):
                status = AssessmentStatus.DATA_UNAVAILABLE
            else:
                status, score = _predict(predictor, features)
        return Assessment(
            score=score,
            status=status,
            observed_at=features.observed_at if features else None,
            assessed_at=assessed_at,
            model_version=predictor.version if predictor else None,
            feature_version=features.feature_version if features else None,
            feature_revision=features.revision if features else None,
            policy_version=self._policy.version,
        )


def _predict(
    predictor: Predictor, features: FeatureVector
) -> tuple[AssessmentStatus, float | None]:
    """Convert only declared adapter errors and invalid outputs into abstention."""
    try:
        prediction = predictor.predict(features)
    except PredictionError:
        return AssessmentStatus.MODEL_ERROR, None
    if isfinite(prediction) and 0 <= prediction <= MAX_SCORE:
        return AssessmentStatus.SCORED, prediction
    return AssessmentStatus.MODEL_ERROR, None


def assess(
    features: FeatureVector | None, predictor: Predictor | None, now: datetime
) -> Assessment:
    """Apply conservative defaults; configure AssessmentService to enable support."""
    return AssessmentService(predictor).assess(features, now)
