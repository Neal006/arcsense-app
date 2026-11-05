/**
 * Live gait data path (F13, F14, F18, F19): device -> StrideAssembler per
 * ankle -> bilateral pairing + running statistics -> AlertEngine.
 *
 * STREAMING / EDGE_AI firmware notifies, so durable subscriptions are used.
 * DATA_COLLECTION firmware does not notify (brief section 2.2), so the stride
 * counter is polled and the values are read when it changes (optional; off
 * saves battery during long recordings).
 */
import { SIDES, type Side } from '@/ble/gatt';
import type { Clock, TimerHandle } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';

import { AlertEngine } from './AlertEngine';
import type { DeviceManager } from './DeviceManager';
import {
  ASSEMBLED_KEYS,
  GAIT_FIELDS,
  StrideAssembler,
  type GaitField,
  type Stride,
} from './StrideAssembler';

/** Welford running mean / SD / min / max. */
export class RunningStat {
  n = 0;
  private mean = 0;
  private m2 = 0;
  min = Infinity;
  max = -Infinity;

  add(x: number): void {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
    this.min = Math.min(this.min, x);
    this.max = Math.max(this.max, x);
  }

  summary() {
    const sd = this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
    return {
      n: this.n,
      mean: this.n ? this.mean : null,
      sd: this.n > 1 ? sd : null,
      cvPct: this.n > 1 && this.mean !== 0 ? (100 * sd) / Math.abs(this.mean) : null,
      min: this.n ? this.min : null,
      max: this.n ? this.max : null,
    };
  }
}

export interface BilateralPair {
  left: Stride;
  right: Stride;
  /** |L - R| / mean(L, R) x 100 per field, where both sides have it. */
  asymmetryPct: Partial<Record<GaitField, number>>;
}

/** Pair window: strides from the two ankles at most this far apart (phone time). */
export const PAIR_WINDOW_MS = 800;

export function asymmetry(l: number, r: number): number | null {
  const m = (l + r) / 2;
  return m > 0 ? (100 * Math.abs(l - r)) / m : null;
}

interface AcquisitionEvents extends Record<string, unknown> {
  stride: Stride;
  pair: BilateralPair;
}

export class GaitAcquisition {
  readonly alerts: AlertEngine;
  private readonly emitter = new Emitter<AcquisitionEvents>();
  private readonly assemblers: Record<Side, StrideAssembler>;
  private readonly stats: Record<Side, Record<GaitField | 'cadenceSpm', RunningStat>>;
  private readonly lastStride: Partial<Record<Side, Stride>> = {};
  private readonly history: Record<Side, Stride[]> = { L: [], R: [] };
  private offs: Unsubscribe[] = [];
  private pollTimer: TimerHandle | null = null;
  private lastPolled: Partial<Record<Side, number>> = {};

  constructor(
    private readonly dm: DeviceManager,
    private readonly clock: Clock,
    private readonly opts: { pollMs: number; pollDataCollection: boolean; historySize: number } = {
      pollMs: 1000,
      pollDataCollection: true,
      historySize: 20,
    },
    alerts?: AlertEngine,
  ) {
    this.alerts = alerts ?? new AlertEngine(clock);
    const mk = () =>
      Object.fromEntries(
        [...GAIT_FIELDS, 'cadenceSpm'].map((f) => [f, new RunningStat()]),
      ) as Record<GaitField | 'cadenceSpm', RunningStat>;
    this.stats = { L: mk(), R: mk() };
    this.assemblers = { L: new StrideAssembler('L', clock), R: new StrideAssembler('R', clock) };
    for (const side of SIDES)
      this.offs.push(this.assemblers[side].on('stride', (s) => this.onStride(s)));
  }

  on<K extends keyof AcquisitionEvents>(e: K, fn: (p: AcquisitionEvents[K]) => void): Unsubscribe {
    return this.emitter.on(e, fn);
  }

  start(): void {
    for (const side of SIDES) {
      for (const key of ASSEMBLED_KEYS) {
        this.offs.push(
          this.dm.subscribe(side, key, (bytes) => this.assemblers[side].push(key, bytes)),
        );
      }
    }
    this.offs.push(this.dm.on('lost', ({ side }) => this.assemblers[side].flush()));
    if (this.opts.pollDataCollection) this.schedulePoll();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const side of SIDES) this.assemblers[side].dispose();
  }

  recent(side: Side): readonly Stride[] {
    return this.history[side];
  }

  sessionStats(side: Side) {
    return Object.fromEntries(Object.entries(this.stats[side]).map(([k, v]) => [k, v.summary()]));
  }

  assemblerStats(side: Side) {
    return this.assemblers[side].stats();
  }

  private onStride(s: Stride): void {
    for (const f of GAIT_FIELDS) {
      const v = s.values[f];
      if (v !== undefined) this.stats[s.side][f].add(v);
    }
    if (s.cadenceSpm !== null) this.stats[s.side].cadenceSpm.add(s.cadenceSpm);
    const h = this.history[s.side];
    h.push(s);
    if (h.length > this.opts.historySize) h.shift();
    this.lastStride[s.side] = s;
    this.emitter.emit('stride', s);

    const other = this.lastStride[s.side === 'L' ? 'R' : 'L'];
    let bilateral: number | null = null;
    if (other && Math.abs(other.t - s.t) <= PAIR_WINDOW_MS) {
      const [left, right] = s.side === 'L' ? [s, other] : [other, s];
      const pct: Partial<Record<GaitField, number>> = {};
      for (const f of ['strideTime', 'swingTime', 'stanceTime', 'strideLength'] as const) {
        const l = left.values[f];
        const r = right.values[f];
        if (l !== undefined && r !== undefined) {
          const a = asymmetry(l, r);
          if (a !== null) pct[f] = a;
        }
      }
      this.emitter.emit('pair', { left, right, asymmetryPct: pct });
      bilateral = pct.swingTime ?? pct.strideTime ?? null;
    }
    this.alerts.onStride(s, bilateral);
  }

  private schedulePoll(): void {
    this.pollTimer = this.clock.setTimeout(() => {
      void this.poll().finally(() => {
        if (this.offs.length) this.schedulePoll();
      });
    }, this.opts.pollMs);
  }

  /** DATA_COLLECTION firmware: read values when the stride counter moves. */
  private async poll(): Promise<void> {
    for (const side of SIDES) {
      const link = this.dm.getLink(side);
      if (link.state !== 'ready' || link.mode !== 'DATA_COLLECTION') continue;
      try {
        const count = await this.dm.read(side, 'strideCount');
        if (count === this.lastPolled[side]) continue;
        this.lastPolled[side] = count;
        for (const key of [...GAIT_FIELDS, 'strideCount'] as const) {
          this.assemblers[side].push(key, await this.dm.readRaw(side, key));
        }
        this.assemblers[side].flush();
      } catch {
        // link dropped mid-poll; DeviceManager handles reconnection
      }
    }
  }
}
