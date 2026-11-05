# ARC SENSE app (React Native / Expo)

The app needs a development build because `react-native-ble-plx` contains native code, so it won't run in Expo Go.

```bash
npm ci
npm run gen:shared       # regenerate src/shared/generated after editing /shared/*.json
npm run verify           # codegen check, tsc, eslint, prettier, jest with coverage thresholds
npx expo run:android     # local Android dev build (needs JDK 17 and the Android SDK)
```

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Expo Router screens (routes only). |
| `src/shared/generated/` | Generated from `/shared`. Do not edit by hand. |
| `src/ble/` | Codec, transport interface, react-native-ble-plx transport, mock/replay transport. |
| `src/services/` | Device manager, stride assembler, sync, labels, session recorder, alerts. All plain TypeScript with the clock and transport passed in, so everything can be tested in Jest. |
| `scripts/` | Code generation from `/shared`. |
