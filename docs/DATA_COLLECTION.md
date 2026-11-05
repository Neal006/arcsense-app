# Data collection runbook

This is the procedure for recording labelled bilateral gait sessions with the ARC SENSE app. Every step exists so that the session can later be aligned and labelled automatically. Skipping one usually makes the session unusable for training.

## Before the first session (once)

1. **Firmware.** Confirm the following with the firmware owner. Open items are listed in `docs/FINDINGS.md`.
   - Which BLE mode the build uses. `DATA_COLLECTION` is fine: the app only needs to write markers.
   - Writes to the Sync Marker (`0x0011`) are stamped into the BIN `sync_marker` field. Without this, the two ankles cannot be aligned.
   - What writing Session Start (`0x000C`) does (F-13).
   - The SD logging gaps (F-14) are understood. Run `arcsense-qa` on a 5-minute test recording first.
2. **Label catalogue.** Agree `shared/label_catalog.json` with the trial team. IDs are permanent: you can add new ones, but never renumber existing ones.
3. **Install** the release APK on the trial phone. Check the Debug tab shows "Mode: Bluetooth".

## Each session

| Step | On the phone | Why |
|---|---|---|
| 1 | Power both ankles. On **Connect**, tap Scan, then Connect both. Both cards should show *Connected* and the expected firmware mode. | The app checks each device's role, so swapped straps show up immediately. |
| 2 | On **Session**, enter the subject **code** (never a name), the condition, the operator, and the affected side if it applies. Tap Start. | Start writes Session Start and the first sync token (`0xAA01`) to both ankles. |
| 3 | Tap **Start <trial>** at the start of each walk and **End <trial>** at the end. Tap FoG start/end, Turn, Sit and so on as they happen. | These taps are the ground truth. Anything not labelled is excluded from training. |
| 4 | If you tap the wrong button, tap **Void** straight away. | A label can't be removed from the SD card, so it is flagged as void instead. |
| 5 | Keep the phone within about 5 m of the subject. A *Reconnecting* badge is fine: the app resyncs automatically when the link returns. | Each reconnect sends a fresh sync token. |
| 6 | Tap **Stop**. Any open episodes are closed automatically, and the summary shows how many were. | A final token is sent. |
| 7 | Tap **Export** and save the zip to the session folder. | The export contains the phone-side record: tokens, labels, notes and connection events. |

If the app is killed during a session, reopen it, reconnect both ankles, and tap **Resume**. The token sequence and labels continue in the same session.

## After the session

Copy the following into one folder per session, for example `sessions/P014_2026-11-12_1/`:

```
I_L_NNNN.BIN  E_L_NNNN.CSV  S_L_NNNN.CSV      (left SD card)
I_R_NNNN.BIN  E_R_NNNN.CSV  S_R_NNNN.CSV      (right SD card)
P014_20261112-101500Z_ab12.zip                (app export)
```

Then run:

```bash
cd ml
uv run arcsense-qa ../sessions/P014_2026-11-12_1 --out ../sessions/P014_2026-11-12_1/QA.md
```

- **PASS:** the session is usable.
- **WARN:** read the report. Common causes: a token was sent while one ankle was reconnecting, an episode was auto-closed, or there was an SD gap.
- **FAIL:** do not train on the session. The usual cause is no sync tokens in a BIN file, meaning the firmware didn't stamp them.

Record in the session folder whether the subject **has** the condition or a healthy volunteer was **imitating** it. The training report keeps the two separate (`provenance`).
