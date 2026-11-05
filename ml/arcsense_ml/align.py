"""Clock alignment between the phone and each ankle, and between the ankles (M03).

The phone writes a sync token to both ankles; each firmware stamps it into the
next IMU record of its BIN file. Matching tokens gives pairs of
(phone dispatch time, device sample time). A linear fit per ankle,
``device_us = slope * phone_us + intercept``, models the clock offset and the
crystal drift (about 20 ppm between nRF52840 boards, firmware spec section 6).
The residuals are what is left: BLE delivery latency (up to one connection
interval, FINDINGS F-06) plus the wait for the next 2.5 ms sample.

With the fit, any phone-timed event (a label tap) maps onto the device timeline
and therefore onto IMU samples and strides.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import numpy.typing as npt
import pandas as pd

from .app_export import AppExport
from .bin_reader import BinRecording

# A matched token further than this from the fit is not BLE jitter but a
# mismatch (e.g. a token typed by hand in nRF Connect) and is rejected.
DEFAULT_OUTLIER_US = 50_000.0

Side = Literal["L", "R"]


class AlignmentError(ValueError):
    """Not enough matching sync tokens to align."""


@dataclass(frozen=True)
class ClockMap:
    """``y = slope * x + intercept`` (microseconds), fitted on matched tokens."""

    slope: float
    intercept: float
    tokens_used: tuple[int, ...]
    residuals_us: npt.NDArray[np.float64]
    tokens_rejected: tuple[int, ...] = ()

    @property
    def drift_ppm(self) -> float:
        return (self.slope - 1.0) * 1e6

    @property
    def rms_residual_us(self) -> float:
        r = self.residuals_us
        return float(np.sqrt(np.mean(r**2))) if r.size else 0.0

    @property
    def max_abs_residual_us(self) -> float:
        return float(np.max(np.abs(self.residuals_us))) if self.residuals_us.size else 0.0

    def apply(self, x_us: npt.ArrayLike) -> npt.NDArray[np.float64]:
        return self.slope * np.asarray(x_us, dtype=np.float64) + self.intercept

    def inverse(self, y_us: npt.ArrayLike) -> npt.NDArray[np.float64]:
        return (np.asarray(y_us, dtype=np.float64) - self.intercept) / self.slope


def fit_clock_map(
    x_us: npt.ArrayLike,
    y_us: npt.ArrayLike,
    tokens: npt.ArrayLike,
    *,
    outlier_us: float = DEFAULT_OUTLIER_US,
) -> ClockMap:
    """Least-squares line with iterative rejection of the worst outlier.

    One token gives an offset only (slope fixed at 1); two or more give offset
    and drift. Rejection never reduces the fit below two tokens.
    """
    x = np.asarray(x_us, dtype=np.float64)
    y = np.asarray(y_us, dtype=np.float64)
    tok = np.asarray(tokens, dtype=np.int64)
    if not (x.shape == y.shape == tok.shape):
        raise ValueError("x, y and tokens must have the same length")
    if x.size == 0:
        raise AlignmentError("no matching sync tokens")
    if x.size == 1:
        return ClockMap(1.0, float(y[0] - x[0]), (int(tok[0]),), np.zeros(1))

    keep = np.ones(x.size, dtype=bool)
    while True:
        slope, intercept = np.polyfit(x[keep], y[keep], 1)
        res = y - (slope * x + intercept)
        worst = int(np.argmax(np.where(keep, np.abs(res), -1.0)))
        if abs(res[worst]) <= outlier_us or keep.sum() <= 2:
            break
        keep[worst] = False
    return ClockMap(
        slope=float(slope),
        intercept=float(intercept),
        tokens_used=tuple(int(t) for t in tok[keep]),
        residuals_us=res[keep],
        tokens_rejected=tuple(int(t) for t in tok[~keep]),
    )


def bin_tokens(rec: BinRecording) -> pd.DataFrame:
    """Sync tokens stamped in a recording: token, sample_index, device_time_us."""
    ev = rec.sync_events()
    df = pd.DataFrame(ev, columns=["sample_index", "token"])
    df["device_time_us"] = rec.device_time_us[df["sample_index"].to_numpy(dtype=np.int64)]
    return df[["token", "sample_index", "device_time_us"]]


@dataclass
class PhoneAlignment:
    side: Side
    clock: ClockMap
    matched: pd.DataFrame
    """token, phone_us, device_time_us, sample_index, residual_us (NaN if rejected)."""
    sent_not_in_bin: list[int] = field(default_factory=list)
    """Tokens the app delivered that the BIN does not contain (dropped / not stamped)."""
    in_bin_not_sent: list[int] = field(default_factory=list)
    """Tokens in the BIN the app log does not know (other session, manual writes)."""
    duplicates_in_bin: list[int] = field(default_factory=list)


def align_phone_to_device(
    export: AppExport,
    rec: BinRecording,
    side: Side,
    *,
    outlier_us: float = DEFAULT_OUTLIER_US,
) -> PhoneAlignment:
    p = side.lower()
    sent = export.sync_tokens[export.sync_tokens[f"{p}_status"] == "sent"]
    phone = pd.DataFrame(
        {
            "token": sent["token"].astype("int64").to_numpy(),
            "phone_us": sent[f"{p}_dispatch_session_ms"].to_numpy(dtype=np.float64) * 1000.0,
        }
    )
    dev = bin_tokens(rec)
    dup_mask = dev["token"].duplicated(keep=False)
    duplicates = sorted(set(dev.loc[dup_mask, "token"].astype(int)))
    dev = dev[~dup_mask]  # an ambiguous token cannot be trusted
    matched = phone.merge(dev, on="token", how="inner").sort_values("phone_us")
    clock = fit_clock_map(
        matched["phone_us"],
        matched["device_time_us"],
        matched["token"],
        outlier_us=outlier_us,
    )
    res = matched["device_time_us"].to_numpy() - clock.apply(matched["phone_us"])
    rejected = matched["token"].isin(clock.tokens_rejected).to_numpy()
    matched = matched.assign(residual_us=np.where(rejected, np.nan, res)).reset_index(drop=True)
    return PhoneAlignment(
        side=side,
        clock=clock,
        matched=matched,
        sent_not_in_bin=sorted(set(phone["token"]) - set(dev["token"]) - set(duplicates)),
        in_bin_not_sent=sorted(set(dev["token"]) - set(phone["token"])),
        duplicates_in_bin=duplicates,
    )


def align_devices(
    rec_l: BinRecording, rec_r: BinRecording, *, outlier_us: float = DEFAULT_OUTLIER_US
) -> ClockMap:
    """Map left device time to right device time using tokens present in both files."""
    left = bin_tokens(rec_l).drop_duplicates("token", keep=False)
    right = bin_tokens(rec_r).drop_duplicates("token", keep=False)
    m = left.merge(right, on="token", suffixes=("_l", "_r")).sort_values("device_time_us_l")
    return fit_clock_map(
        m["device_time_us_l"], m["device_time_us_r"], m["token"], outlier_us=outlier_us
    )


def nearest_sample(rec: BinRecording, device_time_us: npt.ArrayLike) -> npt.NDArray[np.int64]:
    """Index of the sample nearest each device time (clamped to the recording)."""
    t = rec.device_time_us
    q = np.asarray(device_time_us, dtype=np.float64)
    if t.size == 0:
        raise AlignmentError("recording has no samples")
    i = np.clip(np.searchsorted(t, q), 1, t.size - 1)
    left_closer = (q - t[i - 1]) <= (t[i] - q)
    return np.where(left_closer, i - 1, i).astype(np.int64)


def map_labels_to_device(
    export: AppExport, alignment: PhoneAlignment, rec: BinRecording
) -> pd.DataFrame:
    """Labels with the device time and IMU sample index of each tap on this ankle."""
    lab = export.labels.copy()
    dev_us = alignment.clock.apply(lab["session_ms"].to_numpy(dtype=np.float64) * 1000.0)
    lab["device_time_us"] = dev_us
    lab["sample_index"] = nearest_sample(rec, dev_us)
    lab["outside_recording"] = (dev_us < rec.device_time_us[0]) | (dev_us > rec.device_time_us[-1])
    return lab
