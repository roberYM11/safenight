"""Check real exported observations and predictions as a coherent dataset."""

import csv
import hashlib
import json
from pathlib import Path

import numpy as np

from scoring import FEATURES, safety_index

ROOT = Path(__file__).resolve().parents[1]


def test_exported_predictions_match_restored_rule_and_coordinate_groups():
    # Given: saved inputs and coordinate-held-out predictions.
    with (ROOT / "data/processed/restored_observations.csv").open(newline="") as handle:
        inputs = list(csv.DictReader(handle))
    with (ROOT / "data/processed/predictions.csv").open(newline="") as handle:
        predictions = list(csv.DictReader(handle))
    x = np.array([[float(row[c]) for c in FEATURES] for row in inputs])
    # When: recomputing rule values and collecting folds by coordinate.
    expected = safety_index(x)
    coordinate_folds = {}
    for row in predictions:
        coordinate_folds.setdefault((row["lat"], row["lon"]), set()).add(row["fold"])
    # Then: exports are aligned and each coordinate has a single held-out fold.
    assert len(inputs) == len(predictions) == 3230
    assert len(coordinate_folds) == 652
    assert all(len(folds) == 1 for folds in coordinate_folds.values())
    assert len({(r["sensor_id"], r["time"]) for r in inputs}) == len(inputs)
    assert all(33 <= float(r["lat"]) <= 39 and 124 <= float(r["lon"]) <= 132 for r in inputs)
    np.testing.assert_allclose([float(r["rule_index"]) for r in predictions], expected, atol=1e-6)
    assert [(r["sensor_id"], r["time"]) for r in inputs] == [(r["sensor_id"], r["time"]) for r in predictions]


def test_benchmark_is_bound_to_the_bundled_input():
    # Given: the report records the input file hash.
    report = json.loads((ROOT / "results/benchmark.json").read_text())
    # When: hashing the distributed CSV.
    digest = hashlib.sha256((ROOT / "data/processed/restored_observations.csv").read_bytes()).hexdigest()
    # Then: the report belongs to this exact input.
    assert report["input_sha256"] == digest
