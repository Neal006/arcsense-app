from __future__ import annotations

import numpy as np
import numpy.typing as npt
import pandas as pd
import pytest

from arcsense_ml.align import (
    AlignmentError,
    align_devices,
    align_phone_to_device,
    bin_tokens,
    fit_clock_map,
    map_labels_to_device,
    nearest_sample,
)
from arcsense_ml.app_export import AppExport
from arcsense_ml.bin_reader import parse_bin
from arcsense_ml.simulate import AnkleClock, SimulatedSession, simulate_session


def export_of(sim: SimulatedSession) -> AppExport:
    return AppExport(
        meta={},
        sync_tokens=sim.sync_tokens,
        labels=sim.labels,
        notes=pd.DataFrame(),
        connection_events=pd.DataFrame(),
    )


def true_rel_device_us(
    sim: SimulatedSession, clock: AnkleClock, phone_us: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    """Device time as read from the BIN (relative to its first sample)."""
    return clock.slope * (np.asarray(phone_us) + sim.lead_s * 1e6)


# --- fit_clock_map ---------------------------------------------------------------


def test_fit_recovers_exact_line() -> None:
    x = np.array([0.0, 1e6, 2e6, 5e6])
    m = fit_clock_map(x, 1.00002 * x + 123.0, [1, 2, 3, 4])
    assert m.drift_ppm == pytest.approx(20.0, abs=1e-6)
    assert m.intercept == pytest.approx(123.0, abs=1e-6)
    assert m.max_abs_residual_us < 1e-6
    np.testing.assert_allclose(m.inverse(m.apply(x)), x)


def test_fit_single_token_gives_offset_only() -> None:
    m = fit_clock_map([10.0], [110.0], [7])
    assert (m.slope, m.intercept, m.tokens_used) == (1.0, 100.0, (7,))
    assert m.rms_residual_us == 0.0


def test_fit_rejects_outliers_but_keeps_two() -> None:
    x = np.arange(6) * 60e6
    y = x + 5000.0
    y[3] += 900_000.0  # mismatched token
    m = fit_clock_map(x, y, np.arange(6) + 1)
    assert m.tokens_rejected == (4,)
    assert m.max_abs_residual_us < 1e-3
    m2 = fit_clock_map([0.0, 1.0], [0.0, 1e9], [1, 2])
    assert m2.tokens_rejected == ()


def test_fit_input_errors() -> None:
    with pytest.raises(AlignmentError, match="no matching"):
        fit_clock_map([], [], [])
    with pytest.raises(ValueError, match="same length"):
        fit_clock_map([1.0], [1.0, 2.0], [1])


# --- simulated sessions ---------------------------------------------------------------


@pytest.fixture(scope="module")
def sim30() -> SimulatedSession:
    return simulate_session(duration_s=1800.0, seed=1)


def test_phone_to_device_recovers_drift_and_offset(sim30: SimulatedSession) -> None:
    exp = export_of(sim30)
    for side, clock, data in (("L", sim30.clock_l, sim30.bin_l), ("R", sim30.clock_r, sim30.bin_r)):
        rec = parse_bin(data)
        a = align_phone_to_device(exp, rec, side)  # type: ignore[arg-type]
        assert len(a.clock.tokens_used) == 30
        assert a.clock.drift_ppm == pytest.approx(clock.drift_ppm, abs=10.0)
        # residuals: BLE latency (0-15 ms) + wait for next sample (0-2.5 ms), centred by the fit
        assert a.clock.max_abs_residual_us < 10_000
        assert a.sent_not_in_bin == [] and a.in_bin_not_sent == []
        # a phone instant maps onto the device timeline within the latency budget
        probe = np.array([100e6, 900e6, 1700e6])
        err = a.clock.apply(probe) - true_rel_device_us(sim30, clock, probe)
        assert np.all(err > 0) and np.all(err < 20_000)  # biased late by mean latency, bounded


def test_label_mapping_lands_on_the_right_samples(sim30: SimulatedSession) -> None:
    exp = export_of(sim30)
    rec = parse_bin(sim30.bin_l)
    lab = map_labels_to_device(exp, align_phone_to_device(exp, rec, "L"), rec)
    truth = true_rel_device_us(
        sim30,
        sim30.clock_l,
        np.asarray(lab["session_ms"].to_numpy(), dtype=np.float64) * 1000.0,
    )
    err_ms = (rec.device_time_us[lab["sample_index"].to_numpy()] - truth) / 1000
    assert np.all(np.abs(err_ms) < 20)
    assert not lab["outside_recording"].any()


def test_left_right_device_alignment(sim30: SimulatedSession) -> None:
    m = align_devices(parse_bin(sim30.bin_l), parse_bin(sim30.bin_r))
    expected_ppm = (sim30.clock_r.slope / sim30.clock_l.slope - 1) * 1e6
    assert m.drift_ppm == pytest.approx(expected_ppm, abs=15.0)
    assert m.max_abs_residual_us < 20_000


def test_dropped_and_foreign_tokens_are_reported() -> None:
    sim = simulate_session(duration_s=600.0, drop_tokens_l=frozenset({0xAA03}), seed=2)
    exp = export_of(sim)
    exp.sync_tokens = exp.sync_tokens[exp.sync_tokens["token"] != 0xAA0A].reset_index(drop=True)
    a = align_phone_to_device(exp, parse_bin(sim.bin_l), "L")
    assert a.sent_not_in_bin == [0xAA03]  # app sent it; the ankle never stamped it
    assert a.in_bin_not_sent == [0xAA0A]  # in the BIN but unknown to this app log
    assert 0xAA0A not in set(a.matched["token"])


def test_skipped_sides_are_not_used() -> None:
    sim = simulate_session(duration_s=300.0, seed=3)
    exp = export_of(sim)
    exp.sync_tokens.loc[1, "r_status"] = "skipped"
    a = align_phone_to_device(exp, parse_bin(sim.bin_r), "R")
    assert 0xAA02 not in a.clock.tokens_used
    assert a.in_bin_not_sent == [0xAA02]


def test_duplicate_tokens_in_bin_are_excluded() -> None:
    sim = simulate_session(duration_s=300.0, seed=4)
    rec = parse_bin(sim.bin_l)
    idx = bin_tokens(rec)["sample_index"].to_numpy()
    rec.sync_marker[idx[2] + 400] = rec.sync_marker[idx[1]]  # 0xAA02 stamped twice
    a = align_phone_to_device(export_of(sim), rec, "L")
    assert a.duplicates_in_bin == [0xAA02]
    assert 0xAA02 not in a.clock.tokens_used
    assert a.sent_not_in_bin == []


def test_no_common_tokens_raises() -> None:
    sim = simulate_session(duration_s=300.0, seed=5)
    exp = export_of(sim)
    exp.sync_tokens = exp.sync_tokens.assign(token=exp.sync_tokens["token"] + 1000)
    with pytest.raises(AlignmentError):
        align_phone_to_device(exp, parse_bin(sim.bin_l), "L")


def test_nearest_sample_and_outside_flag() -> None:
    sim = simulate_session(
        duration_s=120.0, label_times_s=(-60.0, 10.0, 500.0), label_ids=(10, 10, 10), seed=6
    )
    rec = parse_bin(sim.bin_l)
    t = rec.device_time_us
    assert list(nearest_sample(rec, [t[0] - 1e6, t[5] + 1, t[5] + 2499, t[-1] + 1e9])) == [
        0,
        5,
        6,
        len(rec) - 1,
    ]
    exp = export_of(sim)
    lab = map_labels_to_device(exp, align_phone_to_device(exp, rec, "L"), rec)
    assert list(lab["outside_recording"]) == [True, False, True]
