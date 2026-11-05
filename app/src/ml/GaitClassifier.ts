/**
 * Per-stride classification on the phone (F42, F43).
 * Freezing follows the brief (section 7.4): the Freeze Index rule overrides
 * the model, using the same consecutive-stride logic as the alert engine.
 */
import type { Side } from '@/ble/gatt';
import { CLASS_NAMES } from '@/shared/generated/features';
import type { AlertEngine } from '@/services/AlertEngine';
import type { Stride } from '@/services/StrideAssembler';

import { strideFeatureVector } from './features';
import type { Mlp } from './Mlp';

export const FREEZING = CLASS_NAMES.indexOf('Freezing');

export interface Classification {
  side: Side;
  t: number;
  label: number;
  confidence: number;
  source: 'model' | 'fi-override';
  /** The firmware's own EdgeAI label for the same stride, if it sent one. */
  firmwareLabel: number | null;
}

export class GaitClassifier {
  constructor(
    private readonly model: Mlp | null,
    private readonly alerts: AlertEngine,
  ) {}

  /** Classify a stride; call after the AlertEngine has seen it. */
  classify(stride: Stride): Classification | null {
    const base = { side: stride.side, t: stride.t, firmwareLabel: stride.aiLabel };
    if (this.alerts.isActive('freezing', stride.side)) {
      return { ...base, label: FREEZING, confidence: 1, source: 'fi-override' };
    }
    if (!this.model) return null;
    const x = strideFeatureVector(stride);
    if (!x) return null;
    const p = this.model.predict(x);
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
    return { ...base, label: best, confidence: p[best]!, source: 'model' };
  }
}

/** Fraction of strides where the phone and the firmware agree (both present). */
export function agreement(results: readonly Classification[]): number | null {
  const both = results.filter((r) => r.firmwareLabel !== null);
  if (!both.length) return null;
  return both.filter((r) => r.firmwareLabel === r.label).length / both.length;
}
