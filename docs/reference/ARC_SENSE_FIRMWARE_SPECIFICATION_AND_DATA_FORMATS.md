# ARC SENSE — Firmware Specifications & Data Formats Reference Manual

**Author:** ARC SENSE Core Engineering Team  
**Target Hardware:** Arduino Nano 33 BLE Rev2 (Nordic nRF52840 Cortex-M4F)  
**Sensors:** Bosch BMI270 6-Axis IMU & Bosch BMM150 Magnetometer  
**Storage:** MicroSD SPI (CS: Pin D10, FAT32 via `SdFat`)  
**Wireless:** Bluetooth Low Energy 5.0 (`ArduinoBLE`)  

---

## 1. Storage Architecture & Binary File Byte Layout

Logging does **not** rely exclusively on CSV. High-throughput raw sensor data is stored in a packed binary format (`.BIN`) to guarantee zero write latency on the critical DSP path, while parsed gait events and clinical stride parameters are simultaneously saved to structured CSV files.

### 1.1 Session File Trio
Every recording session creates three files on the microSD root directory (where `<ROLE>` is `L` for Left ankle or `R` for Right ankle, and `NNNN` is an auto-incrementing 4-digit index `0000..9999`):

1. **`I_<ROLE>_NNNN.BIN`** — Raw 400 Hz IMU binary stream (header + continuous records).
2. **`E_<ROLE>_NNNN.CSV`** — Detected gait discrete events (`MID_SWING`, `TOE_OFF`, `HEEL_STRIKE`, `MID_STANCE`).
3. **`S_<ROLE>_NNNN.CSV`** — Validated per-stride spatial/temporal parameters.

---

### 1.2 Binary Header Layout (`ImuBinaryHeader`, 32 Bytes)
Written once at file byte offset `0x00000000`. Memory layout is strictly packed (`#pragma pack(push, 1)`):

```cpp
#pragma pack(push, 1)
struct ImuBinaryHeader {
    char     magic[4];       // "ARC1" (0x41, 0x52, 0x43, 0x31)
    uint32_t session_id;     // Sequential session counter (0, 1, 2, ...)
    uint32_t start_time_us;  // Device uptime at creation (micros())
    char     role;           // 'L' or 'R'
    uint8_t  reserved[19];   // Zero-padded reserved block
};
#pragma pack(pop)
```

| Offset (Hex) | Field Name | Data Type | Size | Endianness | Description |
|---|---|---|---|---|---|
| `0x00` | `magic` | `char[4]` | 4 Bytes | Big-Endian | Magic signature: `"ARC1"` |
| `0x04` | `session_id` | `uint32_t` | 4 Bytes | Little-Endian | Monotonic session index |
| `0x08` | `start_time_us` | `uint32_t` | 4 Bytes | Little-Endian | System clock timestamp ($\mu\text{s}$) |
| `0x0C` | `role` | `char` | 1 Byte | ASCII | Node identifier (`'L'` or `'R'`) |
| `0x0D` | `reserved` | `uint8_t[19]` | 19 Bytes | — | Padding to complete 32-byte sector boundary |

---

### 1.3 Sample Record Layout (`ImuBinaryRecord`, 20 Bytes)
Streamed continuously at **400 Hz** (8,000 bytes/second) starting at byte offset `0x00000020`:

```cpp
#pragma pack(push, 1)
struct ImuBinaryRecord {
    uint32_t sensor_time;   // 24-bit BMI270 hardware timer ticks (~39.0625 µs)
    int16_t  accel[3];      // Signed raw acceleration: [0]=X, [1]=Y, [2]=Z
    int16_t  gyro[3];       // Signed raw angular rate:  [0]=X, [1]=Y, [2]=Z
    uint16_t sync_marker;   // External trigger pulse / BLE clock marker
    uint16_t label_marker;  // 16-bit rolling sequence counter (0..65535)
};
#pragma pack(pop)
```

