/**
 * Stride sources for MockTransport: the real session 0007 recording (left
 * ankle) and a synthetic right ankle derived from it.
 */
import { REPLAY_0007_COLUMNS, REPLAY_0007_ROWS } from '@/shared/generated/replay0007';

/** Firmware per-stride values, units as in S_*.CSV. */
export interface StrideValues {
  strideTimeS: number;
  swingTimeS: number;
  stanceTimeS: number;
  strideLengthM: number;
  tibialShockG: number;
  /** Fraction (0..1), as the firmware stores it (FINDINGS F-02). */
  asymmetryIndex: number;
  freezeIndex: number;
}

export interface ReplayStride extends StrideValues {
  /** AI label class index or null (no inference). */
  aiLabel: number | null;
  aiConfidence: number;
}

export function session0007(): ReplayStride[] {
  const col = (name: (typeof REPLAY_0007_COLUMNS)[number]) => REPLAY_0007_COLUMNS.indexOf(name);
  return REPLAY_0007_ROWS.map((r) => ({
    strideTimeS: r[col('strideTimeS')]!,
    swingTimeS: r[col('swingTimeS')]!,
    stanceTimeS: r[col('stanceTimeS')]!,
    strideLengthM: r[col('strideLengthM')]!,
    tibialShockG: r[col('tibialShockG')]!,
    asymmetryIndex: r[col('asymmetryIndex')]!,
    freezeIndex: r[col('freezeIndex')]!,
    aiLabel: null,
    aiConfidence: 0,
  }));
}

export interface MirrorOptions {
  /** Relative change applied to the right side's swing time (e.g. 0.05 = +5 %). */
  swingAsymmetry: number;
  /** Relative change applied to the right side's stride length. */
  lengthAsymmetry: number;
}

/**
 * Synthetic contralateral side: same stride timing (both feet share cadence),
 * with swing/stance and length perturbed by the given asymmetry. Stance is
 * adjusted so swing + stance still equals the stride time.
 */
export function mirrorSide(
  strides: readonly ReplayStride[],
  { swingAsymmetry, lengthAsymmetry }: MirrorOptions,
): ReplayStride[] {
  return strides.map((s) => {
    const swing = s.swingTimeS * (1 + swingAsymmetry);
    return {
      ...s,
      swingTimeS: swing,
      stanceTimeS: s.strideTimeS - swing,
      strideLengthM: s.strideLengthM * (1 + lengthAsymmetry),
    };
  });
}
