"""Session quality report (M04): run on every session as soon as the SD cards
and the app export are copied off, before anything is trained on it."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

from .align import AlignmentError, align_devices, align_phone_to_device, map_labels_to_device
from .app_export import AppExport, read_app_export
from .bin_reader import TICK_US, BinRecording, read_bin
from .io import parse_session_filename, read_strides

Level = Literal["pass", "info", "warn", "fail"]
_ORDER: dict[Level, int] = {"pass": 0, "info": 1, "warn": 2, "fail": 3}

NOMINAL_HZ = 400.0
MAX_GAP_MS = 50.0
MAX_RESIDUAL_MS = 25.0
MAX_DRIFT_PPM = 100.0
FOG_FI_THRESHOLD = 3.0


@dataclass(frozen=True)
class QaItem:
    level: Level
    area: str
    check: str
    detail: str


@dataclass
class SessionInputs:
    bins: dict[str, Path] = field(default_factory=dict)
    strides: dict[str, Path] = field(default_factory=dict)
    export: Path | None = None


@dataclass
class QaReport:
    items: list[QaItem]

    @property
    def status(self) -> Level:
        """Worst of pass/warn/fail; "info" items never change the verdict."""
        worst: Level = "pass"
        for it in self.items:
            if it.level != "info" and _ORDER[it.level] > _ORDER[worst]:
                worst = it.level
        return worst

    def to_markdown(self, title: str = "Session QA") -> str:
        icon = {"pass": "PASS", "info": "info", "warn": "WARN", "fail": "FAIL"}
        lines = [f"# {title}", "", f"**Overall: {icon[self.status]}**", ""]
        lines += ["| Level | Area | Check | Detail |", "|---|---|---|---|"]
        for it in self.items:
            detail = it.detail.replace("|", "\\|")
            lines.append(f"| {icon[it.level]} | {it.area} | {it.check} | {detail} |")
        return "\n".join(lines) + "\n"


def discover(folder: str | Path) -> SessionInputs:
    """Find I_*.BIN, S_*.CSV and an app export (folder with session.json, or .zip)."""
    folder = Path(folder)
    inp = SessionInputs()
    for p in sorted(folder.iterdir()):
        try:
            f = parse_session_filename(p.name)
        except ValueError:
            f = None
        if f and f.kind == "I" and f.ext == "bin":
            inp.bins[f.role] = p
        elif f and f.kind == "S" and f.ext == "csv":
            inp.strides[f.role] = p
        elif (p.is_dir() and (p / "session.json").is_file()) or (
            p.suffix.lower() == ".zip" and inp.export is None
        ):
            inp.export = p
    if (folder / "session.json").is_file():
        inp.export = folder
    return inp


def _bin_checks(side: str, rec: BinRecording, items: list[QaItem]) -> None:
    area = f"BIN {side}"
    integ = rec.integrity
    n = len(rec)
    if n < 2:
        items.append(QaItem("fail", area, "samples", f"only {n} valid samples"))
        return
    dur_s = rec.device_time_us[-1] / 1e6
    rate = (n - 1) / dur_s
    items.append(QaItem("pass", area, "samples", f"{n} samples, {dur_s:.1f} s"))
    lvl: Level = "pass" if abs(rate - NOMINAL_HZ) / NOMINAL_HZ < 0.05 else "warn"
    items.append(QaItem(lvl, area, "sample rate", f"{rate:.1f} Hz (nominal {NOMINAL_HZ:.0f})"))
    gap_ms = integ.max_gap_ticks * TICK_US / 1000
    lvl = "pass" if gap_ms <= MAX_GAP_MS else "warn"
    items.append(QaItem(lvl, area, "largest gap", f"{gap_ms:.1f} ms"))
    if integ.torn_records:
        items.append(
            QaItem("warn", area, "torn record", "last record straddles an unflushed SD sector")
        )
    if integ.label_marker_mode == "sequence" and integ.dropped_samples:
        items.append(
            QaItem("warn", area, "dropped samples", f"{integ.dropped_samples} missing by sequence")
        )
    items.append(QaItem("info", area, "label channel", integ.label_marker_mode))
    tokens = len(rec.sync_events())
    items.append(
        QaItem("pass" if tokens else "fail", area, "sync tokens in file", f"{tokens} stamped")
    )


def _align_checks(exp: AppExport, side: str, rec: BinRecording, items: list[QaItem]) -> None:
    area = f"Sync {side}"
    try:
        a = align_phone_to_device(exp, rec, side)  # type: ignore[arg-type]
    except AlignmentError as e:
        items.append(QaItem("fail", area, "phone->ankle alignment", str(e)))
        return
    used = len(a.clock.tokens_used)
    items.append(
        QaItem(
            "pass" if used >= 2 else "warn",
            area,
            "tokens matched",
            f"{used} (offset only)" if used == 1 else f"{used}",
        )
    )
    res_ms = a.clock.max_abs_residual_us / 1000
    items.append(
        QaItem(
            "pass" if res_ms <= MAX_RESIDUAL_MS else "warn",
            area,
            "max residual",
            f"{res_ms:.1f} ms (rms {a.clock.rms_residual_us / 1000:.1f} ms)",
        )
    )
    drift = a.clock.drift_ppm
    items.append(
        QaItem(
            "pass" if abs(drift) <= MAX_DRIFT_PPM else "warn", area, "drift", f"{drift:+.1f} ppm"
        )
    )
    for name, toks in (
        ("sent but not stamped", a.sent_not_in_bin),
        ("stamped but not in app log", a.in_bin_not_sent),
        ("duplicated in BIN", a.duplicates_in_bin),
        ("rejected as outliers", list(a.clock.tokens_rejected)),
    ):
        if toks:
            items.append(QaItem("warn", area, name, ", ".join(f"0x{t:04X}" for t in toks)))
    lab = map_labels_to_device(exp, a, rec)
    outside = lab[lab["outside_recording"] & ~lab["voided"].astype(bool)]
    if len(outside):
        items.append(
            QaItem("warn", area, "labels outside recording", ", ".join(outside["key"].astype(str)))
        )


def _label_checks(exp: AppExport, items: list[QaItem]) -> None:
    lab = exp.labels
    real = lab[(lab["kind"] != "void") & ~lab["voided"]]
    items.append(QaItem("pass" if len(real) else "warn", "Labels", "labels", f"{len(real)} valid"))
    if lab["voided"].any():
        items.append(QaItem("info", "Labels", "voided", f"{int(lab['voided'].sum())}"))
    if lab["auto_closed"].any():
        keys = ", ".join(lab.loc[lab["auto_closed"], "name"].astype(str))
        items.append(QaItem("warn", "Labels", "auto-closed at stop", keys))
    undelivered = real[~real["delivered"]]
    if len(undelivered):
        items.append(
            QaItem(
                "info",
                "Labels",
                "not written to both ankles",
                f"{len(undelivered)} (phone log used)",
            )
        )


def _stride_checks(side: str, path: Path, items: list[QaItem]) -> None:
    df = read_strides(path)
    area = f"Strides {side}"
    items.append(QaItem("pass" if len(df) else "warn", area, "strides", f"{len(df)}"))
    if len(df):
        fi = df["freezeIndex"].to_numpy()
        items.append(
            QaItem(
                "info",
                area,
                "freeze index",
                f"median {np.median(fi):.2f}, max {fi.max():.2f}, "
                f"{np.mean(fi >= FOG_FI_THRESHOLD) * 100:.0f}% >= {FOG_FI_THRESHOLD}",
            )
        )


def qa_session(inputs: SessionInputs) -> QaReport:
    items: list[QaItem] = []
    recs = {side: read_bin(p) for side, p in sorted(inputs.bins.items())}
    if not recs:
        items.append(QaItem("fail", "Files", "IMU recordings", "no I_*.BIN found"))
    if len(recs) == 1:
        items.append(QaItem("info", "Files", "sides", f"single side ({next(iter(recs))})"))
    for side, rec in recs.items():
        if rec.header.role != side:
            items.append(
                QaItem(
                    "fail",
                    f"BIN {side}",
                    "role",
                    f"file name says {side}, header {rec.header.role}",
                )
            )
        _bin_checks(side, rec, items)

    exp = read_app_export(inputs.export) if inputs.export else None
    if exp is None:
        items.append(
            QaItem("warn", "Files", "app export", "not found: no labels, no phone alignment")
        )
    else:
        _label_checks(exp, items)
        for side, rec in recs.items():
            _align_checks(exp, side, rec, items)
    if "L" in recs and "R" in recs:
        try:
            m = align_devices(recs["L"], recs["R"])
            items.append(
                QaItem(
                    "pass" if m.max_abs_residual_us / 1000 <= MAX_RESIDUAL_MS else "warn",
                    "Sync L-R",
                    "ankle alignment",
                    f"{len(m.tokens_used)} tokens, drift {m.drift_ppm:+.1f} ppm, "
                    f"max residual {m.max_abs_residual_us / 1000:.1f} ms",
                )
            )
        except AlignmentError as e:
            items.append(QaItem("fail", "Sync L-R", "ankle alignment", str(e)))
    for side, path in sorted(inputs.strides.items()):
        _stride_checks(side, path, items)
    return QaReport(items)


def bin_to_frame(rec: BinRecording) -> pd.DataFrame:
    """Decoded samples (valid records only) in the converter's CSV layout plus device time."""
    return pd.DataFrame(
        {
            "sample_idx": np.arange(len(rec)),
            "device_time_us": np.round(rec.device_time_us, 3),
            "sensor_time_ticks": rec.sensor_time_ticks,
            "accel_x_g": rec.accel_g[:, 0],
            "accel_y_g": rec.accel_g[:, 1],
            "accel_z_g": rec.accel_g[:, 2],
            "gyro_x_dps": rec.gyro_dps[:, 0],
            "gyro_y_dps": rec.gyro_dps[:, 1],
            "gyro_z_dps": rec.gyro_dps[:, 2],
            "sync_marker": rec.sync_marker,
            "label_marker": rec.label_marker,
        }
    )
