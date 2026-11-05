# ARC SENSE — App & BLE Dashboard + Edge ML Brief
> **Partner scope: App development, BLE dashboard, and EdgeML gait classifier only.**
> Firmware is done. Your job starts at the phone/app layer.
> Document Revision: 1.0 — October 2026

---

## 1. What You Are Building

Three deliverables, in priority order:

| # | Deliverable | Description |
|---|---|---|
| **1** | **BLE Dashboard App** | Connect to `ArcSense-L` and `ArcSense-R`, visualise live gait metrics, send sync commands |
| **2** | **EdgeML Gait Classifier** | Train a model that classifies each stride as Normal / Freezing / Shuffling / Post-Stroke Limping |
| **3** | **Model Deployment Pipeline** | Convert trained model → TFLite flatbuffer → embed in firmware as `model_data.h` |

> **No data yet** — start with the app UI + BLE scaffolding, and build the ML pipeline structure ready to plug in once SD card data arrives.

---

## 2. What the Firmware Already Provides (Do Not Touch)

The firmware is fully operational. It exposes a complete BLE GATT server. All BLE characteristics are **already live on the device** — you only need to read/subscribe to them from your app.

### 2.1 BLE Device Advertisement
- Left ankle advertises as **`ArcSense-L`**
- Right ankle advertises as **`ArcSense-R`**
- Advertised service UUID: `19B10000-E8F2-537E-4F6C-D104768A1214`

### 2.2 BLE Operating Modes (set at firmware compile time)
| Mode | Value | Behaviour |
|---|---|---|
| `BLE_MODE_DATA_COLLECTION` | `0` | Characteristics exist, **not notified** — poll on demand. All data goes to SD. |
| `BLE_MODE_EDGE_AI` | `1` | **Notifies** AI label + confidence every stride. Gait params also readable. |
| `BLE_MODE_STREAMING` | `2` | **Notifies** all gait params every stride (~1 Hz). For live dashboard. |

> **For your dashboard: use `BLE_MODE_STREAMING` or `BLE_MODE_EDGE_AI`** — the firmware must be compiled with the appropriate mode. Coordinate with the firmware owner.

---

## 3. Complete GATT UUID Map

Base: `19B10000-E8F2-537E-4F6C-D104768A1214`

### Service 1 — Gait Streaming (`0x0000`)
Subscribe to notifications on all of these for live data:

| Characteristic | UUID Suffix | Type | Unit | Notes |
|---|---|---|---|---|
| Stride Time | `0x0001` | `float` | seconds | `tHS(n) - tHS(n-1)` |
| Swing Time | `0x0002` | `float` | seconds | `tHS - tTO` |
| Stance Time | `0x0003` | `float` | seconds | `tTO - tHS(n-1)` |
| Stride Length | `0x0004` | `float` | metres | With 1.12× shank lever-arm correction |
| Tibial Shock | `0x0005` | `float` | g | Peak axial accel at heel strike |
| Asymmetry Index | `0x0006` | `float` | % | `|L-R| / mean(L,R) × 100` |
| Freeze Index | `0x0007` | `float` | ratio | FI ≥ 2.0 = active freezing episode |
| Stride Count | `0x0013` | `uint32` | — | Continuously incrementing counter |

### Service 2 — Device Info (`0x0008`)
| Characteristic | UUID Suffix | Type | Notes |
|---|---|---|---|
| Device Role | `0x0009` | `uint8` | ASCII: `76='L'`, `82='R'` |
| BLE Mode | `0x000A` | `uint8` | 0=DataCollection, 1=EdgeAI, 2=Streaming |

### Service 3 — Sync (`0x000B`)
| Characteristic | UUID Suffix | Type | Notes |
|---|---|---|---|
| Session Start Timestamp | `0x000C` | `uint32` | Master's `micros()` at session open. Write to this to trigger a sync. |

