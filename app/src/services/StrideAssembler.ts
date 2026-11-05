/**
 * Groups the per-characteristic gait notifications of one ankle into whole
 * strides (functionality F16). The firmware notifies each value separately
 * and the order is not specified (FINDINGS D9 / F-08), so a stride is
 * committed when:
 *   - a value arrives for a field already filled in the pending stride (the
 *     next stride has started), or
 *   - `commitAfterMs` has passed since the pending stride's first value.
 * Gaps in the firmware stride counter are counted as missed strides.
 */
import { CodecError, decodeAiLabel, decodeValue } from '@/ble/codec';
import { charSpec, type CharKey, type Side } from '@/ble/gatt';
import type { Clock, TimerHandle } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';

export const GAIT_FIELDS = [
  'strideTime',
  'swingTime',
  'stanceTime',
  'strideLength',
  'tibialShock',
  'asymmetryIndex',
  'freezeIndex',
] as const;
export type GaitField = (typeof GAIT_FIELDS)[number];

export interface Stride {
  side: Side;
  /** Firmware stride counter, if the characteristic is available. */
  strideCount: number | null;
  /** Phone monotonic ms when the first value of this stride arrived. */
  t: number;
  values: Partial<Record<GaitField, number>>;
  aiLabel: number | null;
  aiConfidence: number | null;
  /** Gait fields that never arrived or were not finite. */
  missing: GaitField[];
  cadenceSpm: number | null;
  swingPct: number | null;
  stancePct: number | null;
}

export const ASSEMBLED_KEYS: readonly CharKey[] = [
  ...GAIT_FIELDS,
  'strideCount',
  'aiLabel',
  'aiConfidence',
];

interface Pending {
  t: number;
  values: Partial<Record<GaitField, number>>;
  strideCount: number | null;
  aiLabel: number | null | undefined;
  aiConfidence: number | null;
  seen: Set<CharKey>;
}

interface AssemblerEvents extends Record<string, unknown> {
  stride: Stride;
  malformed: { key: CharKey; error: string };
}

export function derive(values: Partial<Record<GaitField, number>>) {
  const st = values.strideTime;
  const ok = st !== undefined && st > 0;
  return {
    cadenceSpm: ok ? 120 / st : null,
    swingPct: ok && values.swingTime !== undefined ? (100 * values.swingTime) / st : null,
    stancePct: ok && values.stanceTime !== undefined ? (100 * values.stanceTime) / st : null,
  };
}

export class StrideAssembler {
  private readonly emitter = new Emitter<AssemblerEvents>();
  private pending: Pending | null = null;
  private timer: TimerHandle | null = null;
  private lastCount: number | null = null;
  private missed = 0;
  private malformedCount = 0;
  private committed = 0;

  constructor(
    readonly side: Side,
    private readonly clock: Clock,
    private readonly commitAfterMs = 300,
  ) {}

  on<K extends keyof AssemblerEvents>(e: K, fn: (p: AssemblerEvents[K]) => void): Unsubscribe {
    return this.emitter.on(e, fn);
  }

  stats() {
    return {
      committed: this.committed,
      missedStrides: this.missed,
      malformed: this.malformedCount,
    };
  }

  push(key: CharKey, bytes: Uint8Array): void {
    let value: number | null;
    try {
      value = key === 'aiLabel' ? decodeAiLabel(bytes) : decodeValue(charSpec(key).type, bytes);
    } catch (e) {
      this.malformedCount++;
      this.emitter.emit('malformed', {
        key,
        error: e instanceof CodecError ? e.message : String(e),
      });
      return;
    }
    if (this.pending?.seen.has(key)) this.commit();
    if (!this.pending) {
      this.pending = {
        t: this.clock.now(),
        values: {},
        strideCount: null,
        aiLabel: undefined,
        aiConfidence: null,
        seen: new Set(),
      };
      this.timer = this.clock.setTimeout(() => this.commit(), this.commitAfterMs);
    }
    const p = this.pending;
    p.seen.add(key);
    if (key === 'strideCount') p.strideCount = value;
    else if (key === 'aiLabel') p.aiLabel = value;
    else if (key === 'aiConfidence') p.aiConfidence = value;
    else if ((GAIT_FIELDS as readonly string[]).includes(key))
      p.values[key as GaitField] = value as number;
  }

  /** Commit the pending stride now (e.g. on disconnect). */
  flush(): void {
    this.commit();
  }

  private commit(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    if (p.strideCount !== null && this.lastCount !== null) {
      const gap = p.strideCount - this.lastCount - 1;
      if (gap > 0) this.missed += gap;
    }
    if (p.strideCount !== null) this.lastCount = p.strideCount;
    const values: Partial<Record<GaitField, number>> = {};
    const missing: GaitField[] = [];
    for (const f of GAIT_FIELDS) {
      const v = p.values[f];
      if (v === undefined || !Number.isFinite(v)) missing.push(f);
      else values[f] = v;
    }
    // first stride after boot has no length yet (FINDINGS F-04)
    if (values.strideLength === 0) {
      delete values.strideLength;
      missing.push('strideLength');
    }
    this.committed++;
    this.emitter.emit('stride', {
      side: this.side,
      strideCount: p.strideCount,
      t: p.t,
      values,
      aiLabel: p.aiLabel ?? null,
      aiConfidence: p.aiLabel === null || p.aiLabel === undefined ? null : p.aiConfidence,
      missing,
      ...derive(values),
    });
  }

  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
