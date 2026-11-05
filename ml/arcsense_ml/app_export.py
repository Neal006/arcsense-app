"""Reader for the app's session export bundle (format ``arcsense-session-export`` v1).

The bundle is a folder (or a .zip containing one folder) with ``session.json``
and CSV files whose times are ``session_ms``: milliseconds since the session
started (see app/src/export/sessionExport.ts). The golden fixture in
``shared/fixtures/app_export_v1`` is produced by the app's test-suite and parsed
here, so both sides are tested against the same bytes.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from .io import SchemaError

EXPORT_FORMAT = "arcsense-session-export"
SUPPORTED_VERSIONS = frozenset({1})

_SIDE = ("status", "dispatch_session_ms", "write_mode", "error")
SYNC_COLUMNS = (
    "seq",
    "run",
    "token",
    "token_hex",
    "reason",
    "session_ms",
    "wall_iso",
    *(f"l_{c}" for c in _SIDE),
    *(f"r_{c}" for c in _SIDE),
    "js_dispatch_skew_ms",
    "partial",
)
LABEL_COLUMNS = (
    "seq",
    "run",
    "label_id",
    "key",
    "name",
    "kind",
    "group",
    "session_ms",
    "wall_iso",
    *(f"l_{c}" for c in _SIDE),
    *(f"r_{c}" for c in _SIDE),
    "delivered",
    "voided",
    "voids_seq",
    "auto_closed",
)
NOTE_COLUMNS = ("seq", "run", "session_ms", "wall_iso", "text")
EVENT_COLUMNS = ("idx", "run", "session_ms", "wall_iso", "type", "side", "device_id", "detail")


@dataclass
class AppExport:
    meta: dict[str, Any]
    sync_tokens: pd.DataFrame
    labels: pd.DataFrame
    notes: pd.DataFrame
    connection_events: pd.DataFrame

    @property
    def session(self) -> dict[str, Any]:
        s: dict[str, Any] = self.meta["session"]
        return s

    @property
    def session_id(self) -> str:
        return str(self.session["id"])


def _read_csv(text: str, name: str, expected: tuple[str, ...]) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), keep_default_na=False, na_values=[""], dtype=str)
    missing = [c for c in expected if c not in df.columns]
    if missing:
        raise SchemaError(f"{name}: missing columns {missing}")
    return df


def _ints(df: pd.DataFrame, cols: tuple[str, ...]) -> None:
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="raise").astype("Int64")


def _floats(df: pd.DataFrame, cols: tuple[str, ...]) -> None:
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="raise").astype("float64")


def _bools(df: pd.DataFrame, cols: tuple[str, ...]) -> None:
    for c in cols:
        bad = ~df[c].isin(["0", "1"])
        if bad.any():
            raise SchemaError(f"column {c!r}: expected 0/1, got {df[c][bad].iloc[0]!r}")
        df[c] = df[c] == "1"


def _load_files(path: Path) -> dict[str, str]:
    names = ("session.json", "sync_tokens.csv", "labels.csv", "notes.csv", "connection_events.csv")
    if path.is_dir():
        missing = [n for n in names if not (path / n).is_file()]
        if missing:
            raise SchemaError(f"{path}: export folder is missing {missing}")
        return {n: (path / n).read_text(encoding="utf-8") for n in names}
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            by_base: dict[str, str] = {}
            for info in zf.infolist():
                base = info.filename.rsplit("/", 1)[-1]
                if base in names:
                    if base in by_base:
                        raise SchemaError(f"{path.name}: more than one {base} in archive")
                    by_base[base] = zf.read(info).decode("utf-8")
        missing = [n for n in names if n not in by_base]
        if missing:
            raise SchemaError(f"{path.name}: archive is missing {missing}")
        return by_base
    raise SchemaError(f"{path}: expected an export folder or .zip")


def read_app_export(path: str | Path) -> AppExport:
    files = _load_files(Path(path))
    meta = json.loads(files["session.json"])
    if meta.get("format") != EXPORT_FORMAT:
        raise SchemaError(f"session.json: not an {EXPORT_FORMAT} file")
    if meta.get("version") not in SUPPORTED_VERSIONS:
        raise SchemaError(f"session.json: unsupported export version {meta.get('version')!r}")

    sync = _read_csv(files["sync_tokens.csv"], "sync_tokens.csv", SYNC_COLUMNS)
    _ints(sync, ("seq", "run", "token"))
    _floats(
        sync,
        ("session_ms", "l_dispatch_session_ms", "r_dispatch_session_ms", "js_dispatch_skew_ms"),
    )
    _bools(sync, ("partial",))

    labels = _read_csv(files["labels.csv"], "labels.csv", LABEL_COLUMNS)
    _ints(labels, ("seq", "run", "label_id", "voids_seq"))
    _floats(labels, ("session_ms", "l_dispatch_session_ms", "r_dispatch_session_ms"))
    _bools(labels, ("delivered", "voided", "auto_closed"))

    notes = _read_csv(files["notes.csv"], "notes.csv", NOTE_COLUMNS)
    _ints(notes, ("seq", "run"))
    _floats(notes, ("session_ms",))

    events = _read_csv(files["connection_events.csv"], "connection_events.csv", EVENT_COLUMNS)
    _ints(events, ("idx", "run"))
    _floats(events, ("session_ms",))

    counts = meta.get("counts", {})
    for key, df in (("syncTokens", sync), ("labels", labels), ("notes", notes)):
        if key in counts and counts[key] != len(df):
            raise SchemaError(f"session.json says {counts[key]} {key}, CSV has {len(df)}")
    return AppExport(
        meta=meta, sync_tokens=sync, labels=labels, notes=notes, connection_events=events
    )
