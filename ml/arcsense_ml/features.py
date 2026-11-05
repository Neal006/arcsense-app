"""Per-stride classifier features (M06): the single Python implementation of
/shared/feature_spec.json. The app's TypeScript implementation is tested
against shared/fixtures/features_0007.json, generated from this module."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pandas as pd

from .shared import feature_names

# Rows the firmware emits before it has a complete stride (first stride has
# strideLengthM == 0, see FINDINGS F-04) or with non-physical timing are not
# classifiable; they are masked out rather than imputed.
MIN_STRIDE_S = 0.2
MAX_STRIDE_S = 5.0


def stride_features(strides: pd.DataFrame) -> tuple[pd.DataFrame, npt.NDArray[np.bool_]]:
    """Feature table (columns in spec order) and a mask of classifiable rows."""
    st = strides["strideTimeS"].astype("float64")
    feats = pd.DataFrame(
        {
            "strideTimeS": st,
            "swingTimeS": strides["swingTimeS"].astype("float64"),
            "stanceTimeS": strides["stanceTimeS"].astype("float64"),
            "strideLengthM": strides["strideLengthM"].astype("float64"),
            "tibialShockG": strides["tibialShockG"].astype("float64"),
            "asymmetryIndex": strides["asymmetryIndex"].astype("float64"),
            "freezeIndex": strides["freezeIndex"].astype("float64"),
        }
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        feats["cadenceSpm"] = 120.0 / st
        feats["swingRatio"] = feats["swingTimeS"] / st
        feats["stanceRatio"] = feats["stanceTimeS"] / st
    feats = feats[feature_names()]
    finite = np.isfinite(feats.to_numpy()).all(axis=1)
    valid = (
        finite
        & (st.to_numpy() >= MIN_STRIDE_S)
        & (st.to_numpy() <= MAX_STRIDE_S)
        & (feats["strideLengthM"].to_numpy() > 0)
    )
    return feats.reset_index(drop=True), valid


def feature_matrix(strides: pd.DataFrame) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.bool_]]:
    feats, valid = stride_features(strides)
    return feats.to_numpy(dtype=np.float32), valid
