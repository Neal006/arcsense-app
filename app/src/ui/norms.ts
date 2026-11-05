/**
 * Display ranges. Normative bands from the session 0007 report's reference
 * table (Perry & Burnfield; Hausdorff); scale maxima chosen to contain the
 * observed 0007 values (FINDINGS F-04: the brief's ranges were wrong).
 */
export interface Norm {
  label: string;
  unit: string;
  lo: number;
  hi: number;
  scaleMax: number;
  digits: number;
}

export const NORMS = {
  strideTimeS: { label: 'Stride time', unit: 's', lo: 1.0, hi: 1.4, scaleMax: 2.5, digits: 2 },
  strideLengthM: { label: 'Stride length', unit: 'm', lo: 0.9, hi: 1.3, scaleMax: 2.0, digits: 2 },
  tibialShockG: { label: 'Tibial shock', unit: 'g', lo: 2.5, hi: 4.5, scaleMax: 8.0, digits: 1 },
  swingPct: { label: 'Swing', unit: '%', lo: 35, hi: 40, scaleMax: 100, digits: 0 },
  stancePct: { label: 'Stance', unit: '%', lo: 60, hi: 65, scaleMax: 100, digits: 0 },
  cadenceSpm: { label: 'Cadence', unit: 'spm', lo: 90, hi: 115, scaleMax: 160, digits: 0 },
  freezeIndex: { label: 'Freeze index', unit: '', lo: 0, hi: 1.5, scaleMax: 6, digits: 2 },
  asymmetryPct: { label: 'Asymmetry', unit: '%', lo: 0, hi: 10, scaleMax: 40, digits: 1 },
} as const satisfies Record<string, Norm>;

export type NormKey = keyof typeof NORMS;

export function inNorm(key: NormKey, v: number): boolean {
  const n = NORMS[key];
  return v >= n.lo && v <= n.hi;
}

export function fraction(key: NormKey, v: number): number {
  return Math.max(0, Math.min(1, v / NORMS[key].scaleMax));
}
