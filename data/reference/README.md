# Reference data

`session_0007/` is the first live trial from a healthy adult. It covers 54 strides over level ground and was recorded on the left ankle only. Tests use it as fixtures.

| File | Notes |
|---|---|
| `S_L_0007.CSV` | Firmware stride parameters (54 rows). |
| `E_L_0007.CSV` | Firmware gait events (217 rows). |
| `I_L_0007.csv` | IMU CSV produced by the firmware team's converter. Its last row is a torn record (see `docs/FINDINGS.md` F-09). |
| `I_L_0007.BIN` | **Truncated** copy of the raw SD file. It keeps the 643,584 valid bytes up to the last flushed sector, plus 4,096 bytes of the stale data that follows, so the end-of-data detection can be tested. The original file is 10 MiB, preallocated. |
| `firmware_comparison.csv` | Offline-vs-firmware comparison table, kept for reference only. |

The data identifies the subject only by session number. Do not add identifying information to this repository.
