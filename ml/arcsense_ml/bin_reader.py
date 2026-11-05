"""Reader for raw ``I_<ROLE>_NNNN.BIN`` IMU recordings.

Format (firmware spec section 1.2/1.3, verified against session 0007):

* 32-byte header: ``"ARC1"``, u32 session_id, u32 start_time_us, char role, 19 reserved.
* 20-byte little-endian records from offset 32:
  u32 sensor_time (24-bit BMI270 ticks of 39.0625 us), i16 accel[3], i16 gyro[3],
  u16 sync_marker, u16 label_marker.

Files are preallocated (10 MiB) and never truncated, so the bytes after the last
record written in this session are stale content from earlier use of the card.
End of data is the first record that violates the 24-bit timer invariant or the
monotonic timing invariant. Because the SD card is written in 512-byte sectors, the
record that straddles the last flushed sector boundary may be *torn*: its head is
real and its tail is stale (session 0007, sample 32177). See ``_is_torn``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt

HEADER_SIZE = 32
RECORD_SIZE = 20
SECTOR_SIZE = 512
MAGIC = b"ARC1"

TICK_US = 39.0625  # BMI270 sensortime resolution
TIMER_BITS = 24
TIMER_MOD = 1 << TIMER_BITS

ACCEL_G_PER_LSB = 16.0 / 32768.0  # +/-16 g
GYRO_DPS_PER_LSB = 2000.0 / 32768.0  # +/-2000 deg/s

# Largest plausible gap between consecutive records. 2 s covers SD write stalls
# while a random stale record passes both this and the 24-bit check with
# probability ~ (1/256) * (51200 / 2**24) ~ 1e-5.
MAX_GAP_TICKS = int(2_000_000 / TICK_US)

# A human shank cannot change angular rate by this much in one 2.5 ms sample
# (peak shank angular acceleration is O(10^4) deg/s^2, i.e. O(25) deg/s per
# sample). Used only to classify the single record straddling the final sector.
TORN_GYRO_JUMP_DPS = 500.0

# Largest forward step of a per-sample sequence counter we accept as "dropped
# samples" rather than evidence that the channel carries something else (10 s @ 400 Hz).
MAX_SEQUENCE_STEP = 4000

RECORD_DTYPE = np.dtype(
    [
        ("sensor_time", "<u4"),
        ("accel", "<i2", (3,)),
        ("gyro", "<i2", (3,)),
        ("sync_marker", "<u2"),
        ("label_marker", "<u2"),
    ]
)
assert RECORD_DTYPE.itemsize == RECORD_SIZE

LabelMarkerMode = Literal["zero", "sequence", "sparse"]


class BinFormatError(ValueError):
    """The file is not a valid ARC1 recording."""


@dataclass(frozen=True)
class BinHeader:
    session_id: int
    start_time_us: int
    role: str


@dataclass
class BinIntegrity:
    records_in_file: int
    valid_records: int
    torn_records: int
    data_end_offset: int
    end_reason: Literal["eof", "invalid_timer", "non_monotonic", "zero_fill"]
    timer_wraps: int
    max_gap_ticks: int
    label_marker_mode: LabelMarkerMode
    sequence_gaps: list[tuple[int, int]] = field(default_factory=list)
    """(record index, missing sample count) — only for ``label_marker_mode == "sequence"``."""

    @property
    def dropped_samples(self) -> int:
        return sum(n for _, n in self.sequence_gaps)


@dataclass
class BinRecording:
    header: BinHeader
    integrity: BinIntegrity
    sensor_time_ticks: npt.NDArray[np.uint32]
    """Raw 24-bit timer values."""
    device_time_us: npt.NDArray[np.float64]
    """Unwrapped timer in microseconds, relative to the first valid record."""
    accel_g: npt.NDArray[np.float64]
    gyro_dps: npt.NDArray[np.float64]
    accel_raw: npt.NDArray[np.int16]
    gyro_raw: npt.NDArray[np.int16]
    sync_marker: npt.NDArray[np.uint16]
    label_marker: npt.NDArray[np.uint16]

    def __len__(self) -> int:
        return int(self.sensor_time_ticks.shape[0])

    def sync_events(self) -> list[tuple[int, int]]:
        """``(sample index, token)`` for every non-zero sync marker."""
        idx = np.flatnonzero(self.sync_marker)
        return [(int(i), int(self.sync_marker[i])) for i in idx]

    def label_events(self) -> list[tuple[int, int]]:
        """``(sample index, label id)``; empty unless the label channel is sparse."""
        if self.integrity.label_marker_mode != "sparse":
            return []
        idx = np.flatnonzero(self.label_marker)
        return [(int(i), int(self.label_marker[i])) for i in idx]


def parse_header(buf: bytes) -> BinHeader:
    if len(buf) < HEADER_SIZE:
        raise BinFormatError(f"file shorter than the {HEADER_SIZE}-byte header ({len(buf)} bytes)")
    if buf[:4] != MAGIC:
        raise BinFormatError(f"bad magic {buf[:4]!r}, expected {MAGIC!r}")
    session_id = int.from_bytes(buf[4:8], "little")
    start_time_us = int.from_bytes(buf[8:12], "little")
    role_byte = buf[12]
    role = chr(role_byte)
    if role not in ("L", "R"):
        raise BinFormatError(f"bad role byte 0x{role_byte:02x}, expected 'L' or 'R'")
    return BinHeader(session_id=session_id, start_time_us=start_time_us, role=role)


def _first_invalid(times: npt.NDArray[np.uint32]) -> tuple[int, str]:
    """Index of the first record that breaks the timer invariants, and why."""
    n = times.shape[0]
    if n == 0:
        return 0, "eof"
    high = times >= TIMER_MOD
    if high[0]:
        return 0, "invalid_timer"
    deltas = (times[1:].astype(np.int64) - times[:-1].astype(np.int64)) % TIMER_MOD
    bad_delta = (deltas == 0) | (deltas > MAX_GAP_TICKS)
    bad = high[1:] | bad_delta
    hits = np.flatnonzero(bad)
    if hits.size == 0:
        return n, "eof"
    k = int(hits[0]) + 1
    return k, "invalid_timer" if high[k] else "non_monotonic"


def _is_torn(records: npt.NDArray[np.void], k: int) -> bool:
    """Whether record ``k-1`` (the last record before the first invalid one) is torn.

    It can only be torn if it straddles a sector boundary; the bytes after the
    boundary then belong to stale data. Detected by a physically impossible gyro
    jump relative to record ``k-2``.
    """
    if k < 2:
        return False
    start = HEADER_SIZE + (k - 1) * RECORD_SIZE
    end = start + RECORD_SIZE
    boundary = ((start // SECTOR_SIZE) + 1) * SECTOR_SIZE
    if not (start < boundary < end):
        return False
    prev = records["gyro"][k - 2].astype(np.float64) * GYRO_DPS_PER_LSB
    cur = records["gyro"][k - 1].astype(np.float64) * GYRO_DPS_PER_LSB
    return bool(np.max(np.abs(cur - prev)) > TORN_GYRO_JUMP_DPS)


def _label_mode(label: npt.NDArray[np.uint16]) -> tuple[LabelMarkerMode, list[tuple[int, int]]]:
    if label.size == 0 or not label.any():
        return "zero", []
    if label.size >= 2:
        steps = (label[1:].astype(np.int64) - label[:-1].astype(np.int64)) % 65536
        # A per-sample sequence counter only ever moves forward, by 1 normally and
        # by 1 + dropped samples after a stall. Sparse label IDs are mostly zero steps.
        forward = bool(np.all((steps >= 1) & (steps <= MAX_SEQUENCE_STEP)))
        if forward and np.mean(steps == 1) >= 0.9:
            gaps = [(int(i) + 1, int(steps[i]) - 1) for i in np.flatnonzero(steps != 1)]
            return "sequence", gaps
    return "sparse", []


def read_bin(path: str | Path) -> BinRecording:
    buf = Path(path).read_bytes()
    return parse_bin(buf)


def parse_bin(buf: bytes) -> BinRecording:
    header = parse_header(buf)
    n_in_file = (len(buf) - HEADER_SIZE) // RECORD_SIZE
    records = np.frombuffer(buf, dtype=RECORD_DTYPE, count=n_in_file, offset=HEADER_SIZE)

    k, reason = _first_invalid(records["sensor_time"])
    if reason != "eof":
        tail = np.frombuffer(buf, dtype=np.uint8, offset=HEADER_SIZE + k * RECORD_SIZE)
        if not tail.any():
            reason = "zero_fill"
    torn = 0
    if reason in ("invalid_timer", "non_monotonic") and _is_torn(records, k):
        torn = 1
        k -= 1

    valid = records[:k]
    times = valid["sensor_time"].astype(np.uint32)
    if k > 0:
        deltas = (times[1:].astype(np.int64) - times[:-1].astype(np.int64)) % TIMER_MOD
        wraps = int(np.sum(times[1:] < times[:-1]))
        unwrapped = np.concatenate([[0], np.cumsum(deltas)]).astype(np.float64)
        max_gap = int(deltas.max()) if deltas.size else 0
    else:
        wraps, max_gap = 0, 0
        unwrapped = np.zeros(0, dtype=np.float64)

    label = valid["label_marker"].astype(np.uint16)
    mode, gaps = _label_mode(label)

    integrity = BinIntegrity(
        records_in_file=n_in_file,
        valid_records=k,
        torn_records=torn,
        data_end_offset=HEADER_SIZE + k * RECORD_SIZE,
        end_reason=reason,  # type: ignore[arg-type]
        timer_wraps=wraps,
        max_gap_ticks=max_gap,
        label_marker_mode=mode,
        sequence_gaps=gaps,
    )
    accel_raw = valid["accel"].astype(np.int16)
    gyro_raw = valid["gyro"].astype(np.int16)
    return BinRecording(
        header=header,
        integrity=integrity,
        sensor_time_ticks=times,
        device_time_us=unwrapped * TICK_US,
        accel_g=accel_raw.astype(np.float64) * ACCEL_G_PER_LSB,
        gyro_dps=gyro_raw.astype(np.float64) * GYRO_DPS_PER_LSB,
        accel_raw=accel_raw,
        gyro_raw=gyro_raw,
        sync_marker=valid["sync_marker"].astype(np.uint16),
        label_marker=label,
    )


def build_bin(
    header: BinHeader,
    sensor_time: npt.ArrayLike,
    accel_raw: npt.ArrayLike,
    gyro_raw: npt.ArrayLike,
    sync_marker: npt.ArrayLike | None = None,
    label_marker: npt.ArrayLike | None = None,
) -> bytes:
    """Serialise records into the ARC1 format (used for tests and synthetic data)."""
    t = np.asarray(sensor_time, dtype=np.uint32)
    n = t.shape[0]
    recs = np.zeros(n, dtype=RECORD_DTYPE)
    recs["sensor_time"] = t
    recs["accel"] = np.asarray(accel_raw, dtype=np.int16).reshape(n, 3)
    recs["gyro"] = np.asarray(gyro_raw, dtype=np.int16).reshape(n, 3)
    recs["sync_marker"] = np.zeros(n, np.uint16) if sync_marker is None else sync_marker
    recs["label_marker"] = np.zeros(n, np.uint16) if label_marker is None else label_marker
    head = bytearray(HEADER_SIZE)
    head[:4] = MAGIC
    head[4:8] = header.session_id.to_bytes(4, "little")
    head[8:12] = header.start_time_us.to_bytes(4, "little")
    head[12] = ord(header.role)
    return bytes(head) + recs.tobytes()
