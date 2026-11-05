from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from arcsense_ml.bin_reader import read_bin
from arcsense_ml.features import feature_matrix, stride_features
from arcsense_ml.io import read_events, read_strides
from arcsense_ml.labels import DSP_PERIOD_US, build_segments, label_strides, stride_device_time_us
from arcsense_ml.shared import REPO_ROOT, feature_names, feature_spec_hash

FEATURES_GOLDEN = REPO_ROOT / "shared" / "fixtures" / "features_0007.json"


# --- features --------------------------------------------------------------------------


def test_features_0007_shape_order_and_values(ref0007: Path) -> None:
    s = read_strides(ref0007 / "S_L_0007.CSV")
    feats, valid = stride_features(s)
    assert list(feats.columns) == feature_names()
    assert valid.sum() == 53 and not valid[0]  # first stride has no length yet (F-04)
    r = feats.iloc[1]
    assert r["cadenceSpm"] == pytest.approx(120 / r["strideTimeS"])
    assert r["swingRatio"] + r["stanceRatio"] == pytest.approx(1.0, abs=0.01)
    assert feats["cadenceSpm"][valid].mean() == pytest.approx(91.95, abs=0.5)  # report value


def test_features_mask_non_physical_rows() -> None:
    df = pd.DataFrame(
        {
            "strideTimeS": [1.2, 0.0, 9.0, 1.1, np.nan],
            "swingTimeS": [0.45, 0.4, 3, 0.4, 0.4],
            "stanceTimeS": [0.75, 0.6, 6, 0.7, 0.7],
            "strideLengthM": [1.0, 1.0, 1.0, 1.0, 1.0],
            "tibialShockG": [3, 3, 3, 3, 3],
            "asymmetryIndex": [0.02] * 5,
            "freezeIndex": [0.5, 0.5, 0.5, np.inf, 0.5],
        }
    )
    X, valid = feature_matrix(df)
    assert X.dtype == np.float32 and X.shape == (5, 10)
    assert list(valid) == [True, False, False, False, False]


def test_features_golden_fixture_for_app_parity(ref0007: Path) -> None:
    s = read_strides(ref0007 / "S_L_0007.CSV")
    feats, valid = stride_features(s)
    payload = {
        "featureSpecHash": feature_spec_hash(),
        "features": feature_names(),
        "valid": [bool(v) for v in valid],
        "rows": [[round(float(x), 9) for x in row] for row in feats.to_numpy()[valid]],
    }
    if os.environ.get("UPDATE_GOLDEN") == "1":
        FEATURES_GOLDEN.write_text(json.dumps(payload, indent=1) + "\n")
    assert json.loads(FEATURES_GOLDEN.read_text()) == payload


# --- DSP timeline (FINDINGS F-14) ------------------------------------------------------


def test_dsp_index_follows_device_time_not_record_count(ref0007: Path) -> None:
    rec = read_bin(ref0007 / "I_L_0007.BIN")
    ev = read_events(ref0007 / "E_L_0007.CSV")
    gz = -rec.gyro_dps[:, 2]  # sagittal angular rate, firmware sign convention
    t = rec.device_time_us
    offs_ms = []
    for n in ev.loc[ev["eventType"] == "MID_SWING", "sampleIndex"].iloc[1:]:
        c = int(np.searchsorted(t, n * DSP_PERIOD_US))
        lo, hi = max(c - 60, 0), min(c + 60, t.size)
        peak = lo + int(np.argmax(gz[lo:hi]))
        offs_ms.append((t[peak] - n * DSP_PERIOD_US) / 1000)
    offs = np.abs(np.array(offs_ms))
    assert np.median(offs) < 5.0
    # mapping by record count would be off by > 0.5 s after the logging gaps
    n_last = int(ev["sampleIndex"].iloc[-1])
    assert abs(t[min(4 * n_last, t.size - 1)] - n_last * DSP_PERIOD_US) > 500_000


# --- labels ----------------------------------------------------------------------------


def _labels(rows: list[tuple[int, int, str, float, bool, bool]]) -> pd.DataFrame:
    return pd.DataFrame(
        rows, columns=["seq", "label_id", "kind", "device_time_us", "voided", "auto_closed"]
    )


def test_build_segments_handles_voids_and_open_episodes() -> None:
    lab = _labels(
        [
            (0, 1, "start", 1e6, False, False),
            (1, 7, "start", 2e6, False, False),
            (2, 8, "end", 3e6, True, False),  # voided end
            (3, 99, "void", 3.1e6, False, False),
            (4, 2, "end", 9e6, False, False),
        ]
    )
    segs = build_segments(lab, end_of_session_us=20e6)
    assert [(s.label_id, s.start_us, s.end_us, s.auto_closed) for s in segs] == [
        (1, 1e6, 9e6, False),
        (7, 2e6, 20e6, True),  # FoG never validly closed -> closed at session end
    ]


def test_label_strides_assigns_trial_and_fog() -> None:
    strides = pd.DataFrame(
        {"sampleIndex": [200, 330, 460, 590, 720, 850], "strideTimeS": [1.3] * 6}
    )
    t = stride_device_time_us(strides)
    lab = _labels(
        [
            # shuffling starts 0.2 s before stride 0 ends: only 15% of that stride is
            # inside the trial, so stride 0 stays unlabelled; strides 1-3 are inside
            (0, 3, "start", t[0] - 0.2e6, False, False),
            (1, 7, "start", t[2] - 0.1e6, False, False),  # FoG overlaps stride 2 and 3
            (2, 8, "end", t[2] + 0.2e6, False, False),
            (3, 4, "end", t[3], False, False),
        ]
    )
    out = label_strides(strides, lab)
    assert list(out["trial_class"]) == [None, "Shuffling", "Shuffling", "Shuffling", None, None]
    assert list(out["fog"]) == [False, False, True, True, False, False]
    assert list(out["label"]) == [None, "Shuffling", "Freezing", "Freezing", None, None]


def test_label_strides_requires_majority_overlap() -> None:
    strides = pd.DataFrame({"sampleIndex": [100, 200], "strideTimeS": [1.0, 1.0]})
    lab = _labels([(0, 1, "start", 0.7e6, False, False), (1, 2, "end", 5e6, False, False)])
    out = label_strides(strides, lab)
    # stride 0 spans 0..1.0 s, only 30% inside the trial; stride 1 spans 1.0..2.0 s
    assert list(out["trial_class"]) == [None, "Normal"]
