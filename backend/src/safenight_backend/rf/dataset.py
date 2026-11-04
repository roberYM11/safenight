"""One-to-one reconstruction of the corrected project's engineered safety target."""

import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path

from safenight_backend.rf.contracts import ArtifactError, Boundary, TrainingRow


class DatasetProvenance(Boundary):
    """Source checksums retained beside the portable normalized training snapshot."""

    observations_sha256: str
    predictions_sha256: str
    target: str = "Corrected predictions.csv rule_index, not restored old_target or observed safety"


@dataclass(frozen=True, slots=True)
class TrainingDataset:
    """Validated rows plus source digests for a reproducible training snapshot."""

    rows: tuple[TrainingRow, ...]
    observations_sha256: str
    predictions_sha256: str

    def __post_init__(self) -> None:
        """Require unique sensor/time observations and one distinct site per sensor group."""
        if not self.rows:
            msg = "empty_training_snapshot"
            raise ArtifactError(msg)
        identities = {(row.sensor_id, row.time) for row in self.rows}
        locations = {(row.sensor_id, row.lat, row.lon) for row in self.rows}
        sensors = {row.sensor_id for row in self.rows}
        coordinates = {(row.lat, row.lon) for row in self.rows}
        if len(identities) != len(self.rows):
            msg = "duplicate_training_key"
            raise ArtifactError(msg)
        if len(locations) != len(sensors) or len(coordinates) != len(sensors):
            msg = "sensor_group_coordinate_mismatch"
            raise ArtifactError(msg)


def load_dataset(snapshot: Path) -> TrainingDataset:
    """Read the delivered normalized snapshot without needing the original project path."""
    provenance = DatasetProvenance.model_validate_json(
        snapshot.with_suffix(".provenance.json").read_bytes(),
    )
    with snapshot.open(newline="", encoding="utf-8") as stream:
        rows = tuple(TrainingRow.model_validate(row) for row in csv.DictReader(stream))
    return TrainingDataset(rows, provenance.observations_sha256, provenance.predictions_sha256)


def prepare_dataset(observations: Path, predictions: Path, output: Path) -> TrainingDataset:
    """Join by sensor/time; reject duplicate, absent, or coordinate-inconsistent targets."""
    with predictions.open(newline="", encoding="utf-8") as stream:
        labels = tuple(csv.DictReader(stream))
    lookup = {(row["sensor_id"], row["time"]): row for row in labels}
    if len(lookup) != len(labels):
        msg = "duplicate_target_key"
        raise ArtifactError(msg)
    with observations.open(newline="", encoding="utf-8") as stream:
        measurements = tuple(csv.DictReader(stream))
    keys = {(row["sensor_id"], row["time"]) for row in measurements}
    if len(keys) != len(measurements) or keys != lookup.keys():
        msg = "target_key_mismatch"
        raise ArtifactError(msg)
    result: list[TrainingRow] = []
    for row in measurements:
        target = lookup[(row["sensor_id"], row["time"])]
        if (float(row["lat"]), float(row["lon"])) != (
            float(target["lat"]),
            float(target["lon"]),
        ):
            msg = "target_coordinate_mismatch"
            raise ArtifactError(msg)
        result.append(
            TrainingRow(
                sensor_id=row["sensor_id"],
                time=row["time"],
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                lux=float(row["lux_avg"]),
                noise_db=float(row["noise_avg"]),
                safety_index=float(target["rule_index"]),
            ),
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("sensor_id", "time", "lat", "lon", "lux", "noise_db", "safety_index"))
        writer.writerows(
            (row.sensor_id, row.time, row.lat, row.lon, row.lux, row.noise_db, row.safety_index)
            for row in result
        )
    dataset = TrainingDataset(
        tuple(result),
        hashlib.sha256(observations.read_bytes()).hexdigest(),
        hashlib.sha256(predictions.read_bytes()).hexdigest(),
    )
    provenance = DatasetProvenance(
        observations_sha256=dataset.observations_sha256,
        predictions_sha256=dataset.predictions_sha256,
    )
    _ = output.with_suffix(".provenance.json").write_text(
        provenance.model_dump_json(indent=2) + "\n",
    )
    return dataset