### Service 4 — Command Channel (`0x0010`)
| Characteristic | UUID Suffix | Type | Notes |
|---|---|---|---|
| Sync Marker | `0x0011` | `uint16` | **Write** a token (e.g. `0xAA01`) to stamp both devices' BIN files simultaneously for post-processing alignment |
| Label Marker | `0x0012` | `uint16` | Write a label ID into the SD stream for ground-truth annotation during trials |

### Service 5 — Edge AI (`0x000D`) ← Your primary deliverable
| Characteristic | UUID Suffix | Type | Notes |
|---|---|---|---|
| AI Label | `0x000E` | `int8` | `255` = no inference yet; `0..3` = class index (see table below) |
| AI Confidence | `0x000F` | `float` | `0.0..1.0` |

#### EdgeAI Label Classes
| Label Value | Class | Clinical Meaning |
|---|---|---|
| `0` | Normal | Healthy gait pattern |
| `1` | Freezing | Freezing of Gait episode (FI ≥ 2.0) |
| `2` | Shuffling | Reduced step height, Parkinson's hypokinesia |
| `3` | Post-Stroke Limping | Asymmetric swing/stance, reduced affected-side length |
| `255` | No Inference | Model not yet run (default, data-collection mode) |

---

## 4. Bilateral Sync — What the App Must Do

The phone is the **timing master**. This is your job to implement:

1. **Connect BLE** to both `ArcSense-L` and `ArcSense-R` simultaneously.
2. **At session start**, write the same 16-bit token to the **Sync Marker characteristic** (`0x0011`) on **both devices as close together as possible** (target: < 2 ms apart). Example token: `0xAA01`.
3. **Repeat every 60 seconds** with an incremented token to maintain alignment.
4. The firmware automatically stamps the next SD sample with this token — you don't need to do anything on the firmware side.

```
Phone App
  │
  ├── write 0xAA01 → ArcSense-L  Sync Marker (0x0011)
  └── write 0xAA01 → ArcSense-R  Sync Marker (0x0011)
         ↕ (< 2 ms jitter)
Both BIN files stamped → sub-millisecond bilateral alignment
```

---

## 5. App Architecture — Suggested Stack

> Choose what suits you best. Recommendations below.

### Option A — Flutter (Recommended for cross-platform)
- iOS + Android from one codebase
- BLE: `flutter_blue_plus` package
- Charts: `fl_chart` or `syncfusion_flutter_charts`
- ML inference: `tflite_flutter` (runs the `.tflite` model on-device)

### Option B — React Native
- BLE: `react-native-ble-plx`
- Charts: `Victory Native` or `react-native-chart-kit`
- ML: `react-native-tensorflow-lite`

### Option C — Native Android (Kotlin)
- BLE: `android.bluetooth.le` or `RxAndroidBle`
- Charts: `MPAndroidChart`
- ML: TensorFlow Lite Android API (`org.tensorflow:tensorflow-lite`)

---

## 6. Dashboard Screens to Build

### Screen 1 — Device Scanner
- Scan for BLE devices named `ArcSense-L` and `ArcSense-R`
- Show RSSI signal strength for each
- Connect to both simultaneously
- Show connection status badges (Left ●, Right ●)

### Screen 2 — Live Gait Dashboard
Real-time display, updated every stride (~1 Hz):

```
┌─────────────────────────────────────────────────┐
│  ARC SENSE  ●L  ●R          Session: 00:04:12   │
├───────────────┬─────────────────────────────────┤
│  STRIDE TIME  │  1.24 s          Cadence: 82 spm│
│  STRIDE LEN   │  ████████  1.38 m               │
│  TIBIAL SHOCK │  ████████  2.1 g                │
│  SWING        │  ████░░░░  0.40 s (32%)         │
│  STANCE       │  ████████  0.84 s (68%)         │
├───────────────┴─────────────────────────────────┤
│  FREEZE INDEX  ████░░░░░░░░  0.8   [NORMAL]     │
│  ASYMMETRY     ████░░░░░░░░  4.2 %              │
├─────────────────────────────────────────────────┤
│  EDGE AI:  🟢 NORMAL  (confidence: 94%)         │
└─────────────────────────────────────────────────┘
```

