# ARC SENSE — Software Implementation Plan (React Native)

**Status:** v2 — awaiting go-ahead
**Date:** 2026-11-05
**Framework:** React Native, using Expo with a custom dev client and TypeScript
**Scope:** the mobile app, the BLE client, the EdgeML pipeline that produces `model_data.h`, and testing for all of it. Firmware is out of scope.

---

## 0. Ground rules this plan is built on

1. **The data comes before the brief.** Where the brief and the session 0007 data disagree, the data wins and the number becomes a setting the user can change (see §0.1).
2. **A data-collection build comes first.** Collection starts after Diwali. A recording is only useful for training if sync tokens and ground-truth labels are captured during the session itself. So connecting, syncing and labelling ship before the dashboard.
3. **All logic is plain TypeScript with nothing injected from outside.** BLE transport, clock, storage and timers are all passed in. That way every behaviour can be tested in Jest without a phone or a radio.
4. **There is one source of truth for shared contracts.** `shared/` holds the GATT map, the label catalogue and the feature specification. The app and the Python code are both generated from it or checked against it, and tests fail if either drifts.
5. **No feature is done without tests.** Every functionality ID (F-xx or M-xx) maps to at least one automated test in §6.4, unless it can only be tested on hardware. Those are listed in §6.6.

### 0.1 Issues found in the brief and data (carried over from v1, still open)

| ID | Issue | Handling in the app |
|---|---|---|
| D1 | The Freeze Index (FI) in healthy walking (0007) averages 1.91 and peaks at 4.11. 24 of 54 strides are at or above 2.0, so the brief's threshold of 2.0 would trigger false alarms. | The threshold is a setting with a default of **3.0**. An alert needs **N consecutive strides** over it (default N = 2). |
| D2 | `asymmetryIndex` is stored as a fraction (0–1). | It is shown as a percentage (×100). |
| D3 | The firmware asymmetry is computed on one device, so it is a proxy. | The app also computes a **true L/R asymmetry**. The ML model keeps using the **firmware** value so its features match what the firmware sees (see §4.3). |
| D4 | The brief's baseline ranges are wrong. | Display norms come from 0007 data and are stored in `norms.ts`. |
| D5 | The AI label is declared `int8`, but 255 is used to mean "no inference". | Both `0xFF` and `-1` are treated as no inference. |
| D6 | A sync skew under 2 ms between two BLE links is not reachable from a phone. | Each write's time is logged and the skew is measured. Alignment uses the tokens in the BIN files. |
| D7 | There is no start/stop SD session command. | Start writes the Session Start Timestamp `0x000C`. **The firmware owner needs to confirm what that write does.** |
| D8 | In DataCollection mode, characteristics are not notified. | The app reads the mode and adapts: it polls or simply logs. |
| D9 | The arrival order of the 8 per-stride notifications is not defined. | The Stride Assembler handles any order. |
| D10 | There is no pathological training data yet. | Pipeline tests use synthetic data only. Real training happens after collection. |

---

## 1. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| App shell | **Expo** (latest stable SDK at P0, pinned), `expo-dev-client`, prebuild | BLE needs native code, so Expo Go won't work. A dev client will. |
| Language | TypeScript in strict mode | — |
| BLE | `react-native-ble-plx` with its Expo config plugin | MIT licence, mature. |
| Navigation | Expo Router | File-based routes. |
| State | Zustand | Lightweight and works well with streaming data. Services push into stores. |
| Database | `expo-sqlite` + `drizzle-orm` with migrations | Tests run the same schema on `better-sqlite3` under Node. |
| Charts | `victory-native` (Skia) | The brief mentions Victory, and Skia keeps charts smooth. |
| On-phone ML | `react-native-fast-tflite`, loading the same `.tflite` file | A pure-TypeScript MLP reference is also built. It is used in Jest and as a fallback. |
| Export | `expo-file-system`, `expo-print` (HTML to PDF), `expo-sharing` | CSV files, a zip bundle and a PDF. |
| Feedback | `expo-haptics`, `expo-audio`, `expo-keep-awake` | For the FoG alert and for keeping the screen on during a session. |
| Background | Android foreground service via `@notifee/react-native`; iOS `bluetooth-central` background mode | Keeps the 60 s sync running when the screen locks. |
| Builds | Android built locally (JDK 17 + Android SDK); **iOS via EAS Build in the cloud** | No Mac is needed. Installing on an iPhone requires an Apple Developer account. |
| ML | Python 3.11 venv managed by `uv`: TensorFlow, scikit-learn, pandas, numpy, pytest | The system Python is 3.14, which TensorFlow doesn't support yet. |
| Quality | ESLint, Prettier, `tsc --noEmit`, ruff, mypy | — |
| Tests | Jest (`jest-expo`), React Native Testing Library, Maestro (E2E), pytest, gcc (header compile check) | See §6. |

