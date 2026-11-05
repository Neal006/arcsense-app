/**
 * Clinical alerts from assembled strides (functionality F36).
 *
 *  - freezing: Freeze Index >= threshold on N consecutive strides of one ankle
 *    (defaults 3.0 and 2; FINDINGS F-01: a single-stride FI >= 2.0 rule fires on
 *    44 % of healthy strides in session 0007). Clears after N consecutive strides
 *    below the threshold.
 *  - preFreeze: latest FI in [preFreezeLow, threshold) while not freezing.
 *  - asymmetry: asymmetry above the limit (percent); clears 2 points below it.
 *  - shuffling / limping: the firmware EdgeAI class for the latest stride.
 * Every alert episode (start, end, peak) is reported when it closes.
 */
import type { Side } from '@/ble/gatt';
import type { Clock } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';
import { FREEZE_OVERRIDE_DEFAULTS } from '@/shared/generated/features';

import type { Stride } from './StrideAssembler';

export interface AlertSettings {
  fiThreshold: number;
  fiConsecutive: number;
  preFreezeLow: number;
  asymmetryPct: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  fiThreshold: FREEZE_OVERRIDE_DEFAULTS.threshold,
  fiConsecutive: FREEZE_OVERRIDE_DEFAULTS.consecutiveStrides,
  preFreezeLow: 1.5,
  asymmetryPct: 15,
};

export const ASYMMETRY_HYSTERESIS_PCT = 2;

export type AlertKind = 'freezing' | 'preFreeze' | 'asymmetry' | 'shuffling' | 'limping';

export interface ActiveAlert {
  kind: AlertKind;
  side: Side;
  since: number;
  peak: number;
}

export interface AlertEpisode extends ActiveAlert {
  until: number;
}

interface SideState {
  above: number;
  below: number;
}

interface AlertEvents extends Record<string, unknown> {
  changed: readonly ActiveAlert[];
  episode: AlertEpisode;
}

const AI_KIND: Record<number, AlertKind | undefined> = { 2: 'shuffling', 3: 'limping' };

export function validateAlertSettings(s: AlertSettings): string[] {
  const e: string[] = [];
  if (!(s.fiThreshold > 0)) e.push('Freeze threshold must be positive.');
  if (!Number.isInteger(s.fiConsecutive) || s.fiConsecutive < 1)
    e.push('Consecutive strides must be a whole number >= 1.');
  if (!(s.preFreezeLow >= 0 && s.preFreezeLow < s.fiThreshold))
    e.push('Pre-freeze level must be below the freeze threshold.');
  if (!(s.asymmetryPct > ASYMMETRY_HYSTERESIS_PCT))
    e.push(`Asymmetry limit must exceed ${ASYMMETRY_HYSTERESIS_PCT} %.`);
  return e;
}

export class AlertEngine {
  private readonly emitter = new Emitter<AlertEvents>();
  private readonly active = new Map<string, ActiveAlert>();
  private readonly fi: Record<Side, SideState> = {
    L: { above: 0, below: 0 },
    R: { above: 0, below: 0 },
  };
  private settings: AlertSettings;

  constructor(
    private readonly clock: Clock,
    settings: AlertSettings = DEFAULT_ALERT_SETTINGS,
  ) {
    const errors = validateAlertSettings(settings);
    if (errors.length) throw new RangeError(errors.join(' '));
    this.settings = { ...settings };
  }

  on<K extends keyof AlertEvents>(e: K, fn: (p: AlertEvents[K]) => void): Unsubscribe {
    return this.emitter.on(e, fn);
  }

  getActive(): ActiveAlert[] {
    return [...this.active.values()];
  }

  isActive(kind: AlertKind, side: Side): boolean {
    return this.active.has(`${kind}:${side}`);
  }

  updateSettings(s: AlertSettings): void {
    const errors = validateAlertSettings(s);
    if (errors.length) throw new RangeError(errors.join(' '));
    this.settings = { ...s };
  }

  /**
   * Feed one stride. `asymmetryPct` overrides the firmware value (e.g. the app's
   * true bilateral asymmetry); otherwise the firmware fraction x 100 is used.
   */
  onStride(stride: Stride, asymmetryPct?: number | null): void {
    const before = this.snapshotKeys();
    const side = stride.side;
    const fi = stride.values.freezeIndex;
    const st = this.settings;
    if (fi !== undefined) {
      const f = this.fi[side];
      if (fi >= st.fiThreshold) {
        f.above++;
        f.below = 0;
      } else {
        f.below++;
        f.above = 0;
      }
      if (f.above >= st.fiConsecutive) this.raise('freezing', side, fi);
      else if (this.isActive('freezing', side)) {
        this.bump('freezing', side, fi);
        if (f.below >= st.fiConsecutive) this.clear('freezing', side);
      }
      const pre = !this.isActive('freezing', side) && fi >= st.preFreezeLow && fi < st.fiThreshold;
      if (pre) this.raise('preFreeze', side, fi);
      else this.clear('preFreeze', side);
    }

    const fw = stride.values.asymmetryIndex;
    const asym = asymmetryPct ?? (fw !== undefined ? fw * 100 : undefined);
    if (asym !== undefined && asym !== null) {
      if (asym > st.asymmetryPct) this.raise('asymmetry', side, asym);
      else if (asym < st.asymmetryPct - ASYMMETRY_HYSTERESIS_PCT) this.clear('asymmetry', side);
      else this.bump('asymmetry', side, asym);
    }

    const ai = stride.aiLabel === null ? undefined : AI_KIND[stride.aiLabel];
    for (const kind of ['shuffling', 'limping'] as const) {
      if (ai === kind) this.raise(kind, side, stride.aiConfidence ?? 0);
      else if (stride.aiLabel !== null) this.clear(kind, side);
    }

    if (this.snapshotKeys() !== before) this.emitter.emit('changed', this.getActive());
  }

  /** Close every open alert (session stop). */
  closeAll(): void {
    const had = this.active.size > 0;
    for (const a of [...this.active.values()]) this.clear(a.kind, a.side);
    this.fi.L = { above: 0, below: 0 };
    this.fi.R = { above: 0, below: 0 };
    if (had) this.emitter.emit('changed', []);
  }

  private snapshotKeys(): string {
    return [...this.active.keys()].sort().join('|');
  }

  private raise(kind: AlertKind, side: Side, value: number): void {
    const key = `${kind}:${side}`;
    const cur = this.active.get(key);
    if (cur) cur.peak = Math.max(cur.peak, value);
    else this.active.set(key, { kind, side, since: this.clock.now(), peak: value });
  }

  private bump(kind: AlertKind, side: Side, value: number): void {
    const cur = this.active.get(`${kind}:${side}`);
    if (cur) cur.peak = Math.max(cur.peak, value);
  }

  private clear(kind: AlertKind, side: Side): void {
    const key = `${kind}:${side}`;
    const cur = this.active.get(key);
    if (!cur) return;
    this.active.delete(key);
    this.emitter.emit('episode', { ...cur, until: this.clock.now() });
  }
}

/** Call `cb` once each time a freezing alert starts on an ankle (for haptics/sound). */
export function watchFreezeOnset(engine: AlertEngine, cb: (side: Side) => void): Unsubscribe {
  let active = new Set<Side>();
  return engine.on('changed', (alerts) => {
    const now = new Set(alerts.filter((a) => a.kind === 'freezing').map((a) => a.side));
    for (const side of now) if (!active.has(side)) cb(side);
    active = now;
  });
}
