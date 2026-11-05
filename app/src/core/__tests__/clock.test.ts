import { FakeClock, systemClock } from '../clock';

describe('FakeClock', () => {
  it('runs timers in due order, ties in scheduling order', () => {
    const c = new FakeClock(1000);
    const log: string[] = [];
    c.setTimeout(() => log.push(`b@${c.now()}`), 20);
    c.setTimeout(() => log.push(`a@${c.now()}`), 10);
    c.setTimeout(() => log.push(`c@${c.now()}`), 20);
    c.advance(15);
    expect(log).toEqual(['a@1010']);
    expect(c.now()).toBe(1015);
    c.advance(100);
    expect(log).toEqual(['a@1010', 'b@1020', 'c@1020']);
    expect(c.now()).toBe(1115);
  });

  it('runs timers scheduled by timers within the same advance window', () => {
    const c = new FakeClock();
    const ticks: number[] = [];
    const tick = () => {
      ticks.push(c.now());
      if (ticks.length < 5) c.setTimeout(tick, 100);
    };
    c.setTimeout(tick, 100);
    c.advance(1000);
    expect(ticks).toEqual([100, 200, 300, 400, 500]);
  });

  it('clearTimeout cancels and negative delays run immediately on advance', () => {
    const c = new FakeClock();
    const fn = jest.fn();
    const h = c.setTimeout(fn, 10);
    c.clearTimeout(h);
    c.setTimeout(fn, -5);
    expect(c.pendingTimers()).toBe(1);
    c.advance(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('advanceAsync lets awaited continuations observe each timer', async () => {
    const c = new FakeClock();
    const seen: number[] = [];
    const sleep = (ms: number) => new Promise<void>((r) => c.setTimeout(r, ms));
    const loop = async () => {
      for (let i = 0; i < 3; i++) {
        await sleep(50);
        seen.push(c.now());
      }
    };
    const done = loop();
    await c.advanceAsync(200);
    await done;
    expect(seen).toEqual([50, 100, 150]);
  });

  it('wall clock moves with monotonic time', () => {
    const c = new FakeClock(0, 1_000_000);
    c.advance(250);
    expect(c.wallNow()).toBe(1_000_250);
  });
});

describe('systemClock', () => {
  it('is monotonic and schedules real timers', async () => {
    const a = systemClock.now();
    await new Promise<void>((r) => systemClock.setTimeout(r, 5));
    expect(systemClock.now()).toBeGreaterThanOrEqual(a);
    const fn = jest.fn();
    systemClock.clearTimeout(systemClock.setTimeout(fn, 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
    expect(Math.abs(systemClock.wallNow() - Date.now())).toBeLessThan(50);
  });
});
