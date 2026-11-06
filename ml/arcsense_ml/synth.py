"""Synthetic per-stride data for exercising the training/export pipeline (M08).

THIS IS NOT CLINICAL DATA. Every row carries provenance="synthetic", and the
trainer stamps any report that contains synthetic rows as such. The "Normal"
class is sampled from the covariance of the real session 0007 strides; the
pathological classes are parametric distortions of it chosen to resemble
textbook descriptions (shuffling: short, quick, soft steps; post-stroke limp:
high asymmetry, long swing on the affected side; freezing: very short,
irregular steps with a high freeze index). They exist so the pipeline can be
tested end to end before real labelled trials exist, nothing more.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pandas as pd

from .features import stride_features
from .io import read_strides
from .shared import REPO_ROOT, class_names

BASE_COLUMNS = (
    "strideTimeS",
    "swingTimeS",
    "stanceTimeS",
    "strideLengthM",
    "tibialShockG",
    "asymmetryIndex",
    "freezeIndex",
)

# (multiplier mean, multiplier sd) per base column, or absolute (lo, hi) ranges
_DISTORT: dict[str, dict[str, tuple[float, float]]] = {
    "Shuffling": {
        "strideTimeS": (0.85, 0.05),
        "swingTimeS": (0.75, 0.05),
        "strideLengthM": (0.6, 0.06),
        "tibialShockG": (0.55, 0.08),
        "freezeIndex": (1.3, 0.2),
    },
    "Limping": {
        "strideTimeS": (1.15, 0.06),
        "swingTimeS": (1.3, 0.08),
        "strideLengthM": (0.8, 0.06),
        "tibialShockG": (0.8, 0.1),
    },
    "Freezing": {
        "strideTimeS": (0.7, 0.25),
        "swingTimeS": (0.5, 0.15),
        "strideLengthM": (0.3, 0.1),
        "tibialShockG": (0.4, 0.1),
    },
}
_ABSOLUTE: dict[str, dict[str, tuple[float, float]]] = {
    "Limping": {"asymmetryIndex": (0.15, 0.35)},
    "Freezing": {"freezeIndex": (3.0, 6.5)},
}


def reference_strides() -> pd.DataFrame:
    s = read_strides(REPO_ROOT / "data" / "reference" / "session_0007" / "S_L_0007.CSV")
    _, valid = stride_features(s)
    return s.loc[valid, list(BASE_COLUMNS)].reset_index(drop=True)


def synth_strides(
    cls: str, n: int, rng: np.random.Generator, subject_shift: npt.NDArray[np.float64] | None = None
) -> pd.DataFrame:
    if cls not in class_names():
        raise ValueError(f"unknown class {cls}")
    ref = reference_strides()
    mean = ref.mean().to_numpy()
    cov = np.cov(ref.to_numpy(), rowvar=False)
    base = rng.multivariate_normal(mean, cov, size=n)
    if subject_shift is not None:
        base = base * subject_shift
    df = pd.DataFrame(base, columns=list(BASE_COLUMNS))
    for col, (mu, sd) in _DISTORT.get(cls, {}).items():
        df[col] = df[col] * rng.normal(mu, sd, size=n)
    for col, (lo, hi) in _ABSOLUTE.get(cls, {}).items():
        df[col] = rng.uniform(lo, hi, size=n)
    # keep the gait cycle physical: positive values, swing at most 80% of the
    # stride, and stance derived last so swing + stance == stride exactly
    df = df.clip(lower=1e-3)
    df["strideTimeS"] = df["strideTimeS"].clip(lower=0.25)
    df["swingTimeS"] = np.minimum(df["swingTimeS"], 0.8 * df["strideTimeS"])
    df["stanceTimeS"] = df["strideTimeS"] - df["swingTimeS"]
    df["asymmetryIndex"] = df["asymmetryIndex"].clip(upper=1.0)
    df["label"] = cls
    df["provenance"] = "synthetic"
    return df


def synth_dataset(n_subjects: int = 6, strides_per_class: int = 60, seed: int = 0) -> pd.DataFrame:
    """Synthetic multi-subject dataset (each subject gets a small personal scale)."""
    rng = np.random.default_rng(seed)
    parts = []
    for s in range(n_subjects):
        shift = rng.normal(1.0, 0.04, size=len(BASE_COLUMNS))
        for cls in class_names():
            part = synth_strides(cls, strides_per_class, rng, subject_shift=shift)
            part["subject"] = f"SYN{s:02d}"
            parts.append(part)
    return pd.concat(parts, ignore_index=True)
