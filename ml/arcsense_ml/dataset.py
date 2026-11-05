"""Assemble labelled strides from many sessions into a training table (M07)."""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import numpy.typing as npt
import pandas as pd

from .features import stride_features
from .shared import class_names, feature_names

PROVENANCES = frozenset({"patient", "imitated", "synthetic"})


def build_dataset(parts: list[pd.DataFrame]) -> pd.DataFrame:
    """Concatenate labelled stride tables into features + label + subject + provenance.

    Each part needs the S_*.CSV stride columns plus ``label`` (class name or
    None), ``subject`` and ``provenance`` (patient | imitated | synthetic).
    Unlabelled and unclassifiable strides are dropped.
    """
    rows = []
    for p in parts:
        for col in ("label", "subject", "provenance"):
            if col not in p.columns:
                raise ValueError(f"dataset part is missing column {col!r}")
        bad = set(p["provenance"].unique()) - PROVENANCES
        if bad:
            raise ValueError(f"unknown provenance {sorted(bad)}")
        feats, valid = stride_features(p.reset_index(drop=True))
        keep = valid & p["label"].notna().to_numpy()
        unknown = set(p.loc[keep, "label"]) - set(class_names())
        if unknown:
            raise ValueError(f"unknown class labels {sorted(unknown)}")
        f = feats[keep].copy()
        f["label"] = p["label"].to_numpy()[keep]
        f["subject"] = p["subject"].to_numpy()[keep]
        f["provenance"] = p["provenance"].to_numpy()[keep]
        rows.append(f)
    if not rows:
        return pd.DataFrame(columns=[*feature_names(), "label", "subject", "provenance"])
    return pd.concat(rows, ignore_index=True)


def xy(df: pd.DataFrame) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.int64]]:
    classes = class_names()
    X = np.asarray(df[feature_names()].to_numpy(dtype=np.float32), dtype=np.float32)
    y = np.asarray(df["label"].map({c: i for i, c in enumerate(classes)}), dtype=np.int64)
    return X, y


def loso_splits(df: pd.DataFrame) -> Iterator[tuple[str, np.ndarray, np.ndarray]]:
    """Leave-one-subject-out: (held-out subject, train index, test index)."""
    subjects = sorted(df["subject"].unique())
    if len(subjects) < 2:
        raise ValueError("leave-one-subject-out needs at least two subjects")
    idx = np.arange(len(df))
    for s in subjects:
        test = (df["subject"] == s).to_numpy()
        yield s, idx[~test], idx[test]
