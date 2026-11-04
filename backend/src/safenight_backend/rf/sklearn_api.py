"""Narrow typed facade over sklearn's documented fit/export API.

The companion stub supplies missing Cython tree properties and concrete dense
array overloads absent from the installed third-party sklearn stubs.
"""

from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GroupShuffleSplit

__all__ = ["GroupShuffleSplit", "RandomForestRegressor"]
