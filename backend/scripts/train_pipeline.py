# /// script
# requires-python = ">=3.12"
# dependencies = ["safenight-backend"]
# [tool.uv.sources]
# safenight-backend = { path = "..", editable = true }
# ///
# ─── How to run ───
# From backend: uv run --locked python scripts/train_pipeline.py
#   --snapshot frozen.json --output var/candidate
"""Consume a sealed cloud dataset and print a data-only candidate for the authenticated runner."""

from pathlib import Path
from typing import Annotated

import typer

from safenight_backend.rf.pipeline import train_pipeline


def main(
    snapshot: Annotated[Path, typer.Option()], output: Annotated[Path, typer.Option()]
) -> None:
    """No API credentials or mutable database access are needed by the fitting process."""
    typer.echo(train_pipeline(snapshot, output).model_dump_json())


if __name__ == "__main__":
    typer.run(main)
