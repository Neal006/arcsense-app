"""Synthetic bilateral sessions for testing alignment and QA without hardware.

Models what happens in a real session: each ankle samples at 400 Hz on its own
crystal (offset and drift relative to the phone); the phone writes a token to
both ankles; each write arrives after a random BLE latency and is stamped into
the next IMU record. The output is a pair of ARC1 BIN files plus app-export
tables, i.e. exactly what the pipeline sees from the field.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .bin_reader import TICK_US, TIMER_MOD, BinHeader, build_bin

SAMPLE_US = 2500.0  # 400 Hz


@dataclass(frozen=True)
class AnkleClock:
    """device_us = (1 + drift_ppm * 1e-6) * phone_us + offset_us."""

    offset_us: float
    drift_ppm: float

    @property
    def slope(self) -> float:
        return 1.0 + self.drift_ppm * 1e-6

    def device_us(self, phone_us: np.ndarray | float) -> np.ndarray:
        return np.asarray(self.slope * np.asarray(phone_us) + self.offset_us, dtype=np.float64)


@dataclass
class SimulatedSession:
    """A recorded session. The device time read from a BIN (relative to its first
    sample) for phone session time ``p`` is ``clock.slope * (p + lead_s * 1e6)``."""

    lead_s: float
    bin_l: bytes
    bin_r: bytes
    sync_tokens: pd.DataFrame
    labels: pd.DataFrame
    clock_l: AnkleClock
    clock_r: AnkleClock


def _recording(
    side: str,
    clock: AnkleClock,
    duration_s: float,
    token_phone_us: np.ndarray,
    tokens: np.ndarray,
    rng: np.random.Generator,
    latency_ms: tuple[float, float],
    drop_tokens: set[int],
    lead_s: float,
) -> tuple[bytes, np.ndarray]:
    # the ankle starts recording `lead_s` before the phone's session clock starts
    start_dev = float(clock.device_us(-lead_s * 1e6))
    n = int((duration_s + lead_s) * 1e6 / SAMPLE_US)
    dev_t = start_dev + SAMPLE_US * np.arange(n)
    ticks = np.round(dev_t / TICK_US).astype(np.int64) % TIMER_MOD
    phase = rng.uniform(0, 2 * np.pi)
    accel = np.zeros((n, 3), dtype=np.int16)
    accel[:, 1] = 2048  # 1 g along the tibia
    gyro = np.zeros((n, 3), dtype=np.int16)
    gyro[:, 2] = (2000 * np.sin(2 * np.pi * 0.77 * dev_t / 1e6 + phase)).astype(np.int16)
    sync = np.zeros(n, dtype=np.uint16)
    dispatch = np.full(tokens.shape, np.nan)
    for i, (p_us, tok) in enumerate(zip(token_phone_us, tokens, strict=True)):
        dispatch[i] = p_us
        if int(tok) in drop_tokens:
            continue
        arrive = clock.device_us(p_us + rng.uniform(*latency_ms) * 1000.0)
        k = int(np.ceil((arrive - start_dev) / SAMPLE_US))
        if 0 <= k < n:
            sync[k] = tok
    header = BinHeader(session_id=1, start_time_us=0, role=side)
    return build_bin(header, ticks, accel, gyro, sync_marker=sync), dispatch


def simulate_session(
    *,
    duration_s: float = 600.0,
    sync_interval_s: float = 60.0,
    clock_l: AnkleClock | None = None,
    clock_r: AnkleClock | None = None,
    latency_ms: tuple[float, float] = (0.0, 15.0),
    label_times_s: tuple[float, ...] = (12.0, 250.0, 251.5, 480.0),
    label_ids: tuple[int, ...] = (1, 7, 8, 2),
    drop_tokens_l: frozenset[int] = frozenset(),
    lead_s: float = 2.0,
    seed: int = 0,
) -> SimulatedSession:
    rng = np.random.default_rng(seed)
    clock_l = clock_l or AnkleClock(offset_us=3_200_000.0, drift_ppm=18.0)
    clock_r = clock_r or AnkleClock(offset_us=7_950_000.0, drift_ppm=-12.0)
    token_s = np.arange(0.5, duration_s - 1.0, sync_interval_s)
    tokens = 0xAA01 + np.arange(token_s.size)
    phone_us = token_s * 1e6
    bin_l, disp_l = _recording(
        "L", clock_l, duration_s, phone_us, tokens, rng, latency_ms, set(drop_tokens_l), lead_s
    )
    bin_r, disp_r = _recording(
        "R", clock_r, duration_s, phone_us, tokens, rng, latency_ms, set(), lead_s
    )
    sync = pd.DataFrame(
        {
            "token": tokens,
            "session_ms": token_s * 1000.0,
            "l_status": "sent",
            "l_dispatch_session_ms": disp_l / 1000.0,
            "r_status": "sent",
            "r_dispatch_session_ms": disp_r / 1000.0,
        }
    )
    labels = pd.DataFrame(
        {"label_id": list(label_ids), "session_ms": [t * 1000.0 for t in label_times_s]}
    )
    return SimulatedSession(lead_s, bin_l, bin_r, sync, labels, clock_l, clock_r)
