"""Digest-checked JSON forest inference with sklearn-compatible float32 inputs."""

import hashlib
from dataclasses import dataclass
from math import asin, cos, isfinite, radians, sin, sqrt
from pathlib import Path
from typing import Final

import numpy as np

from safenight_backend.rf.contracts import (
    ArtifactError,
    ForestPayload,
    ModelMetadata,
    TreeNode,
)
from safenight_backend.serving import FeatureVector, PredictionError

MAX_ARTIFACT_BYTES: Final = 32 * 1024 * 1024
SUPPORT_DISTANCE_METERS: Final = 250.0
MAX_TREE_NODES: Final = 10000


def distance_meters(lat: float, lon: float, other_lat: float, other_lon: float) -> float:
    """Measure coordinate drift in meters without treating degrees as a distance."""
    dlat, dlon = radians(other_lat - lat), radians(other_lon - lon)
    term = sin(dlat / 2) ** 2 + cos(radians(lat)) * cos(radians(other_lat)) * sin(dlon / 2) ** 2
    return 6371000 * 2 * asin(min(1, sqrt(term)))


def validate_payload(payload: ForestPayload) -> None:
    """Reject malformed references, cycles, invalid features, or inverted support bounds."""
    bounds = payload.bounds
    if bounds.lux_min > bounds.lux_max or bounds.noise_min > bounds.noise_max:
        msg = "inverted_bounds"
        raise ArtifactError(msg)
    if len({point.sensor_id for point in payload.locations}) != len(payload.locations):
        msg = "duplicate_training_sensor"
        raise ArtifactError(msg)
    for tree in payload.trees:
        if not tree or len(tree) > MAX_TREE_NODES:
            msg = "invalid_tree_size"
            raise ArtifactError(msg)
        for index, node in enumerate(tree):
            if node.left == node.right == -1:
                continue
            if node.feature not in {0, 1}:
                msg = "invalid_tree_feature"
                raise ArtifactError(msg)
            if not index < node.left < len(tree) or not index < node.right < len(tree):
                msg = "invalid_tree_reference"
                raise ArtifactError(msg)


def tree_value(tree: tuple[TreeNode, ...], values: tuple[float, float]) -> float:
    """Follow the already validated acyclic sklearn tree."""
    index = 0
    while tree[index].left != -1:
        node = tree[index]
        index = node.left if values[node.feature] <= node.threshold else node.right
    return tree[index].value


@dataclass(frozen=True, slots=True)
class ForestPredictor:
    """Immutable experimental predictor constrained to known sensors and observed inputs."""

    payload: ForestPayload
    version: str

    @property
    def feature_version(self) -> str:
        """Name the exact serving input contract."""
        return self.payload.feature_version

    def supports(self, features: FeatureVector) -> bool:
        """Require known sensor geometry and input ranges instead of extrapolating silently."""
        if (
            features.lux is None
            or features.noise_db is None
            or features.lat is None
            or features.lon is None
        ):
            return False
        bounds = self.payload.bounds
        if not (
            isfinite(features.lux)
            and isfinite(features.noise_db)
            and bounds.lux_min <= features.lux <= bounds.lux_max
            and bounds.noise_min <= features.noise_db <= bounds.noise_max
        ):
            return False
        return any(
            point.sensor_id == features.sensor_id
            and distance_meters(features.lat, features.lon, point.lat, point.lon)
            <= SUPPORT_DISTANCE_METERS
            for point in self.payload.locations
        )

    def predict(self, features: FeatureVector) -> float:
        """Average the fitted trees; missing or unsupported inputs are declared failures."""
        if not self.supports(features) or features.lux is None or features.noise_db is None:
            msg = "outside_training_support"
            raise PredictionError(msg)
        values = (float(np.float32(features.lux)), float(np.float32(features.noise_db)))
        return sum(tree_value(tree, values) for tree in self.payload.trees) / len(
            self.payload.trees
        )


@dataclass(frozen=True, slots=True)
class ModelBundle:
    """Loaded immutable model and its inspectable training evidence."""

    predictor: ForestPredictor
    metadata: ModelMetadata


def load_bundle(directory: Path) -> ModelBundle:
    """Load local data-only artifacts, checking their digest and manifest consistency."""
    model = directory / "model.json"
    if model.stat().st_size > MAX_ARTIFACT_BYTES:
        msg = "artifact_size_exceeded"
        raise ArtifactError(msg)
    body = model.read_bytes()
    metadata = ModelMetadata.model_validate_json((directory / "manifest.json").read_bytes())
    digest = hashlib.sha256(body).hexdigest()
    if digest != metadata.artifact_sha256 or metadata.version != f"rf-environment-v1-{digest[:12]}":
        msg = "artifact_digest_mismatch"
        raise ArtifactError(msg)
    payload = ForestPayload.model_validate_json(body)
    validate_payload(payload)
    if payload.locations != metadata.training_locations or payload.bounds != metadata.bounds:
        msg = "manifest_support_mismatch"
        raise ArtifactError(msg)
    if len(payload.trees) != metadata.trees or len(payload.locations) != metadata.training_sensors:
        msg = "manifest_count_mismatch"
        raise ArtifactError(msg)
    if set(metadata.train_groups) & set(metadata.test_groups):
        msg = "validation_group_overlap"
        raise ArtifactError(msg)
    return ModelBundle(ForestPredictor(payload, metadata.version), metadata)
