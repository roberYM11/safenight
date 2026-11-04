"""Frozen-input fitting and availability-aware validation use real sklearn models."""

import hashlib
from pathlib import Path

import pytest

from safenight_backend.rf import ArtifactError, load_bundle
from safenight_backend.rf.pipeline import (
    FrozenDataset,
    FrozenFeature,
    FrozenRow,
    grouped_split,
    region,
    time_split,
    train_pipeline,
)


def frozen_rows() -> tuple[FrozenRow, ...]:
    return tuple(
        FrozenRow(
            feature_snapshot_id=hashlib.sha256(f"{site}:{day}:{index}".encode()).hexdigest(),
            data_release_id="a" * 64,
            feature=FrozenFeature(
                sensor_id=f"sensor-{site}",
                observed_at=f"2026-11-0{day}T0{index}:00:00.000Z",
                lat=37.45 + site * 0.025,
                lon=127,
                lux=20 + index * 5 + site,
                noise_db=40 + index,
                feature_version="environment-v1",
                feature_revision=hashlib.sha256(f"{site}:{day}:{index}".encode()).hexdigest(),
            ),
            feature_available_at=f"2026-11-0{day}T0{index}:01:00.000Z",
            target_id=hashlib.sha256(f"label:{site}:{day}:{index}".encode()).hexdigest(),
            target_value=50 + index * 4 + site,
            target_time=f"2026-11-0{day}T0{index}:00:00.000Z",
            target_available_at=f"2026-11-0{day}T0{index}:02:00.000Z",
            target_object_key="labels/fixture.json",
            target_sha256="b" * 64,
        )
        for site in range(8)
        for day in (1, 2)
        for index in range(3)
    )


def test_sealed_pipeline_exports_real_candidate_and_three_disjoint_evaluations(
    tmp_path: Path,
) -> None:
    # Given: two days of individually available input and target revisions.
    rows = frozen_rows()
    frozen = FrozenDataset(
        format="safenight-training-v1",
        feature_version="environment-v1",
        target_version="fixture",
        training_cutoff="2026-11-03T00:00:00.000Z",
        split_policy="sensor-time-region-v1",
        rows=rows,
    )
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text(frozen.model_dump_json())
    # When: the pipeline worker fits and exports the data-only candidate.
    candidate = train_pipeline(snapshot, tmp_path / "model")
    # Then: hashes match the frozen bytes and each validation membership is explicit.
    bundle = load_bundle(tmp_path / "model")
    assert bundle.metadata.training_sha256 == hashlib.sha256(snapshot.read_bytes()).hexdigest()
    assert {evaluation.kind for evaluation in candidate.evaluations} == {"sensor", "time", "region"}
    lookup = {row.feature_snapshot_id: row for row in rows}
    for evaluation in candidate.evaluations:
        assert not set(evaluation.train_ids) & set(evaluation.test_ids)
        train = tuple(lookup[key] for key in evaluation.train_ids)
        test = tuple(lookup[key] for key in evaluation.test_ids)
        if evaluation.kind == "sensor":
            assert not {row.feature.sensor_id for row in train} & {
                row.feature.sensor_id for row in test
            }
        if evaluation.kind == "region":
            assert not {region(row) for row in train} & {region(row) for row in test}
        if evaluation.kind == "time":
            assert max(row.target_available_at for row in train) <= min(
                row.feature.observed_at for row in test
            )


def test_time_split_excludes_labels_that_arrived_after_the_test_start() -> None:
    # Given: every label became available only after the measured test period.
    rows = tuple(
        row.model_copy(update={"target_available_at": "2026-11-04T00:00:00.000Z"})
        for row in frozen_rows()
    )
    # When: constructing an availability-aware temporal split.
    train, test = time_split(rows)
    # Then: no future labels are silently used for training.
    assert train == ()
    assert len(test) == 24


def test_group_split_is_stable_when_input_order_changes() -> None:
    # Given: repeated observations per sensor.
    rows = frozen_rows()
    # When: input file ordering changes.
    forward = grouped_split(rows, lambda row: row.feature.sensor_id)
    backward = grouped_split(tuple(reversed(rows)), lambda row: row.feature.sensor_id)
    # Then: the actual membership is unchanged.
    assert {row.feature_snapshot_id for row in forward[1]} == {
        row.feature_snapshot_id for row in backward[1]
    }


def test_pipeline_refuses_values_outside_the_dataset_availability_cutoff(tmp_path: Path) -> None:
    # Given: a label unavailable at the claimed frozen cutoff.
    frozen = FrozenDataset(
        format="safenight-training-v1",
        feature_version="environment-v1",
        target_version="fixture",
        training_cutoff="2026-11-01T00:00:00.000Z",
        split_policy="sensor-time-region-v1",
        rows=frozen_rows(),
    )
    snapshot = tmp_path / "snapshot.json"
    snapshot.write_text(frozen.model_dump_json())
    # When / Then: the worker refuses to fit rather than backdating labels.
    with pytest.raises(ArtifactError, match="dataset_availability_mismatch"):
        train_pipeline(snapshot, tmp_path / "model")
