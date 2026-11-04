"""Experimental random-forest runtime adapter, independent of API and DB handlers."""

from dataclasses import dataclass
from datetime import datetime

from safenight_backend.map_schemas import MapModelInfo
from safenight_backend.rf.artifact import ModelBundle
from safenight_backend.serving import Assessment, AssessmentService, FeatureVector, ServingPolicy


@dataclass(frozen=True, slots=True)
class ForestRuntime:
    """Compose the forest's input/location domain with standard serving checks."""

    bundle: ModelBundle

    @property
    def model_loaded(self) -> bool:
        """A constructed runtime holds one successfully verified model bundle."""
        return True

    @property
    def info(self) -> MapModelInfo:
        """Expose reproducible proxy validation rather than a safety accuracy claim."""
        metadata = self.bundle.metadata
        return MapModelInfo(
            name=metadata.name,
            version=metadata.version,
            features=metadata.features,
            training_rows=metadata.training_rows,
            validation_mae=metadata.validation_mae,
            validation_r2=metadata.validation_r2,
            validation_note=metadata.validation_note,
            status="ready",
        )

    def assess(self, features: FeatureVector | None, now: datetime) -> Assessment:
        """Abstain outside the registered model's input and sensor-location domain."""
        complete = features is not None and all(
            value is not None
            for value in (features.lat, features.lon, features.lux, features.noise_db)
        )
        supported = frozenset(
            (features.sensor_id,)
            if features is not None and (not complete or self.bundle.predictor.supports(features))
            else ()
        )
        policy = ServingPolicy(
            version="rf-environment-support-v1",
            required_features=("lat", "lon", "lux", "noise_db"),
            supported_sensor_ids=supported,
        )
        return AssessmentService(self.bundle.predictor, policy).assess(features, now)
