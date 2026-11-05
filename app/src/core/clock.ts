/**
 * Time source used by every service. Nothing in src/services reads Date or
 * performance directly, so tests drive time explicitly through FakeClock.
 */
export type TimerHandle = number;

export interface Clock {
  /** Monotonic milliseconds (never jumps with wall-clock changes). */
  now(): number;
  /** Wall-clock epoch milliseconds, for display and export only. */
  wallNow(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
};

interface PendingTimer {
  id: TimerHandle;
  due: number;
  seq: number;
  fn: () => void;
}

/** Deterministic clock for tests: time only moves when advance() is called. */
export class FakeClock implements Clock {
  private t: number;
  private wallOffset: number;
  private timers: PendingTimer[] = [];
  private nextId = 1;
  private seq = 0;

  constructor(startMs = 0, wallEpochMs = Date.UTC(2026, 10, 5, 9, 0, 0)) {
    this.t = startMs;
    this.wallOffset = wallEpochMs - startMs;
  }

  now(): number {
    return this.t;
  }

  wallNow(): number {
    return this.t + this.wallOffset;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, due: this.t + Math.max(0, ms), seq: this.seq++, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  private popNextDue(limit: number): PendingTimer | undefined {
    let best: PendingTimer | undefined;
    for (const x of this.timers) {
      if (x.due > limit) continue;
      if (!best || x.due < best.due || (x.due === best.due && x.seq < best.seq)) best = x;
    }
    if (best) this.timers = this.timers.filter((x) => x !== best);
    return best;
  }

  /** Run every timer due within `ms`, in due-time order, synchronously. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (let next = this.popNextDue(target); next; next = this.popNextDue(target)) {
      this.t = next.due;
      next.fn();
    }
    this.t = target;
  }

  /**
   * Like advance(), but lets promise chains settle after every timer and at the
   * end, so async services observe time the way they would in the app.
   */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.t + ms;
    await flushMicrotasks();
    for (let next = this.popNextDue(target); next; next = this.popNextDue(target)) {
      this.t = next.due;
      next.fn();
      await flushMicrotasks();
    }
    this.t = target;
    await flushMicrotasks();
  }
}

/** Let all queued promise callbacks run (several rounds for chained awaits). */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
