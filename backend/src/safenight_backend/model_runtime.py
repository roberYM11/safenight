"""Single trusted model-loading seam used by the CLI and Docker server alike."""

from collections.abc import Callable
from pathlib import Path

from safenight_backend.map_schemas import MapModelInfo
from safenight_backend.rf import load_bundle
from safenight_backend.rf.runtime import ForestRuntime
from safenight_backend.serving import AssessmentService
from safenight_backend.serving.runtime import RuntimeAdapter, ServiceRuntime

type RuntimeFactory = Callable[[Path], RuntimeAdapter]


def load_model(directory: Path) -> RuntimeAdapter:
    """Replace this factory's adapter when changing the model algorithm.

    This is trusted server code, never an import path supplied by an HTTP client.
    Replacing a compatible RF artifact needs only MODEL_BUNDLE_DIR configuration.
    A different algorithm implements RuntimeAdapter and is loaded here instead.
    """
    return ForestRuntime(load_bundle(directory))


def build_runtime(
    directory: Path | None,
    service: AssessmentService | None = None,
    factory: RuntimeFactory | None = None,
) -> RuntimeAdapter:
    """Load once at startup, preserving explicit test/service injection and abstention."""
    if service is not None:
        return ServiceRuntime(
            service,
            MapModelInfo(
                name="CustomAdapter", status="ready" if service.model_loaded else "unavailable"
            ),
        )
    if directory is None:
        return ServiceRuntime(AssessmentService(), MapModelInfo(name="UnconfiguredModel"))
    return (factory or load_model)(directory)
