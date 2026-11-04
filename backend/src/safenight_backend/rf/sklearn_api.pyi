# The dense-array subset of sklearn used and exercised by the parity tests.

from collections.abc import Iterator
from typing import Self

import numpy as np
from numpy.typing import NDArray

class Tree:
    node_count: int
    feature: NDArray[np.int64]
    threshold: NDArray[np.float64]
    children_left: NDArray[np.int64]
    children_right: NDArray[np.int64]
    value: NDArray[np.float64]

class DecisionTree:
    tree_: Tree

class RandomForestRegressor:
    estimators_: list[DecisionTree]
    def __init__(
        self,
        *,
        n_estimators: int,
        max_depth: int,
        min_samples_leaf: int,
        random_state: int,
        n_jobs: int,
    ) -> None: ...
    def fit(self, x: NDArray[np.float64], y: NDArray[np.float64]) -> Self: ...
    def predict(self, x: NDArray[np.float64]) -> NDArray[np.float64]: ...

class GroupShuffleSplit:
    def __init__(self, *, n_splits: int, test_size: float, random_state: int) -> None: ...
    def split(
        self, x: NDArray[np.float64], y: NDArray[np.float64], groups: NDArray[np.str_]
    ) -> Iterator[tuple[NDArray[np.int64], NDArray[np.int64]]]: ...