---

## 2. Repository layout

```
idealab/
├── analysis_007/                    read-only reference data
├── shared/
│   ├── gatt_spec.json               UUIDs, types, byte sizes, notify/read/write flags
│   ├── label_catalog.json           label IDs ↔ names, kind (instant | start/end pair), colour
│   └── feature_spec.json            ordered 10 features + class names + FI override rule
├── app/                             React Native (Expo)
│   ├── app/                         Expo Router screens
│   │   ├── _layout.tsx              tabs + global alert banner + connection badges
│   │   ├── index.tsx                Scanner / Connect
│   │   ├── session.tsx              Session Control + Label annotator
│   │   ├── dashboard.tsx            Live dashboard
│   │   ├── bilateral.tsx            L vs R
│   │   ├── ai.tsx                   EdgeAI results
│   │   ├── history/[id].tsx         Session history + detail
│   │   ├── settings.tsx
│   │   └── debug.tsx                GATT inspector + event log
│   ├── src/
│   │   ├── shared/                  generated from /shared (gatt.ts, labels.ts, features.ts)
│   │   ├── ble/                     codec.ts, transport.ts (interface), PlxTransport.ts,
│   │   │                            MockTransport.ts, permissions.ts
│   │   ├── core/                    clock.ts, logger.ts, types.ts, norms.ts
│   │   ├── services/                DeviceManager, StrideAssembler, BilateralAnalyzer,
│   │   │                            SessionStats, SyncService, LabelService, SessionRecorder,
│   │   │                            AlertEngine, ForegroundSession, RecoveryService
│   │   ├── ml/                      features.ts, MlpReference.ts, TfliteBackend.ts, GaitClassifier.ts
│   │   ├── db/                      schema.ts, migrations/, repositories/
│   │   ├── export/                  csv.ts, pdfTemplate.ts, bundle.ts
│   │   ├── store/                   connection, live, session, alerts, settings slices
│   │   └── ui/                      MetricBar, SideBadge, AlertBanner, StrideChart,
│   │                                ClassTimeline, LabelButton, RssiBars, StatTile
│   ├── assets/                      replay/S_L_0007.csv, model/model.tflite, model/model_meta.json
│   ├── __tests__/                   unit / component / integration
│   ├── e2e/                         Maestro flows (*.yaml)
│   └── scripts/gen-shared.ts        codegen from /shared (CI checks it's up to date)
├── ml/
│   ├── arcsense_ml/                 io.py, bin_reader.py, align.py, features.py, labels.py,
│   │                                dataset.py, synth.py, train.py, export.py, qa.py, classifier.py
│   ├── scripts/                     parse_strides.py, qa_session.py, align_bilateral.py,
│   │                                build_dataset.py, train_classifier.py, export_model.py
│   ├── tests/                       pytest (+ fixtures from analysis_007)
│   └── pyproject.toml
├── tools/ble_emulator/              optional: Python `bless` peripheral that acts as ArcSense-L/R
├── Makefile                         `make verify` runs every check (§6.7)
└── ARC_SENSE_SOFTWARE_PLAN.md
```

---

## 3. App functionality — complete list

Each item has an ID, a behaviour and an acceptance criterion. The **Phase** column refers to §5.

### A. Platform and permissions
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F01 | Request BLE permissions: `BLUETOOTH_SCAN`/`CONNECT` on Android 12+, location on Android 11 and below, `NSBluetoothAlwaysUsageDescription` on iOS. | If permission is denied, the app explains why and offers an "Open Settings" link. Scanning never starts without permission. | P1 |
| F02 | Detect Bluetooth on/off state. | If Bluetooth is off, the app shows a blocking prompt (on Android, a request to enable it) and resumes automatically when it is turned on. | P1 |
| F03 | Keep the screen awake during a session and run an Android foreground service with an ongoing notification ("Session running: 00:12:31"). | Sync ticks keep firing for 10 minutes with the screen locked (hardware test HT-07). | P1 |

