/**
 * Bilateral sync master (functionalities F22-F27; brief section 4, firmware
 * spec section 6).
 *
 * The phone writes the same 16-bit token to the Sync Marker characteristic of
 * both ankles. Each firmware stamps the token into the next IMU record of its
 * BIN file; post-processing aligns the two files on matching tokens
 * (ml/arcsense_ml/align.py). Every token is logged here with the phone time at
 * which each write was dispatched, so labels recorded on the phone can be
 * mapped onto the device timelines too.
 *
 * What the phone cannot guarantee: both writes are dispatched back-to-back in
 * the same JS turn, but each reaches its ankle at that link's next connection
 * event, so the radio-level skew is up to one connection interval (FINDINGS
 * F-06). `jsDispatchSkewMs` records only the part the app controls.
 */
import type { Clock, TimerHandle } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';

import { deliveredToBoth, writeBoth, type BilateralWrite, type SideWrite } from './bilateralWrite';
import type { DeviceManager } from './DeviceManager';

export type { SideWrite };

export const FIRST_SYNC_TOKEN = 0xaa01;
export const DEFAULT_SYNC_INTERVAL_MS = 60_000;

export type SyncReason = 'start' | 'periodic' | 'manual' | 'resync' | 'stop';

export interface SyncTokenRecord {
  seq: number;
  token: number;
  reason: SyncReason;
  t: number;
  wall: number;
  sides: BilateralWrite;
  /** |dispatchT(R) - dispatchT(L)| when both were sent; app-side component only. */
  jsDispatchSkewMs: number | null;
  /** Not delivered to both ankles. */
  partial: boolean;
}

export interface SessionStartRecord {
  /** uint32 value written to Session Start Timestamp: phone monotonic µs mod 2^32. */
  value: number;
  t: number;
  wall: number;
  sides: BilateralWrite;
}

/** Next token after `token`: increments, wraps 0xFFFF -> 0x0001, never 0 (0 = no marker). */
export function nextToken(token: number): number {
  return token >= 0xffff ? 0x0001 : token + 1;
}

interface SyncEvents extends Record<string, unknown> {
  token: SyncTokenRecord;
  running: boolean;
}

export class SyncService {
  private readonly emitter = new Emitter<SyncEvents>();
  private readonly tokens: SyncTokenRecord[] = [];
  private token = FIRST_SYNC_TOKEN;
  private isRunning = false;
  private timer: TimerHandle | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readyOff: Unsubscribe | null = null;
  private sessionStart: SessionStartRecord | null = null;
  /** Monotonic time of the next periodic token. */
  private nextDue = 0;
  /** seq of the first token of this run (non-zero when resuming a session). */
  private seqBase = 0;

  constructor(
    private readonly dm: DeviceManager,
    private readonly clock: Clock,
    private readonly intervalMs = DEFAULT_SYNC_INTERVAL_MS,
  ) {
    if (!(intervalMs >= 1000)) throw new RangeError('sync interval must be >= 1000 ms');
  }

  on<K extends keyof SyncEvents>(event: K, fn: (p: SyncEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  running(): boolean {
    return this.isRunning;
  }

  getTokens(): readonly SyncTokenRecord[] {
    return this.tokens;
  }

  getSessionStart(): SessionStartRecord | null {
    return this.sessionStart;
  }

  /**
   * Begin a session: write Session Start Timestamp (F-13: semantics to be
   * confirmed by firmware), then the first token, then every interval.
   * `firstToken`/`firstSeq` let a resumed session continue its sequence (F28).
   */
  async start(firstToken = FIRST_SYNC_TOKEN, firstSeq = 0): Promise<SyncTokenRecord> {
    if (this.isRunning) throw new Error('sync already running');
    if (!Number.isInteger(firstToken) || firstToken < 1 || firstToken > 0xffff) {
      throw new RangeError(`invalid first token ${firstToken}`);
    }
    if (!Number.isInteger(firstSeq) || firstSeq < 0)
      throw new RangeError(`invalid first seq ${firstSeq}`);
    this.isRunning = true;
    this.token = firstToken;
    this.seqBase = firstSeq;
    this.emitter.emit('running', true);
    this.readyOff = this.dm.on('ready', () => {
      if (this.isRunning) void this.enqueue('resync');
    });
    this.sessionStart = await this.writeSessionStart();
    return this.enqueue('start');
  }

  async manualSync(): Promise<SyncTokenRecord> {
    if (!this.isRunning) throw new Error('sync is not running');
    return this.enqueue('manual');
  }

  /** Send the final token and stop the schedule. Idempotent. */
  async stop(): Promise<SyncTokenRecord | null> {
    if (!this.isRunning) return null;
    const rec = await this.enqueue('stop');
    this.isRunning = false;
    this.cancelTimer();
    this.readyOff?.();
    this.readyOff = null;
    this.emitter.emit('running', false);
    return rec;
  }

  /** Token that the next sync will use. */
  peekNextToken(): number {
    return this.token;
  }

  private async writeSessionStart(): Promise<SessionStartRecord> {
    const t = this.clock.now();
    const value = Math.floor(t * 1000) % 2 ** 32;
    const sides = await writeBoth(this.dm, this.clock, 'sessionStartTimestamp', value, false);
    return { value, t, wall: this.clock.wallNow(), sides };
  }

  /** Serialise syncs so tokens are written and logged strictly in order. */
  private enqueue(reason: SyncReason): Promise<SyncTokenRecord> {
    const run = this.chain.then(() => this.send(reason));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send(reason: SyncReason): Promise<SyncTokenRecord> {
    const token = this.token;
    this.token = nextToken(token);
    const t = this.clock.now();
    const sides = await writeBoth(this.dm, this.clock, 'syncMarker', token, true);
    const l = sides.L.dispatchT;
    const r = sides.R.dispatchT;
    const rec: SyncTokenRecord = {
      seq: this.seqBase + this.tokens.length,
      token,
      reason,
      t,
      wall: this.clock.wallNow(),
      sides,
      jsDispatchSkewMs: l !== null && r !== null ? Math.abs(r - l) : null,
      partial: !deliveredToBoth(sides),
    };
    this.tokens.push(rec);
    this.emitter.emit('token', rec);
    // Fixed grid: start/manual set the base; periodic ticks advance it exactly
    // one interval (no accumulation of write latency); resyncs leave it alone.
    if (reason === 'start' || reason === 'manual') this.nextDue = t + this.intervalMs;
    else if (reason === 'periodic') this.nextDue += this.intervalMs;
    if (this.isRunning && reason !== 'stop' && reason !== 'resync') this.schedule();
    return rec;
  }

  private schedule(): void {
    this.cancelTimer();
    const delay = Math.max(0, this.nextDue - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.isRunning) void this.enqueue('periodic');
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.isRunning = false;
    this.cancelTimer();
    this.readyOff?.();
    this.readyOff = null;
  }
}