| Offset | Field Name | Data Type | Size | Endianness | Scale Factor / Physical Range |
|---|---|---|---|---|---|
| `+0x00` | `sensor_time` | `uint32_t` | 4 Bytes | Little-Endian | 24-bit hardware ODR timer ($1\,\text{tick} = 39.0625\,\mu\text{s}$) |
| `+0x04` | `accel[0]` | `int16_t` | 2 Bytes | Little-Endian | Accel X: $\pm 16\,\text{g}$ ($1\,\text{LSB} = \frac{16}{32768}\,\text{g}$) |
| `+0x06` | `accel[1]` | `int16_t` | 2 Bytes | Little-Endian | Accel Y: $\pm 16\,\text{g}$ ($1\,\text{LSB} = \frac{16}{32768}\,\text{g}$) |
| `+0x08` | `accel[2]` | `int16_t` | 2 Bytes | Little-Endian | Accel Z: $\pm 16\,\text{g}$ ($1\,\text{LSB} = \frac{16}{32768}\,\text{g}$) |
| `+0x0A` | `gyro[0]` | `int16_t` | 2 Bytes | Little-Endian | Gyro X: $\pm 2000^\circ/\text{s}$ ($1\,\text{LSB} = \frac{2000}{32768}^\circ/\text{s}$) |
| `+0x0C` | `gyro[1]` | `int16_t` | 2 Bytes | Little-Endian | Gyro Y: $\pm 2000^\circ/\text{s}$ ($1\,\text{LSB} = \frac{2000}{32768}^\circ/\text{s}$) |
| `+0x0E` | `gyro[2]` | `int16_t` | 2 Bytes | Little-Endian | Gyro Z: $\pm 2000^\circ/\text{s}$ ($1\,\text{LSB} = \frac{2000}{32768}^\circ/\text{s}$) |
| `+0x10` | `sync_marker` | `uint16_t` | 2 Bytes | Little-Endian | Non-zero when a BLE/external sync event fires |
| `+0x12` | `label_marker`| `uint16_t` | 2 Bytes | Little-Endian | **Continuous Sequence ID** ($0, 1, 2, \dots, 65535, 0$) |

