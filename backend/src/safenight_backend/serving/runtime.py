"""Algorithm-independent runtime contract consumed by both assessment API paths."""

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from safenight_backend.map_schemas import MapModelInfo
from safenight_backend.serving.contracts import Assessment, FeatureVector
from safenight_backend.serving.service import AssessmentService


class RuntimeAdapter(Protocol):
    """A trusted startup-loaded model with stable public metadata and assessment output."""

    @property
    def model_loaded(self) -> bool:
        """Report a usable loaded predictor, not just a manifest or DB registration."""
        ...

    @property
    def info(self) -> MapModelInfo:
        """Return metadata for the same immutable model used by assess()."""
        ...

    def assess(self, features: FeatureVector | None, now: datetime) -> Assessment:
        """Return a nullable assessment, preserving evidence and support boundaries."""
        ...


@dataclass(frozen=True, slots=True)
class ServiceRuntime:
    """Wrap an algorithm-independent predictor/policy service for map and single reads."""

    service: AssessmentService
    info: MapModelInfo

    @property
    def model_loaded(self) -> bool:
        """Read actual predictor readiness from the shared assessment service."""
        return self.service.model_loaded

    def assess(self, features: FeatureVector | None, now: datetime) -> Assessment:
        """Keep every standard freshness, schema, support and output check in force."""
        return self.service.assess(features, now)