### B. Scanning and connection
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F04 | Scan filtered by service UUID `19B10000-…`. Show ArcSense-L and ArcSense-R with live RSSI. Scanning times out after 15 s, with a rescan button. | Devices that don't advertise the service are hidden. RSSI updates at least once per second. | P1 |
| F05 | Determine the side from the name, then **confirm it by reading Device Role `0x0009`** (76 = L, 82 = R). | If the name and role disagree, the app shows a warning and the role wins. | P1 |
| F06 | "Connect both" and individual connect buttons. Request MTU 185 and Android high connection priority. | Both devices connect at the same time, and the state shows in the side badges. | P1 |
| F07 | Run service discovery and a **GATT validation report**: check every characteristic in `gatt_spec.json` exists with the expected properties. | Missing or extra characteristics appear in the report and in Debug. The app keeps working with whatever subset exists. | P1 |
| F08 | Read BLE Mode `0x000A` and choose the acquisition strategy: subscribe in Streaming or EdgeAI mode, poll or log in DataCollection mode. | The mode badge is visible, and the strategy switches correctly for all 3 modes. | P1 |
| F09 | Connection state machine per side: idle, scanning, connecting, discovering, ready, reconnecting, lost. **Auto-reconnect** uses exponential backoff (1, 2, 4, 8, max 15 s) and re-subscribes after reconnecting. | After a device is power-cycled, it is back in the ready state with subscriptions restored and no user action. | P1 |
| F10 | Remember the last-used device IDs and offer a quick reconnect. | One tap connects the previous pair. | P1 |
| F11 | Manual disconnect and "Forget device". | — | P1 |
| F12 | Log every connection event (connect, disconnect, reason, RSSI) to the active session. | Events appear in the export. | P1 |

