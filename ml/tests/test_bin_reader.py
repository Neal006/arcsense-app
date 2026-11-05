from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from arcsense_ml.bin_reader import (
    ACCEL_G_PER_LSB,
    GYRO_DPS_PER_LSB,
    HEADER_SIZE,
    RECORD_SIZE,
    SECTOR_SIZE,
    TICK_US,
    TIMER_MOD,
    BinFormatError,
    BinHeader,
    build_bin,
    parse_bin,
    read_bin,
)
from arcsense_ml.io import read_imu_csv

HDR = BinHeader(session_id=3, start_time_us=1000, role="R")


def _synthetic(n: int, start: int = 1000, step: int = 64, **kw: object) -> bytes:
    t = (start + step * np.arange(n)) % TIMER_MOD
    rng = np.random.default_rng(0)
    accel = rng.integers(-3000, 3000, size=(n, 3))
    gyro = rng.integers(-100, 100, size=(n, 3))  # smooth enough: |jump| < 200 LSB ~ 12 dps
    return build_bin(HDR, t, accel, gyro, **kw)  # type: ignore[arg-type]


# --- session 0007 (real data) -------------------------------------------------


@pytest.fixture(scope="module")
def rec0007(ref0007: Path):  # type: ignore[no-untyped-def]
    return read_bin(ref0007 / "I_L_0007.BIN")


def test_0007_header(rec0007) -> None:  # type: ignore[no-untyped-def]
    assert rec0007.header == BinHeader(session_id=7, start_time_us=4116983, role="L")


def test_0007_end_of_data_and_torn_record(rec0007) -> None:  # type: ignore[no-untyped-def]
    integ = rec0007.integrity
    assert integ.valid_records == 32177
    assert integ.torn_records == 1
    assert integ.end_reason == "invalid_timer"
    assert integ.data_end_offset == HEADER_SIZE + 32177 * RECORD_SIZE
    # the torn record straddles the final flushed sector boundary
    assert (HEADER_SIZE + 32177 * RECORD_SIZE) < 643584 < (HEADER_SIZE + 32178 * RECORD_SIZE)
    assert 643584 % SECTOR_SIZE == 0


def test_0007_matches_converter_csv(rec0007, ref0007: Path) -> None:  # type: ignore[no-untyped-def]
    csv = read_imu_csv(ref0007 / "I_L_0007.csv")
    n = len(rec0007)
    acc_cols = ["accel_x_g", "accel_y_g", "accel_z_g"]
    gyr_cols = ["gyro_x_dps", "gyro_y_dps", "gyro_z_dps"]
    np.testing.assert_allclose(rec0007.accel_g, csv[acc_cols].to_numpy()[:n], atol=5e-5 + 1e-9)
    np.testing.assert_allclose(rec0007.gyro_dps, csv[gyr_cols].to_numpy()[:n], atol=5e-3 + 1e-9)
    # the converter kept the torn record as its final row (FINDINGS F-09)
    assert len(csv) == n + 1
    assert csv["gyro_y_dps"].iloc[-1] == pytest.approx(-1652.04)


def test_0007_timing_and_markers(rec0007) -> None:  # type: ignore[no-untyped-def]
    integ = rec0007.integrity
    assert integ.timer_wraps == 0
    assert integ.label_marker_mode == "zero"  # FINDINGS F-07
    assert rec0007.sync_events() == []
    assert rec0007.label_events() == []
    t = rec0007.device_time_us
    assert t[0] == 0.0
    assert np.all(np.diff(t) > 0)
    mean_period = t[-1] / (len(rec0007) - 1)
    assert mean_period == pytest.approx(2543, abs=5)  # ~393 Hz, FINDINGS F-10


# --- synthetic edge cases -----------------------------------------------------


def test_clean_eof() -> None:
    rec = parse_bin(_synthetic(100))
    assert len(rec) == 100
    assert rec.integrity.end_reason == "eof"
    assert rec.integrity.torn_records == 0


