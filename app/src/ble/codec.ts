/**
 * Binary codec for ArcSense GATT values (all little-endian, as written by the
 * nRF52840 / ArduinoBLE firmware) and the base64 transport encoding used by
 * react-native-ble-plx.
 *
 * Decoders are strict about length: a value of the wrong size is a protocol
 * error, never silently padded or truncated.
 */
import { NO_INFERENCE_LABEL, CLASS_NAMES } from '@/shared/generated/features';
import { TELEMETRY_PACKET } from '@/shared/generated/gatt';

export type ValueType = 'u8' | 'i8' | 'u16' | 'u32' | 'f32';

export const TYPE_SIZE: Readonly<Record<ValueType, number>> = {
  u8: 1,
  i8: 1,
  u16: 2,
  u32: 4,
  f32: 4,
};

export class CodecError extends Error {
  override name = 'CodecError';
}

// ---------------------------------------------------------------------------
// base64 (RFC 4648, standard alphabet, padded)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0)
    throw new CodecError(`base64 length ${text.length} not a multiple of 4`);
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = text.charCodeAt(i + j);
      const isPad = c === 61 /* '=' */ && i + j >= text.length - pad;
      const v = isPad ? 0 : c < 128 ? B64_INDEX[c]! : -1;
      if (v < 0) throw new CodecError(`invalid base64 character at ${i + j}`);
      n = (n << 6) | v;
    }
    out[o++] = (n >> 16) & 255; // every 4-char group yields at least one byte
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// scalar values

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function decodeValue(type: ValueType, bytes: Uint8Array): number {
  const size = TYPE_SIZE[type];
  if (bytes.length !== size) {
    throw new CodecError(`${type} expects ${size} byte(s), got ${bytes.length}`);
  }
  const v = view(bytes);
  switch (type) {
    case 'u8':
      return v.getUint8(0);
    case 'i8':
      return v.getInt8(0);
    case 'u16':
      return v.getUint16(0, true);
    case 'u32':
      return v.getUint32(0, true);
    case 'f32':
      return v.getFloat32(0, true);
  }
}

const INT_RANGE: Readonly<Record<Exclude<ValueType, 'f32'>, [number, number]>> = {
  u8: [0, 0xff],
  i8: [-128, 127],
  u16: [0, 0xffff],
  u32: [0, 0xffffffff],
};

export function encodeValue(type: ValueType, value: number): Uint8Array {
  const out = new Uint8Array(TYPE_SIZE[type]);
  const v = view(out);
  if (type === 'f32') {
    if (!Number.isFinite(value)) throw new CodecError(`f32 value must be finite, got ${value}`);
    v.setFloat32(0, value, true);
    return out;
  }
  const [lo, hi] = INT_RANGE[type];
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new CodecError(`${type} value out of range [${lo}, ${hi}]: ${value}`);
  }
  switch (type) {
    case 'u8':
      v.setUint8(0, value);
      break;
    case 'i8':
      v.setInt8(0, value);
      break;
    case 'u16':
      v.setUint16(0, value, true);
      break;
    case 'u32':
      v.setUint32(0, value, true);
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// domain-specific decoders

/**
 * AI label: one byte. `0xFF` (declared int8, so also -1) means "no inference".
 * Anything else outside the class range is a protocol error.
 */
export function decodeAiLabel(bytes: Uint8Array): number | null {
  const raw = decodeValue('u8', bytes);
  if (raw === NO_INFERENCE_LABEL) return null;
  if (raw >= CLASS_NAMES.length) {
    throw new CodecError(`AI label ${raw} outside class range 0..${CLASS_NAMES.length - 1}`);
  }
  return raw;
}

export interface TelemetryFrame {
  strideCount: number;
  cadenceSpm: number;
  strideLengthM: number;
  strideTimeS: number;
  swingTimeS: number;
  stanceTimeS: number;
  tibialShockG: number;
  asymmetryFraction: number;
  freezeIndex: number;
  batteryPct: number;
  systemStatus: number;
}

/**
 * `BleGaitTelemetryPacket` (firmware spec section 5). The spec states 20 bytes,
 * matching natural C alignment; a 19-byte `#pragma pack(1)` variant is also
 * accepted. Layout is generated from /shared/gatt_spec.json.
 */
export function decodeTelemetryPacket(bytes: Uint8Array): TelemetryFrame {
  let offsetKey: 'alignedOffset' | 'packedOffset';
  if (bytes.length === TELEMETRY_PACKET.alignedSize) offsetKey = 'alignedOffset';
  else if (bytes.length === TELEMETRY_PACKET.packedSize) offsetKey = 'packedOffset';
  else {
    throw new CodecError(
      `telemetry packet must be ${TELEMETRY_PACKET.alignedSize} or ${TELEMETRY_PACKET.packedSize} bytes, got ${bytes.length}`,
    );
  }
  const out: Record<string, number> = {};
  for (const f of TELEMETRY_PACKET.fields) {
    const size = TYPE_SIZE[f.type];
    const off = f[offsetKey];
    const raw = decodeValue(f.type, bytes.subarray(off, off + size));
    const outKey = 'to' in f ? f.to : f.key;
    // Divide by the integer reciprocal so that e.g. 1305 ms -> 1.305 s exactly
    // (1305 * 0.001 would give 1.3050000000000002).
    out[outKey] = f.scale < 1 ? raw / Math.round(1 / f.scale) : raw * f.scale;
  }
  return out as unknown as TelemetryFrame;
}