> **Note on Sample Integrity:** The `label_marker` increments by 1 on every acquired sample. If an SD write stall causes a buffer drop, post-processing scripts ([`tools/bin_to_csv.py`](file:///c:/Users/jdrat/OneDrive/Documents/Desktop/arc%20sense%20firmware/tools/bin_to_csv.py)) immediately detect and report the exact number and timestamp of missed samples.

---

## 2. Sample Rate & Dual-Rate DSP Pipeline

The system operates on an asymmetric dual-rate architecture:

1. **Hardware Acquisition & SD Logging (400 Hz):**
   - The Bosch BMI270 FIFO is configured to `BMI2_ACC_ODR_400_HZ` and `BMI2_GYR_ODR_400_HZ`.
   - The `SensorThread` (RTOS High Priority, 400 Hz interrupt/polling) drains samples into the lock-free ring buffer.
   - Every raw sample is queued directly into [`sd_logger_log_sample()`](file:///c:/Users/jdrat/OneDrive/Documents/Desktop/arc%20sense%20firmware/arc_sense_main/sd_logger.cpp#L196) at full 400 Hz resolution.
2. **Deterministic Gait State Machine & Freeze Index (100 Hz Decimation):**
   - The DSP engine decimates samples 4:1 into 100 Hz blocks for the Rampp et al. temporal state machine and the 256-sample Freeze Index FFT.
3. **400 Hz Peak Tibial Shock Preservation:**
   - To prevent 100 Hz boxcar averaging from attenuating sharp 2.5 ms heel strike landing spikes (~12% attenuation), the decimation block computes the **true 400 Hz peak resultant magnitude** across the 4 samples:
     $$\text{rawMag} = \sqrt{a_x^2 + a_y^2 + a_z^2}$$
   - This peak is passed into `gait_dsp_process_sample(accum, s_rawDecimatePeakMag)` and stored in `s_rawPeakHist`, giving clinical-grade tibial shock readings without high-frequency loss.

---

## 3. Dynamic Range & Physical Scaling Factors

The firmware bypasses the default Arduino library limits ($\pm 4\,\text{g}$) and invokes the Bosch API directly:

### 3.1 Accelerometer Range: $\pm 16\,\text{g}$
* **Register Configuration:** `acc_cfg.range = BMI2_ACC_RANGE_16G`
* **Raw Range:** $-32768 \dots +32767$ LSB
* **Scale Factor:**
  $$\text{Scale}_{\text{accel}} = \frac{16.0\,\text{g}}{32768\,\text{LSB}} = \frac{1.0}{2048.0}\,\text{g/LSB} \approx 0.00048828125\,\text{g/LSB}$$
* **Conversion Formula:**
  $$\text{Acceleration (g)} = \text{raw\_value} \times 0.00048828125$$
* **Clinical Rationale:** Peak tibial shocks during overground heel strikes frequently exceed $3.5\,\text{g}$ to $5.5\,\text{g}$. A $\pm 4\,\text{g}$ range severely clips impact peaks. $\pm 16\,\text{g}$ ensures clean, non-saturated waveform capture.

### 3.2 Gyroscope Range: $\pm 2000^\circ/\text{s}$
* **Register Configuration:** `gyr_cfg.range = BMI2_GYR_RANGE_2000`
* **Raw Range:** $-32768 \dots +32767$ LSB
* **Scale Factor:**
  $$\text{Scale}_{\text{gyro}} = \frac{2000.0^\circ/\text{s}}{32768\,\text{LSB}} \approx 0.06103515625\,(^\circ/\text{s})/\text{LSB}$$
* **Conversion Formula:**
  $$\text{Angular Rate (}^\circ/\text{s)} = \text{raw\_value} \times 0.06103515625$$

---

## 4. Anatomical Axis Orientation on the Ankle

When worn on the lateral shank (secured just above the lateral malleolus):

```
       [ Up: Superior (+Y) ]
                 ^
                 |   / Forward: Anterior (+X)
                 |  /
                 | /
          [ ARC SENSE ] ---> Lateral (+Z)
                 |
                 v
      [ Down: Inferior (-Y) ]
```

| Physical Axis | Anatomical Plane | Direction | Quiet Stance Value | Walking Dynamics |
|---|---|---|---|---|
| **X Axis** | Anterior–Posterior (AP) | Points horizontally **Forward** along the walking path | $\approx 0.0\,\text{g}$ | Accelerates forward during swing phase |
| **Y Axis** | Superior–Inferior (SI) | Points **Vertically along the tibia/shank** | $\approx +1.0\,\text{g}$ (Gravity) | Senses vertical shock impacts at heel strike |
| **Z Axis** | Medio–Lateral (ML) | Points **Laterally (outward)** normal to sagittal plane | $\approx 0.0\,\text{g}$ | Lateral sway and stance stability |

### Gyroscope Sagittal Axis Mapping:
* **Sagittal Rotation Axis:** Gyro Z measures rotation in the sagittal plane.
* **Sign Convention:** Scaled by `GYRO_SAGITTAL_SIGN = -1.0f`. With this polarity, **forward leg swing produces a positive angular velocity peak** ($+150^\circ/\text{s}$ to $+300^\circ/\text{s}$), allowing standard peak detection algorithms to isolate Mid-Swing.

---

## 5. Data Logging Destinations (MicroSD vs. BLE)

Data is **not** exclusive to BLE; complete audit trails are permanently stored on the MicroSD card:

```
[ Sensor Acquisition (400 Hz) ]
               |
        +------+------+
        |             |
        v             v
[ MicroSD Card ]    [ Real-Time DSP Engine ]
 - I_<R>_NNNN.BIN     - Event Detection
                      - Gait Features
                      - Freeze Index
                             |
                      +------+------+
                      |             |
                      v             v
             [ MicroSD Card ]    [ BLE 5.0 Broadcast ]
              - E_<R>_NNNN.CSV    - 20-byte Telemetry
              - S_<R>_NNNN.CSV    - Haptic Alert Char
                                  - Command Receiver
```

### Destination Breakdown Matrix:

| Data Entity | Saved to MicroSD? | Sent over BLE? | Details & Schema |
|---|---|---|---|
| **Raw IMU Samples** | **YES** (`I_*.BIN`) | Configurable | Full 400 Hz raw binary streams to SD; optional 12-byte diagnostic live stream over BLE. |
| **Gait Events (`GaitEvent`)** | **YES** (`E_*.CSV`) | Internal Trigger | Logged to CSV with columns: `session_us`, `timestamp_us`, `sampleIndex`, `eventType` (`MID_SWING`, `TOE_OFF`, `HEEL_STRIKE`, `MID_STANCE`). Triggers real-time haptic alerts. |
| **Stride Metrics (`StrideParameters`)** | **YES** (`S_*.CSV`) | **YES** (Every Stride) | Logged to CSV with 12 clinical columns. Transmitted over BLE GATT in a compact 20-byte packet. |
| **Freezing of Gait (`FreezeIndex`)** | **YES** (`S_*.CSV`) | **YES** (Every Stride) | Computed via CMSIS-DSP 256-point RFFT. Stored in stride CSV and broadcast in telemetry. |
| **Edge AI Predictions** | **YES** (`S_*.CSV`) | **YES** | Reserved columns in CSV (`edgeai_label`, `edgeai_confidence`); broadcast over BLE. |

#### Stride CSV Format (`S_<ROLE>_NNNN.CSV`):
```csv
session_us,timestamp_us,sampleIndex,strideTimeS,swingTimeS,stanceTimeS,strideLengthM,tibialShockG,asymmetryIndex,freezeIndex,edgeai_label,edgeai_confidence
```

#### BLE Telemetry Packet Format (20 Bytes):
```cpp
struct BleGaitTelemetryPacket {
    uint16_t strideCount;        // Incremental stride counter
    uint8_t  cadenceSpm;         // Steps per minute
    uint16_t strideLengthCm;     // Stride length (cm)
    uint16_t strideTimeMs;       // Stride time (ms)
    uint16_t swingTimeMs;        // Swing duration (ms)
    uint16_t stanceTimeMs;       // Stance duration (ms)
    uint16_t tibialShockCg;      // Peak shock in centi-g (g * 100)
    uint16_t asymmetryPercent;   // Asymmetry percentage * 10
    uint16_t freezeIndexInt;     // Freeze Index * 100
    uint8_t  batteryPct;         // Battery level (0..100%)
    uint8_t  systemStatus;       // Status flags / haptic states
};
```

---

## 6. Bilateral Time Synchronization (Left vs. Right Ankle)

Because the Left and Right ankles run on independent physical nRF52840 crystals with natural clock drift ($\sim 20\text{ ppm}$, or $\sim 20\,\mu\text{s/s}$), they cannot rely purely on relative uptime.

### Recommended & Supported Solution: Mobile Master Clock Sync

The phone application acts as the common timing master:

```
                      +-------------------+
                      | Smartphone / App  |
                      | (Master Clock t0) |
                      +---------+---------+
                                |
             +------------------+------------------+
             | BLE Sync Packet                     | BLE Sync Packet
             v                                     v
    +-----------------+                   +-----------------+
    |   Left Ankle    |                   |   Right Ankle   |
    |  (ArcSense-L)   |                   |  (ArcSense-R)   |
    +--------+--------+                   +--------+--------+
             |                                     |
             v                                     v
    `rec.sync_marker`                     `rec.sync_marker`
    stamped in I_L_*.BIN                  stamped in I_R_*.BIN
```

### Synchronization Workflow:
1. **Connection:** The smartphone app establishes simultaneous BLE connections to both `ArcSense-L` and `ArcSense-R`.
2. **Sync Command:** At the start of a trial (or periodically every 60 seconds), the mobile app writes a unified 16-bit transaction ID (e.g., `0xAA01`) to the BLE Command Characteristic on both devices nearly simultaneously (jitter $< 2\,\text{ms}$).
3. **Hardware Stamping:** The firmware's BLE handler receives the transaction ID and calls:
   ```cpp
   sd_logger_set_sync_marker(transactionId);
   ```
   On the very next 400 Hz IMU sample written to the microSD card, `rec.sync_marker` is stamped with `0xAA01` and then cleared back to 0.
4. **Post-Processing Alignment:**
   In Python, alignment between the two ankles is computed by locating the exact record where `sync_marker == 0xAA01`:
   $$\Delta t_{\text{offset}} = t_{\text{sample}}(\text{Right}) - t_{\text{sample}}(\text{Left})$$
   Applying this offset aligns Left and Right timebases to **sub-millisecond accuracy**, allowing exact bilateral gait asymmetry computation:
   $$\text{Asymmetry Index} = \frac{|T_{\text{stride, Left}} - T_{\text{stride, Right}}|}{0.5 \times (T_{\text{stride, Left}} + T_{\text{stride, Right}})} \times 100\%$$
