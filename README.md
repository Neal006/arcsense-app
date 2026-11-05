# ARC SENSE — App, BLE client and EdgeML pipeline

This repository holds the software for the ARC SENSE bilateral ankle-IMU gait system, from the BLE link upward. The firmware lives elsewhere.

| Directory | Contents |
|---|---|
| `app/` | React Native (Expo) app. It connects to `ArcSense-L` and `ArcSense-R`, acts as the bilateral sync master, records ground-truth labels, shows live gait metrics and alerts, classifies strides on the phone, and exports sessions. |
| `ml/` | Python pipeline: SD-card readers (CSV and BIN), bilateral alignment, session QA, label join, features, training, and export to `.tflite` and `model_data.h`. |
| `shared/` | Contracts that both the app and the ML code are generated from or tested against: the GATT map, the label catalogue and the feature specification. |
| `data/reference/` | Session 0007 reference recording, used as test fixtures. |
| `docs/` | The plan (`PLAN.md`), the brief, spec and data discrepancies (`FINDINGS.md`), and the reference documents. |

Read `docs/FINDINGS.md` before changing thresholds or decoders.

## Quick start

```bash
make setup     # install app (npm) and ml (uv) dependencies
make verify    # codegen check, typecheck, lint, all unit and integration tests, ML pipeline smoke test
```

The setup for each component is described in `app/README.md` and `ml/README.md`.
