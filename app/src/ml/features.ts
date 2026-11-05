/**
 * Classifier input vector (F41): TypeScript twin of ml/arcsense_ml/features.py.
 * Order comes from the generated FEATURE_KEYS; a parity test compares this
 * against shared/fixtures/features_0007.json produced by the Python code.
 */
import { FEATURE_KEYS } from '@/shared/generated/features';

import type { Stride } from '@/services/StrideAssembler';

export const MIN_STRIDE_S = 0.2;
export const MAX_STRIDE_S = 5.0;

export interface StrideInputs {
  strideTimeS: number;
  swingTimeS: number;
  stanceTimeS: number;
  strideLengthM: number;
  tibialShockG: number;
  asymmetryIndex: number;
  freezeIndex: number;
}

/** Feature vector in model input order, or null when the stride is not classifiable. */
export function featureVector(x: StrideInputs): Float32Array | null {
  const st = x.strideTimeS;
  const values: Record<(typeof FEATURE_KEYS)[number], number> = {
    strideTimeS: st,
    swingTimeS: x.swingTimeS,
    stanceTimeS: x.stanceTimeS,
    strideLengthM: x.strideLengthM,
    tibialShockG: x.tibialShockG,
    asymmetryIndex: x.asymmetryIndex,
    freezeIndex: x.freezeIndex,
    cadenceSpm: 120 / st,
    swingRatio: x.swingTimeS / st,
    stanceRatio: x.stanceTimeS / st,
  };
  const out = new Float32Array(FEATURE_KEYS.length);
  for (let i = 0; i < FEATURE_KEYS.length; i++) {
    const v = values[FEATURE_KEYS[i]!];
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  if (st < MIN_STRIDE_S || st > MAX_STRIDE_S || !(x.strideLengthM > 0)) return null;
  return out;
}

/** From an assembled stride (all seven firmware values must be present). */
export function strideFeatureVector(s: Stride): Float32Array | null {
  const v = s.values;
  if (
    v.strideTime === undefined ||
    v.swingTime === undefined ||
    v.stanceTime === undefined ||
    v.strideLength === undefined ||
    v.tibialShock === undefined ||
    v.asymmetryIndex === undefined ||
    v.freezeIndex === undefined
  ) {
    return null;
  }
  return featureVector({
    strideTimeS: v.strideTime,
    swingTimeS: v.swingTime,
    stanceTimeS: v.stanceTime,
    strideLengthM: v.strideLength,
    tibialShockG: v.tibialShock,
    asymmetryIndex: v.asymmetryIndex,
    freezeIndex: v.freezeIndex,
  });
}