Key alerts:
- **Freeze Index ≥ 2.0** → red banner "⚠️ FREEZING EPISODE DETECTED"
- **Asymmetry > 15%** → amber warning "Asymmetry elevated"
- **EdgeAI = Shuffling or Limping** → distinct colour badge

### Screen 3 — Bilateral Comparison
- Side-by-side Left vs. Right bar/line charts for each metric
- Scrollable time-series of last 20 strides per ankle
- Real-time asymmetry index trend graph

### Screen 4 — Session Control
- **Start / Stop session** button (triggers sync marker write + SD session begin)
- **Manual sync** button (writes sync marker to both devices)
- **Label annotator**: tap buttons to tag ground-truth events (e.g. "FoG start", "Turn", "Sit down") — writes to Label Marker characteristic (`0x0012`)
- Export session summary as PDF/CSV after session ends

### Screen 5 — EdgeAI Classification Results
- Per-stride timeline showing class label + confidence
- Colour-coded: Green=Normal, Red=Freezing, Orange=Shuffling, Purple=Limping
- Episode summary: % time in each state, total freeze episodes, total freeze duration

---

## 7. EdgeML Pipeline — How to Build It (No Data Needed Yet)

### 7.1 Feature Vector (Per Stride)
Each stride from the SD card CSV produces one feature vector. These are the input features for the classifier:

```python
features = [
    stride_time_s,        # Temporal
    swing_time_s,
    stance_time_s,
    stride_length_m,      # Spatial
    tibial_shock_g,       # Impact
    asymmetry_index,      # Bilateral
    freeze_index,         # Spectral (your primary discriminator for FoG)
    cadence_spm,          # Derived: 60 / stride_time_s
    swing_ratio,          # Derived: swing_time_s / stride_time_s
    stance_ratio,         # Derived: stance_time_s / stride_time_s
]
```

### 7.2 Training Pipeline (Once Data Arrives)
```
SD Card CSVs                         Ground Truth Labels
    │                                     │ (from trial notes / label markers)
    ▼                                     ▼
[tools/parse_strides.py]  ──────► [feature_matrix.csv]
                                          │
                                          ▼
                                   [train_classifier.py]
                                   - sklearn MLP or TensorFlow Keras
                                   - 80/20 train/test split
                                   - LOOCV if dataset small
                                          │
                                          ▼
                                    [model.tflite]
                                          │
                                          ▼
                              xxd -i model.tflite > model_data.h
                                          │
                                          ▼
                              Flash firmware with embedded model
```

### 7.3 What to Build Now (Before Data)
You can build the full pipeline skeleton right now:

**Step 1 — Stub classifier class** (`edge_ai_classifier.py`):
```python
class EdgeAIClassifier:
    LABELS = ["Normal", "Freezing", "Shuffling", "Limping"]
    
    def predict(self, features: list[float]) -> tuple[int, float]:
        """Returns (label_index, confidence). Stub returns 0, 1.0."""
        return 0, 1.0
```

**Step 2 — Feature extractor** (`parse_strides.py`):
```python
import pandas as pd

def extract_features(stride_csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(stride_csv_path)
    df['cadence_spm'] = 60.0 / df['strideTimeS']
    df['swing_ratio'] = df['swingTimeS'] / df['strideTimeS']
    df['stance_ratio'] = df['stanceTimeS'] / df['strideTimeS']
    return df[['strideTimeS','swingTimeS','stanceTimeS',
               'strideLengthM','tibialShockG','asymmetryIndex',
               'freezeIndex','cadence_spm','swing_ratio','stance_ratio']]
```

