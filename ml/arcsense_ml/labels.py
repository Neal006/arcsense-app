"""Ground-truth labels for strides (M05).

Label taps (phone time) are mapped to device time by align.py. Strides from
S_*.CSV carry the firmware DSP index (100 Hz), which follows device time, not
the BIN record count (FINDINGS F-14): a stride ending at DSP index n ended at
device time n * 10 ms on the BIN timeline. Each stride is then labelled with
the trial segment that contains it, and flagged if a FoG episode overlaps it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
import pandas as pd

from .shared import labels_by_id

DSP_PERIOD_US = 10_000.0  # 100 Hz DSP clock (firmware spec section 2)


@dataclass(frozen=True)
class Segment:
    start_us: float
    end_us: float
    label_id: int  # the start label's id
    training_class: str | None
    group: str
    auto_closed: bool


def stride_device_time_us(strides: pd.DataFrame) -> npt.NDArray[np.float64]:
    """Device time (BIN timeline, us) at which each stride ended."""
    return strides["sampleIndex"].to_numpy(dtype=np.float64) * DSP_PERIOD_US


def build_segments(labels: pd.DataFrame, end_of_session_us: float) -> list[Segment]:
    """Turn start/end label taps (with ``device_time_us``) into closed segments.

    Voided labels and VOID entries are ignored; an episode left open is closed at
    ``end_of_session_us``. Labels must be in tap order (``seq``).
    """
    defs = labels_by_id()
    open_: dict[int, tuple[float, bool]] = {}
    segs: list[Segment] = []
    lab = labels.sort_values("seq")
    ids = lab["label_id"].to_numpy(dtype=np.int64)
    kinds = lab["kind"].astype(str).to_numpy()
    times = lab["device_time_us"].to_numpy(dtype=np.float64)
    voided = lab["voided"].to_numpy(dtype=bool)
    auto = lab["auto_closed"].to_numpy(dtype=bool)
    for i in range(len(lab)):
        if voided[i] or kinds[i] == "void":
            continue
        d = defs.get(int(ids[i]))
        if d is None:
            continue
        t = float(times[i])
        if d.kind == "start":
            open_[d.id] = (t, False)
        elif d.kind == "end" and d.pair_id is not None and d.pair_id in open_:
            start, _ = open_.pop(d.pair_id)
            s = defs[d.pair_id]
            segs.append(Segment(start, t, s.id, s.training_class, s.group, bool(auto[i])))
    for sid, (start, _) in open_.items():
        s = defs[sid]
        segs.append(Segment(start, end_of_session_us, s.id, s.training_class, s.group, True))
    return sorted(segs, key=lambda x: x.start_us)


def label_strides(
    strides: pd.DataFrame, labels: pd.DataFrame, *, min_overlap: float = 0.5
) -> pd.DataFrame:
    """Add ``trial_class``, ``fog`` and ``label`` columns to a stride table.

    A stride (from previous heel strike to this one) belongs to a trial segment
    if at least ``min_overlap`` of it lies inside the segment; strides in no
    trial are left unlabelled (``trial_class`` NaN). ``fog`` is True if any FoG
    episode overlaps the stride. ``label`` is Freezing if ``fog``, else the
    trial class.
    """
    end = stride_device_time_us(strides)
    start = end - strides["strideTimeS"].to_numpy(dtype=np.float64) * 1e6
    session_end = float(end.max()) if end.size else 0.0
    segs = build_segments(labels, session_end)
    trial = np.full(end.size, None, dtype=object)
    fog = np.zeros(end.size, dtype=bool)
    dur = np.maximum(end - start, 1.0)
    for seg in segs:
        overlap = np.clip(np.minimum(end, seg.end_us) - np.maximum(start, seg.start_us), 0, None)
        if seg.group == "trial" and seg.training_class:
            trial[(overlap / dur) >= min_overlap] = seg.training_class
        elif seg.training_class == "Freezing":
            fog |= overlap > 0
    out = strides.copy()
    out["trial_class"] = trial
    out["fog"] = fog
    out["label"] = np.where(fog, "Freezing", trial)
    return out