### C. Data acquisition and processing
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F13 | Subscribe to notifications for all gait characteristics (`0x0001`–`0x0007`, `0x0013`) and the AI characteristics (`0x000E`, `0x000F`). | — | P2 |
| F14 | Polling mode for DataCollection firmware: read the stride count at 1 Hz and read all values when it changes. It can be switched off to save battery. | — | P2 |
| F15 | **Codec**: decode little-endian float32, uint32, uint16 and uint8/int8 from base64, and encode write payloads. If a value has the wrong length, it is logged and dropped without crashing. | 100% branch coverage. | P1 |
| F16 | **Stride Assembler** (one per side): gathers values that share a stride count. It commits on a count change or 300 ms after the first value, flags fields that are missing or stale, and counts dropped strides from gaps in the count. | Any arrival order gives the same stride. A gap of k strides increments `missedStrides` by k. | P2 |
| F17 | Derived metrics: cadence = 60 / strideTime × 2 steps (shown as steps per minute; the formula will be confirmed against the report's 91.95), swing %, stance %. The first stride's `strideLength == 0` is treated as not available. | Matches the 0007 report statistics within ±0.5%. | P2 |
| F18 | **Bilateral Analyzer**: pairs each L stride with the nearest R stride in phone time (window ±0.8 s) and computes true asymmetry for stride time, swing, stance and length. | Tested with synthetic offset streams. | P2 |
| F19 | **Running session statistics** per side and metric: mean, SD and CV (Welford's algorithm), min and max. | Matches the report's 1.305 s mean and 2.90% CV on the 0007 replay. | P2 |
| F20 | A "data age" indicator per side, marked stale if there has been no stride for more than 3 s. | — | P2 |

### D. Session and sync (the phone as timing master)
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F21 | **New Session form**: subject ID (pseudonymous code only, no names), condition or trial type, operator, side configuration (L, R or both), notes. Firmware mode and device IDs are captured automatically. | A session can't start without a subject ID. | P1 |
| F22 | **Start**: write Session Start Timestamp `0x000C` (uint32, the phone's monotonic ms; D7) to both devices, then **sync token `0xAA01`** to `0x0011` on both. | Both writes are logged with their phone timestamps. | P1 |
| F23 | **Sync write strategy**: both writes are write-without-response, sent back-to-back from the same JavaScript tick (`Promise.all`). The phone time is recorded before and after each write, and `dispatchSkewMs` is stored. | In unit tests, the second write is dispatched within the same tick as the first. | P1 |
| F24 | **Periodic sync** every 60 s (configurable), incrementing the token (`0xAA01`, `0xAA02`, …), never 0, with a defined wrap rule. The schedule is based on the monotonic clock, so it doesn't drift. | With fake timers, a 10-minute session produces exactly 10 tokens after the start token, each 60 s ± 1 tick apart. | P1 |
| F25 | **Manual sync** button that sends the next token immediately and resets the 60 s timer. | — | P1 |
| F26 | **Partial-sync handling**: if one side is disconnected, write to the available side and log the token as partial. On reconnect, send a fresh token to both sides immediately. | Covered by tests. | P1 |
| F27 | **Stop**: send a final token, close the session, show a summary sheet (duration, strides per side, missed strides, tokens sent, alerts). | — | P1 |
| F28 | **Crash and kill recovery**: session state is persisted on every event. On relaunch with an open session, the app offers "Resume" (reconnect and continue the token sequence) or "Close". | Simulated in an integration test. | P1 |
| F29 | Session timer (hh:mm:ss) in the header. | — | P1 |

### E. Ground-truth labelling
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F30 | **Label annotator grid** built from `label_catalog.json` (see the proposed list below). Large buttons that can be used while walking beside the patient. | — | P1 |
| F31 | **Paired labels**: "FoG start" becomes "FoG end" while it is active, and active episodes are highlighted. **Instant labels** cover events such as Turn, Sit, Stand and Stumble. | You can't start an episode that is already open. Stop auto-closes open episodes and records that it did so. | P1 |
| F32 | Label write: the uint16 label ID is written to Label Marker `0x0012` on **both** devices, and logged with the phone timestamp and per-side write status. | — | P1 |
| F33 | **Void last label**: a label already written to the SD card can't be removed, so the app writes a `VOID` label ID and marks the earlier entry as voided in the log. | The Python label join honours voids (M05). | P1 |
| F34 | Timestamped free-text notes. | — | P1 |

**Proposed label catalogue.** This needs to be agreed with whoever runs the trials before collection.

| ID | Label | Kind |
|---|---|---|
| 1 / 2 | Trial: Normal walk | start / end |
| 3 / 4 | Trial: Shuffling | start / end |
| 5 / 6 | Trial: Limping (affected side recorded in session metadata) | start / end |
| 7 / 8 | FoG episode | start / end |
| 10 | Turn | instant |
| 11 | Sit down | instant |
| 12 | Stand up | instant |
| 13 | Stumble / near fall | instant |
| 14 | Pause / standing still | instant |
| 15 | Doorway / obstacle | instant |
| 99 | VOID previous label | instant |

### F. Live display
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F35 | **Live dashboard** using the brief's layout: stride time and cadence, stride length, tibial shock, swing and stance with percentages, FI bar, asymmetry bar and the EdgeAI panel. An L, R or both-sides toggle. Bars are scaled to the norms in `norms.ts`. | Updates within 100 ms of each stride being committed. | P2 |
| F36 | **Alert engine**:<br>• FoG: FI ≥ threshold (default 3.0) for N consecutive strides on either side. Shows a red banner, a haptic pattern and a sound.<br>• Pre-freeze band (1.5 up to the threshold): amber chip.<br>• Asymmetry > 15%: amber warning. Uses the app's bilateral value, or the firmware value as fallback.<br>• AI Shuffling or Limping: coloured badge.<br>Hysteresis on clearing. Every alert is logged as an episode with start, end, peak and duration. | Unit tests cover every rule boundary, including the 0007 replay producing **no** FoG alert at a threshold of 3.0 with N = 2. | P2 |
| F37 | Alert acknowledge and mute: mutes the sound for 60 s. The banner stays until the condition clears. | — | P2 |
| F38 | **Bilateral screen**: L vs R bars per metric, scrollable 20-stride time series per metric with both sides overlaid, and an asymmetry trend line. | — | P2 |
| F39 | **EdgeAI screen**: per-stride class timeline (green Normal, red Freezing, orange Shuffling, purple Limping, grey for no inference) with confidence; percentage of time per class; FoG episode count and total duration. | — | P4 |
| F40 | **Debug and GATT inspector**: every characteristic per device with raw hex, decoded value, last update time, and manual read, write and subscribe. A scrollable event log that can be exported. | — | P1 |

### G. On-phone inference
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F41 | Build the feature vector exactly as `feature_spec.json` defines it (10 features, firmware asymmetry). | A parity test against the Python `features.py` output on the same strides passes with |Δ| < 1e-6. | P4 |
| F42 | **GaitClassifier** with a TFLite backend (`fast-tflite`) and an MLP reference backend in TypeScript. **FI override**: when the FoG alert rule is active, the class is Freezing. | On the golden vectors, the TypeScript MLP output matches the Python TFLite output to within 1e-4. | P4 |
| F43 | Firmware and phone labels side by side when both exist, with an agreement percentage per session. | — | P4 |
| F44 | Model management: load `model.tflite` and `model_meta.json` (version, feature-spec hash, training date). **Refuse a model whose feature-spec hash doesn't match.** Ships with a stub model before real training. | Covered by tests. | P4 |

### H. Storage, history and export
| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| F45 | Persist sessions, strides (raw and derived, per side), sync tokens, labels, notes, alerts, inferences and connection events. Writes are batched every second, with migrations. | A 2-hour soak at replay speed ×50 gives a DB under 20 MB and no dropped strides. | P1 (core), P2 (strides) |
| F46 | Session history list (date, subject, duration, strides, alerts) and a detail screen. Delete requires confirmation. | — | P5 |
| F47 | **CSV export**. `strides_L.csv` and `strides_R.csv` use the **firmware `S_*.CSV` column names** plus extra columns, so the Python tools read app exports unchanged. Also `markers.csv` (sync tokens and labels, with phone time and per-side status), `alerts.csv`, `connection_events.csv` and `session.json` (metadata, app version, GATT spec version, model version). | A round-trip test: the export is parsed by `ml/arcsense_ml/io.py`. | P1 (markers), P5 (full) |
| F48 | **PDF summary**: header with metadata, a per-side metrics table (mean, SD, CV against norms), asymmetry, class distribution, alert episodes, sync log statistics and the notes. | Snapshot test of the HTML template. | P5 |
| F49 | Zip bundle of everything in a session, shared through the system share sheet. | — | P1 (basic), P5 |

### I. Settings and about
| ID | Functionality | Phase |
|---|---|---|
| F50 | Settings: FI threshold, consecutive-stride count N, pre-freeze band, asymmetry threshold, sync interval, polling on or off, sound and haptics on or off, replay mode. The values are saved, and a "Reset to defaults" option is provided. | P2 |
| F51 | About: app version, build number, GATT spec version, label catalogue version, model version and hash. | P5 |

### J. Replay and mock mode (development, demos and E2E)
| ID | Functionality | Phase |
|---|---|---|
| F52 | **MockTransport** implements the same interface as the real BLE transport. It provides 2 virtual devices: L is the replay of `S_L_0007.CSV` at real timing; R is generated from L with a configurable asymmetry and phase offset. Speed can be ×1, ×10 or ×50. | P1 |
| F53 | Episode injection in replay: FoG (FI ramp), Shuffling (shorter stride and length, raised cadence) and Limping (asymmetric swing and stance). Also fault injection: disconnects, dropped notifications, malformed packets. | P1/P2 |

---

## 4. ML pipeline functionality — complete list

| ID | Functionality | Acceptance criterion | Phase |
|---|---|---|---|
| M01 | Readers for `S_*.CSV`, `E_*.CSV`, `I_*.csv` and the app export bundle, with a schema check that gives a clear error on mismatch. | Reads every file in `analysis_007` and an app export. | P1 |
| M02 | **BIN reader** for `I_*.BIN`. The header is `ARC1`, session number, role, and so on; records are 20 bytes. Validated against `I_L_0007.csv`. If the firmware team supplies the struct definition, that is used in preference to reverse-engineering. | Decoded samples equal the CSV within float rounding across all 32,178 rows. Preallocated empty space is detected and skipped. | P1 |
| M03 | **Bilateral alignment** (`align_bilateral.py`): finds the sync tokens in the L and R streams, matches them, fits a clock offset and drift (linear), reports residual jitter per token, and writes an aligned merged dataset. Cross-checks against the app's `markers.csv`. | On synthetic L/R with a known offset and drift, recovers the offset within 1 sample (2.5 ms) and the drift within 10 ppm. | P1 |
| M04 | **Session QA report** (`qa_session.py`), to run on day 1 of collection: sample rate check, gaps and dropouts, stride count, FI distribution, sync token coverage, label coverage and unclosed episodes. Outputs a pass/warn/fail summary in Markdown. | Runs on 0007 and flags "no sync tokens, single side". | P1 |
| M05 | **Label join**: label-marker IDs become time segments (honouring VOID, auto-closing at session end). Each stride gets the active trial label plus the FoG episode overlay. Unlabelled strides are excluded. | Unit tests on all segment edge cases. | P3 |
| M06 | **Feature extraction** (`features.py`): the single implementation of the 10-feature vector from `feature_spec.json`. | Parity test against the app (F41). | P3 |
| M07 | **Dataset builder**: combines many sessions with subject IDs. Splits are grouped by subject, so the same subject is never in both train and test. Records each sample's provenance (real or synthetic, and if real, whether the subject had the condition or was imitating it). | — | P3 |
| M08 | **Synthetic generator** (`synth.py`): Normal is based on the 0007 distributions; Freezing, Shuffling and Limping are parametric distortions. **Every output is tagged synthetic, and the trainer refuses to report synthetic metrics as real.** | — | P3 |
| M09 | **Training**: Keras MLP (10→16→8→4, ReLU, softmax) with a normalisation layer inside the graph and class weights. Evaluation uses leave-one-subject-out (LOSO) cross-validation, or stratified 80/20 if there is only one subject. Reports per-class precision, recall and F1, a confusion matrix, and the sensitivity and false-alarm rate of the FI override. A scikit-learn baseline runs for comparison. Seeds are fixed. | It is deterministic: the same seed gives the same weights. | P3 |
| M10 | **Export**: `model.tflite` (float, for the app), `model_int8.tflite` (full-int8 quantisation with a representative dataset), `model_data.h` (`alignas(16)`, generated in Python), `feature_spec.h`, `golden_vectors.h` (inputs plus expected outputs for both models), and `model_meta.json` (version and feature-spec hash). | Float vs int8 top-1 agreement ≥ 98% on held-out data. The operator set is limited to FullyConnected, ReLU, Softmax, Quantize and Dequantize. The arena estimate and model size are reported, with a target under 8 KB. `gcc` compiles a test file that includes all headers. | P3 |
| M11 | `EdgeAIClassifier` stub and `TFLiteGaitClassifier` wrapper as described in the brief, used by the scripts. | — | P3 |

---

## 5. Phases (in order)

| Phase | Contents | Exit gate |
|---|---|---|
| **P0 Setup** | Install Node LTS, JDK 17, the Android SDK and emulator, Expo CLI, Maestro, and `uv` with Python 3.11. Run `git init`. Scaffold `app/`, `ml/` and `shared/`. Set up lint, typecheck and test configuration and the `Makefile`. | `make verify` runs green on an empty skeleton, and the Android dev build launches on the emulator. |
| **P1 Collection build** (needed before collection starts) | F01–F12, F15, F21–F34, F40, F45 (core), F47 markers, F49 basic, F52, F53 (faults); M01–M04 | All P1 tests pass. **Hardware tests HT-01 to HT-10 pass on real devices.** A signed release APK is installed on the trial phone. |
| **P2 Live monitoring** | F13, F14, F16–F20, F35–F38, F45 (strides), F50, F53 (episodes) | All tests pass. The replay with injected FoG shows the correct alerts end to end in Maestro. |
| **P3 ML pipeline** | M05–M11 | A synthetic run goes end to end to `model_data.h`, the golden vectors and the header compile check. |
| **P4 AI in app** | F39, F41–F44 | Parity tests pass, and the app classifies replayed strides with the exported model. |
| **P5 History and reporting** | F46–F49 (full), F51 | Export round-trip and PDF snapshot tests pass. |
| **P6 Release and hardware regression** | Full hardware test checklist (§6.6), release APK, optional iOS build through EAS | Checklist signed off. |
| **After collection** | Run QA (M04) on every session, then align (M03), build the dataset (M05–M07), train with LOSO (M09), export (M10) and hand over to the firmware team. Ship the real model in the app (F44). | Real metrics reported per class, with the provenance stated. |

**Critical path:** P0 → P1 → hardware tests on real devices. If P1 isn't ready before collection starts, the fallback is to collect with written trial notes as ground truth and use the nRF Connect app to write sync tokens by hand. That works, but alignment and labels will be much weaker.

---

## 6. Test plan

### 6.1 Test layers

| Layer | Tool | What it covers | Runs where |
|---|---|---|---|
| **Static** | `tsc --strict`, ESLint, Prettier, ruff, mypy | Type errors and lint issues. | Locally and with `make verify` |
| **Unit (app)** | Jest | Codec, assembler, bilateral, statistics, sync scheduler (fake clock), alert engine, label service, recovery logic, feature builder, MLP reference, CSV writer, codegen freshness. | Node, no device |
| **Component** | React Native Testing Library | Every screen and UI component with mocked stores: rendering, states (empty, connecting, lost, alert), button actions, accessibility labels. | Node |
| **Integration (app)** | Jest with MockTransport, fake clock and `better-sqlite3` drizzle | Whole pipelines: transport → services → store → DB. Full sessions with fault injection. Export round-trip. | Node |
| **Contract** | Jest and pytest | `shared/*.json` matches the generated TypeScript and the Python constants. Feature parity TS↔Python. MLP TS↔TFLite parity on golden vectors. App CSV export parsed by Python. | Node + Python |
| **Unit and integration (ML)** | pytest | Readers, BIN parser vs CSV, alignment recovery, label join, features, synthetic data, deterministic training, export, int8 agreement, operator check, header compile with gcc. | Python venv |
| **E2E** | Maestro on the Android emulator, app in replay mode | User journeys (§6.3). | Android emulator |
| **Soak and performance** | Jest (replay ×50) and an on-device run | 2-hour session: memory stays flat, DB size bounded, no dropped strides, UI updates under 100 ms. | Node + emulator |
| **BLE emulator** (optional) | `tools/ble_emulator` (bless/BlueZ) and a real phone | Real radio, real GATT, before hardware is available. A single adapter acts as one device; two adapters or a second machine are needed for L and R. | Linux machine with a BT adapter |
| **Hardware** | Manual checklist with scripted analysis | Things only real devices can show (§6.6). | You and me, with the devices |

### 6.2 Coverage targets
- `src/ble`, `src/services`, `src/ml`, `src/export`: **≥ 90% lines and ≥ 85% branches**. The codec and SyncService: 100% branches.
- `ml/arcsense_ml`: **≥ 90% lines**.
- Every screen has at least one component test, and every functionality ID appears in the traceability matrix (§6.4).

### 6.3 E2E journeys (Maestro, replay mode)
1. **E2E-01:** First launch, then permissions, then scan, then both mock devices appear, then Connect both, then both badges are green.
2. **E2E-02:** New session (subject ID required), then Start. The timer runs and the sync log shows `0xAA01` for both sides.
3. **E2E-03:** Label flow: Trial Normal start, Turn, FoG start, FoG end, Void, Trial end. The marker log is correct.
4. **E2E-04:** Injected FoG appears as a red banner within N strides and clears afterwards. The alert episode is logged.
5. **E2E-05:** Injected disconnect of R shows a reconnecting badge, then automatic recovery. The next token is sent to both sides.
6. **E2E-06:** Stop, then the summary, then the export bundle is created and the share sheet opens.
7. **E2E-07:** The app is killed mid-session. On relaunch the app offers Resume, and the token sequence continues.
8. **E2E-08:** Settings change (FI threshold 2.0) increases the alerts on the replay as expected.
9. **E2E-09:** The AI screen shows the class timeline and distribution from the stub or synthetic model.
10. **E2E-10:** History, then detail, then PDF export.

### 6.4 Traceability matrix (functionality → automated tests)

| Functionality | Test IDs |
|---|---|
| F01–F02 | `permissions.test.ts`, `ScannerScreen.test.tsx`, E2E-01 |
| F03 | `ForegroundSession.test.ts` (service start/stop calls), HT-07 |
| F04–F07 | `DeviceManager.scan.test.ts`, `DeviceManager.gattValidation.test.ts`, E2E-01 |
| F08, F13, F14 | `DeviceManager.modeStrategy.test.ts` (all 3 modes) |
| F09–F12 | `DeviceManager.reconnect.test.ts` (fake clock backoff), E2E-05 |
| F15 | `codec.test.ts` (every type, little-endian, wrong lengths, `0xFF`/`-1`, round-trip) |
| F16 | `StrideAssembler.test.ts` (permutations of arrival order, timeout commit, gaps, duplicate counts, counter wrap) |
| F17, F19 | `SessionStats.test.ts`, **`replay0007.integration.test.ts` (mean 1.305 s, CV 2.90%, matching the report)** |
| F18 | `BilateralAnalyzer.test.ts` |
| F20 | `liveStore.test.ts` |
| F21–F29 | `SyncService.test.ts` (start order, tick timing over 10 min, manual reset, wrap, partial, reconnect resync, stop), `SessionRecorder.test.ts`, `RecoveryService.test.ts`, E2E-02/06/07 |
| F30–F34 | `LabelService.test.ts` (pairing, double-start guard, auto-close, void), `SessionScreen.test.tsx`, E2E-03 |
| F35, F38 | `DashboardScreen.test.tsx`, `BilateralScreen.test.tsx` |
| F36, F37 | `AlertEngine.test.ts` (each threshold ±ε, N consecutive, hysteresis, either side, mute), **`replay0007.noFalseFoG.test.ts`**, E2E-04/08 |
| F39 | `AiScreen.test.tsx`, `classStats.test.ts`, E2E-09 |
| F40 | `DebugScreen.test.tsx` |
| F41–F44 | `features.parity.test.ts`, `MlpReference.golden.test.ts`, `GaitClassifier.override.test.ts`, `modelMeta.test.ts` |
| F45 | `repositories.test.ts` (better-sqlite3), `migrations.test.ts`, `soak.test.ts` |
| F46–F49 | `csv.test.ts`, `pdfTemplate.snapshot.test.ts`, `bundle.test.ts`, **`export_roundtrip` (pytest reads app export)**, E2E-06/10 |
| F50–F51 | `settingsStore.test.ts`, `SettingsScreen.test.tsx`, E2E-08 |
| F52–F53 | `MockTransport.test.ts` |
| Shared contract | `codegen.fresh.test.ts`, `test_shared_contract.py` |
| M01 | `test_io.py` (all `analysis_007` files and an app export fixture) |
| M02 | `test_bin_reader.py` (all rows match `I_L_0007.csv`) |
| M03 | `test_align.py` (synthetic offset and drift recovered) |
| M04 | `test_qa.py` (0007 → expected warnings) |
| M05 | `test_labels.py` |
| M06 | `test_features.py` plus cross-language parity fixtures |
| M07–M08 | `test_dataset.py` (no subject leakage), `test_synth.py` (provenance tag enforced) |
| M09 | `test_train.py` (determinism, LOSO folds correct, metrics file schema) |
| M10–M11 | `test_export.py` (operator allow-list, float vs int8 agreement, size budget, golden vectors, **gcc compile of headers**) |

### 6.5 Fixtures
- Replay of `analysis_007/S_L_0007.CSV`, the real stride data, as the ground truth for the statistics tests.
- `I_L_0007.BIN` paired with `I_L_0007.csv` for the BIN parser.
- Generated synthetic bilateral sessions with known offset, drift, tokens and labels for alignment and label-join tests.
- Malformed packet set: truncated, oversized and NaN floats.
- Golden vectors produced by `export.py`, consumed by both Jest and the firmware team.

### 6.6 Hardware test checklist (needs real ArcSense-L/R and an Android phone)
Parts of this can't be automated here because they need radio hardware. Each test still has a scripted pass/fail where possible.

| ID | Test | Pass criterion |
|---|---|---|
| HT-01 | Scan and identify both devices; role characteristic matches the name. | Both found within 10 s. |
| HT-02 | GATT validation report on real firmware. | No missing characteristics. Any extras are documented. |
| HT-03 | BLE mode detection in each firmware build the team ships. | Correct strategy chosen. |
| HT-04 | Live values match the SD stride CSV for the same session. | Same stride count; values equal within float formatting. |
| HT-05 | **Sync skew measurement:** a 10-minute session with both devices; afterwards run `align_bilateral.py` on both BIN files. | Every app token is found in both BIN files. Residual skew is reported (expected about 7.5–15 ms, D6). |
| HT-06 | Label markers appear in both BIN or CSV files at the right times. | All labels present, including VOID. |
| HT-07 | Screen locked for 10 minutes mid-session. | Tokens keep arriving every 60 s (confirmed from the BIN files). |
| HT-08 | Walk-away disconnect (out of range, then return). | Auto-reconnect, subscriptions restored, fresh resync token. |
| HT-09 | Power-cycle one device mid-session. | Same as HT-08. The session continues. |
| HT-10 | 60-minute session: phone battery drain, app memory, DB size. | No crash, no strides lost (count gap = 0 in Streaming mode), drain recorded. |
| HT-11 | Streaming and EdgeAI modes: live dashboard and alerts with real walking, plus simulated freezing (trembling in place). | Alert behaviour matches the configured rule. |
| HT-12 | Export bundle from the phone, then `qa_session.py`. | QA passes. |

### 6.7 Single command
`make verify` runs, in order:
1. Codegen freshness check.
2. `tsc`, ESLint, Prettier check, ruff and mypy.
3. Jest unit, component and integration tests with coverage thresholds enforced.
4. pytest with coverage.
5. ML synthetic end-to-end run (train, export, header compile).
6. Cross-language contract tests.
7. Maestro E2E on the emulator (`make e2e`, separate because it needs the emulator running).

It produces `reports/` containing the coverage HTML, JUnit XML, the ML metrics and the QA sample. If the repo goes on GitHub, the same targets run in a GitHub Actions workflow (E2E runs on a schedule because it is slower).

### 6.8 What automated testing does **not** prove (stated plainly)
- Real BLE radio behaviour, timing and range. HT-01 to HT-12 cover these.
- iOS behaviour, until an iPhone and an Apple Developer account are available.
- Clinical accuracy of the classifier. That needs real labelled data from real patients, and no software test can stand in for it.
- On-device TFLite Micro inference on the nRF52840. The golden vectors are supplied so the firmware team can verify it.

---

## 7. Open questions (none block starting P0/P1)
1. **Firmware owner:**
   - What does writing `0x000C` do (D7)?
   - The BIN record struct.
   - Do all 8 gait characteristics notify on every stride?
   - Which BLE mode will be used during collection?
   - Is a sync or label value of 0 treated as "no marker"?
   - How is the FI computed (D1)?
2. **Trial team:** approve the label catalogue (§3 E) and the trial protocol: subjects, classes, durations, and whether patterns come from patients or healthy people imitating them.
3. **You:**
   - Approve the toolchain installs under `~/` (about 6 GB including the emulator image) and `git init`.
   - Is a physical Android phone available? Which model and Android version?
   - Will you want iOS later? If so, an Apple Developer account is needed.

---

## 8. Out of scope
- Firmware changes. The optional suggestion for a sync timestamp latch in firmware stays only a proposal.
- Cloud backend, user accounts, or automatic upload of data.
- Diagnostic claims. The app displays measurements and alerts; it does not diagnose.