**Step 3 — TFLite inference wrapper** (for the app):
```python
import numpy as np
import tflite_runtime.interpreter as tflite

class TFLiteGaitClassifier:
    def __init__(self, model_path: str):
        self.interpreter = tflite.Interpreter(model_path=model_path)
        self.interpreter.allocate_tensors()
        self.input_idx = self.interpreter.get_input_details()[0]['index']
        self.output_idx = self.interpreter.get_output_details()[0]['index']
    
    def predict(self, features: list[float]) -> tuple[int, float]:
        inp = np.array([features], dtype=np.float32)
        self.interpreter.set_tensor(self.input_idx, inp)
        self.interpreter.invoke()
        probs = self.interpreter.get_tensor(self.output_idx)[0]
        label = int(np.argmax(probs))
        return label, float(probs[label])
```

### 7.4 Freeze Index as Primary FoG Signal
You don't even need ML for Freezing detection — the firmware already computes it:

```
FI ≥ 2.0  →  Freezing episode (high sensitivity, use as primary trigger)
FI 1.5–2.0 →  Pre-freeze / borderline
FI < 1.5  →  Normal locomotion
```

Use ML to distinguish the other three classes (Normal vs. Shuffling vs. Limping), and use FI as an override for Freezing.

---

## 8. Data Format You Will Receive from SD Cards

The firmware writes these files to the SD card after each session:

### Stride CSV (`S_L_NNNN.CSV`, `S_R_NNNN.CSV`)
```csv
session_us,timestamp_us,sampleIndex,strideTimeS,swingTimeS,stanceTimeS,strideLengthM,tibialShockG,asymmetryIndex,freezeIndex,edgeai_label,edgeai_confidence
```

### Events CSV (`E_L_NNNN.CSV`, `E_R_NNNN.CSV`)
```
eventType, sampleIndex, timestamp_us
```
Events: `MID_SWING`, `TOE_OFF`, `HEEL_STRIKE`, `MID_STANCE`

### Baseline values from first live trial (use these to calibrate your UI ranges)
| Metric | Observed Range | Healthy Norms |
|---|---|---|
| Stride Time | 1.10–1.68 s | 1.0–1.5 s |
| Swing Time | 0.35–0.44 s | 0.35–0.45 s |
| Stance Time | 0.76–1.39 s | 0.60–0.75 s |
| Tibial Shock | 1.01–1.84 g | 1.0–3.0 g |
| Stride Length | 1.21–1.71 m | 1.2–1.8 m |
| Freeze Index | < 2.0 = normal | — |

---

## 9. Key Contacts & Interfaces

| Item | Owner |
|---|---|
| Firmware + BLE GATT server | You (firmware team) |
| BLE Mode (`BLE_MODE_STREAMING` vs `BLE_MODE_EDGE_AI`) | Set at firmware compile time — coordinate with firmware owner |
| SD card data collection | Firmware team (data not available yet) |
| App UI + BLE client + EdgeML | **You (partner)** |
| TFLite model embedding in firmware (`model_data.h`) | Joint — you train it, they flash it |

---

## 10. Suggested Work Order (No Data Needed)

```
Week 1
├─ Set up BLE scanning and connection to ArcSense-L / ArcSense-R
├─ Parse and display all GATT characteristics on a debug screen
└─ Build sync marker write flow (both devices simultaneously)

Week 2
├─ Build live dashboard UI with all gait metrics
├─ Add Freeze Index alert bar + EdgeAI result display panel
└─ Build bilateral comparison screen (L vs R)

Week 3
├─ Build EdgeAI pipeline skeleton (feature extractor + TFLite wrapper stub)
├─ Wire AI label/confidence to dashboard screen (using stub output for now)
└─ Build session control + label annotation screen

When data arrives
├─ Run parse_strides.py on SD CSVs
├─ Label strides with ground truth (use trial notes + label marker timestamps)
├─ Train MLP classifier, evaluate LOOCV
└─ Export model.tflite → coordinate with firmware team to embed + flash
```

---

*The firmware is stable and validated. The BLE GATT server is live and ready for a central to connect. Build the app layer on top.*