def test_zero_fill_end() -> None:
    buf = _synthetic(100) + bytes(RECORD_SIZE * 50)
    rec = parse_bin(buf)
    assert len(rec) == 100
    assert rec.integrity.end_reason == "zero_fill"


def test_timer_wrap_unwrapped() -> None:
    rec = parse_bin(_synthetic(200, start=TIMER_MOD - 64 * 50))
    assert rec.integrity.timer_wraps == 1
    assert len(rec) == 200
    np.testing.assert_allclose(np.diff(rec.device_time_us), 64 * TICK_US)


def test_stale_tail_detected_by_non_monotonic_time() -> None:
    good = _synthetic(100, start=500_000)
    stale = _synthetic(20, start=1000)  # earlier timestamps from a previous session
    rec = parse_bin(good + stale[HEADER_SIZE:])
    assert len(rec) == 100
    assert rec.integrity.end_reason == "non_monotonic"
    assert rec.integrity.torn_records == 0


def test_torn_record_only_when_straddling_sector() -> None:
    # choose n so record n-1 straddles a sector boundary
    n = next(
        i
        for i in range(30, 200)
        if (HEADER_SIZE + (i - 1) * RECORD_SIZE) // SECTOR_SIZE
        != (HEADER_SIZE + i * RECORD_SIZE - 1) // SECTOR_SIZE
    )
    buf = bytearray(_synthetic(n))
    boundary = ((HEADER_SIZE + (n - 1) * RECORD_SIZE) // SECTOR_SIZE + 1) * SECTOR_SIZE
    # stale bytes from the boundary onwards: huge gyro values + invalid 24-bit timer
    stale = np.full(64, 0x7F, dtype=np.uint8).tobytes()
    buf = buf[:boundary] + stale
    rec = parse_bin(bytes(buf))
    assert rec.integrity.torn_records == 1
    assert len(rec) == n - 1


def test_not_torn_when_last_record_does_not_straddle_sector() -> None:
    buf = _synthetic(60) + np.full(RECORD_SIZE * 3, 0xFF, dtype=np.uint8).tobytes()
    rec = parse_bin(buf)
    assert len(rec) == 60
    assert rec.integrity.torn_records == 0


def test_sequence_label_mode_reports_drops() -> None:
    seq = np.arange(100, dtype=np.int64)
    seq[50:] += 3  # 3 samples dropped before record 50
    rec = parse_bin(_synthetic(100, label_marker=(seq % 65536).astype(np.uint16)))
    assert rec.integrity.label_marker_mode == "sequence"
    assert rec.integrity.sequence_gaps == [(50, 3)]
    assert rec.integrity.dropped_samples == 3


def test_sparse_labels_and_sync_events() -> None:
    labels = np.zeros(100, np.uint16)
    labels[[10, 40]] = [7, 8]
    sync = np.zeros(100, np.uint16)
    sync[[5, 80]] = [0xAA01, 0xAA02]
    rec = parse_bin(_synthetic(100, label_marker=labels, sync_marker=sync))
    assert rec.integrity.label_marker_mode == "sparse"
    assert rec.label_events() == [(10, 7), (40, 8)]
    assert rec.sync_events() == [(5, 0xAA01), (80, 0xAA02)]


def test_scaling_constants() -> None:
    assert ACCEL_G_PER_LSB == 1 / 2048
    assert pytest.approx(16.384) == 1 / GYRO_DPS_PER_LSB


def test_header_only_file() -> None:
    rec = parse_bin(_synthetic(0))
    assert len(rec) == 0
    assert rec.integrity.end_reason == "eof"


@pytest.mark.parametrize(
    ("buf", "msg"),
    [
        (b"ARC1", "shorter than"),
        (b"XXXX" + bytes(28), "bad magic"),
        (b"ARC1" + bytes(8) + b"Q" + bytes(19), "bad role"),
    ],
)
def test_bad_headers(buf: bytes, msg: str) -> None:
    with pytest.raises(BinFormatError, match=msg):
        parse_bin(buf)
