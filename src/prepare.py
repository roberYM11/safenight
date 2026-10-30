#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# ─── How to run ───
# Install uv: https://docs.astral.sh/uv/getting-started/installation/
# Run: uv run src/prepare.py path/to/corrected_inputs.csv
# ──────────────────
"""Deduplicate previously restored inputs without changing facility-count hypotheses."""

from __future__ import annotations

import csv
import math
import sys
from pathlib import Path


def main() -> None:
    """Keep the first identical sensor-time observation; stop on conflicting repeats."""
    source = Path(sys.argv[1])
    destination = Path(__file__).resolve().parents[1] / "data/processed/restored_observations.csv"
    rejected = []
    with source.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames
        assert columns is not None
        unique = {}
        for row in reader:
            key = (row["sensor_id"], row["time"])
            if not (33 <= float(row["lat"]) <= 39 and 124 <= float(row["lon"]) <= 132):
                rejected.append(row)
                continue
            assert all(math.isfinite(float(row[name])) for name in columns
                       if name not in ("sensor_id", "time"))
            previous = unique.get(key)
            if previous is not None:
                assert all(previous[k] == row[k] for k in columns if k != "raw_index")
            else:
                unique[key] = row
    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(unique.values())
    with destination.with_name("excluded_coordinates.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rejected)
    print(f"Prepared {len(unique)} observations; excluded {len(rejected)} invalid coordinate rows: {destination}")


if __name__ == "__main__":
    main()
