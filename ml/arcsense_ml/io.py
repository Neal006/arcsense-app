"""Readers for the firmware SD-card CSV files (S_*, E_*, I_*).

Every reader validates the header against the documented schema and coerces
columns to numeric types, raising :class:`SchemaError` with the offending file
and column instead of silently producing NaNs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

STRIDE_COLUMNS: tuple[str, ...] = (
    "session_us",
    "timestamp_us",
    "sampleIndex",
    "strideTimeS",
    "swingTimeS",
    "stanceTimeS",
    "strideLengthM",
    "tibialShockG",
    "asymmetryIndex",
    "freezeIndex",
    "edgeai_label",
    "edgeai_confidence",
)
EVENT_COLUMNS: tuple[str, ...] = ("session_us", "timestamp_us", "sampleIndex", "eventType")
IMU_COLUMNS: tuple[str, ...] = (
    "sample_idx",
    "time_s",
    "timestamp_us",
    "accel_x_g",
    "accel_y_g",
    "accel_z_g",
    "gyro_x_dps",
    "gyro_y_dps",
    "gyro_z_dps",
    "sync_marker",
    "label_marker",
)

# Firmware enum order: 0=Mid-Swing, 1=Toe-Off, 2=Heel-Strike, 3=Mid-Stance
EVENT_TYPES: tuple[str, ...] = ("MID_SWING", "TOE_OFF", "HEEL_STRIKE", "MID_STANCE")

# edgeai_label is declared int8 with 255 meaning "no inference"; CSVs contain -1.
NO_INFERENCE_VALUES = frozenset({-1, 255})

_FILE_RE = re.compile(
    r"^(?P<kind>[SEI])_(?P<role>[LR])_(?P<session>\d{4})\.(?P<ext>csv|bin)$", re.IGNORECASE
)


class SchemaError(ValueError):
    """A file does not match the documented ArcSense format."""


@dataclass(frozen=True)
class SessionFileName:
    kind: str  # "S" | "E" | "I"
    role: str  # "L" | "R"
    session: int
    ext: str  # "csv" | "bin"


def parse_session_filename(path: str | Path) -> SessionFileName:
    """Parse ``S_L_0007.CSV`` style names. Raises :class:`SchemaError` otherwise."""
    name = Path(path).name
    m = _FILE_RE.match(name)
    if m is None:
        raise SchemaError(f"{name}: not an ArcSense session file name (expected e.g. S_L_0007.CSV)")
    return SessionFileName(
        kind=m["kind"].upper(),
        role=m["role"].upper(),
        session=int(m["session"]),
        ext=m["ext"].lower(),
    )


def _read_checked(path: str | Path, expected: tuple[str, ...]) -> pd.DataFrame:
    path = Path(path)
    try:
        df = pd.read_csv(path, skipinitialspace=True)
    except pd.errors.EmptyDataError as exc:
        raise SchemaError(f"{path.name}: file is empty") from exc
    df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in expected if c not in df.columns]
    if missing:
        raise SchemaError(f"{path.name}: missing columns {missing}; found {list(df.columns)}")
    return df


def _to_numeric(df: pd.DataFrame, cols: tuple[str, ...], path: Path) -> None:
    for col in cols:
        converted = pd.to_numeric(df[col], errors="coerce")
        bad = converted.isna() & df[col].notna()
        if bad.any():
            row = int(np.flatnonzero(bad.to_numpy())[0])
            value = df[col].iloc[row]
            raise SchemaError(
                f"{path.name}: non-numeric value {value!r} in column {col!r} (row {row})"
            )
        df[col] = converted


def read_strides(path: str | Path) -> pd.DataFrame:
    """Read ``S_<ROLE>_NNNN.CSV``. Adds ``edgeai_label_valid`` (bool)."""
    path = Path(path)
    df = _read_checked(path, STRIDE_COLUMNS)
    _to_numeric(df, STRIDE_COLUMNS, path)
    for col in ("session_us", "timestamp_us", "sampleIndex", "edgeai_label"):
        df[col] = df[col].astype("int64")
    df["edgeai_label_valid"] = ~df["edgeai_label"].isin(list(NO_INFERENCE_VALUES))
    return df[[*STRIDE_COLUMNS, "edgeai_label_valid"]].reset_index(drop=True)


def read_events(path: str | Path) -> pd.DataFrame:
    """Read ``E_<ROLE>_NNNN.CSV``.

    ``eventType`` may be the enum name or its integer code; output is always the
    name. Rows are sorted by ``sampleIndex`` (the firmware writes them in
    detection order, which is not chronological: mid-stance is confirmed late).
    """
    path = Path(path)
    df = _read_checked(path, EVENT_COLUMNS)
    _to_numeric(df, ("session_us", "timestamp_us", "sampleIndex"), path)
    for col in ("session_us", "timestamp_us", "sampleIndex"):
        df[col] = df[col].astype("int64")

    def norm(v: object) -> str:
        s = str(v).strip().upper()
        if s.isdigit():
            idx = int(s)
            if idx >= len(EVENT_TYPES):
                raise SchemaError(f"{path.name}: unknown event code {idx}")
            return EVENT_TYPES[idx]
        if s not in EVENT_TYPES:
            raise SchemaError(f"{path.name}: unknown event type {v!r}")
        return s

    df["eventType"] = df["eventType"].map(norm)
    df = df.sort_values(["sampleIndex", "timestamp_us"], kind="stable").reset_index(drop=True)
    return df[list(EVENT_COLUMNS)]


def read_imu_csv(path: str | Path) -> pd.DataFrame:
    """Read the converter output ``I_<ROLE>_NNNN.csv`` (decoded IMU samples)."""
    path = Path(path)
    df = _read_checked(path, IMU_COLUMNS)
    _to_numeric(df, IMU_COLUMNS, path)
    for col in ("sample_idx", "timestamp_us", "sync_marker", "label_marker"):
        df[col] = df[col].astype("int64")
    return df[list(IMU_COLUMNS)]
