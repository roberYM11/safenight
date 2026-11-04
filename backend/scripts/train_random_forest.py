# /// script
# requires-python = ">=3.12"
# dependencies = ["safenight-backend"]
# [tool.uv.sources]
# safenight-backend = { path = "..", editable = true }
# ///
# ─── How to run ───
# From backend: uv run scripts/train_random_forest.py
# Or reconstruct sources: uv run scripts/train_random_forest.py <corrected-data-directory>
"""Fit the approved experimental target once from corrected, locally supplied source CSVs."""

from pathlib import Path
from typing import Annotated

import typer

from safenight_backend.rf.dataset import load_dataset, prepare_dataset
from safenight_backend.rf.training import train_bundle


def main(
    source: Annotated[Path | None, typer.Argument()] = None,
    output: Path = Path("var/models/random_forest"),
) -> None:
    """Rebuild the normalized snapshot and trained JSON forest with grouped evaluation."""
    snapshot = Path("data/training/environment_proxy.csv")
    dataset = (
        prepare_dataset(source / "restored_observations.csv", source / "predictions.csv", snapshot)
        if source is not None
        else load_dataset(snapshot)
    )
    bundle = train_bundle(dataset, snapshot, output)
    typer.echo(
        {
            "version": bundle.metadata.version,
            "training_rows": bundle.metadata.training_rows,
            "validation_mae": bundle.metadata.validation_mae,
            "validation_r2": bundle.metadata.validation_r2,
            "output": str(output),
        }
    )


if __name__ == "__main__":
    typer.run(main)
