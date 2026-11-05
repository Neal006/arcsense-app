import type { Side } from '@/ble/gatt';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';

import {
  AlertEngine,
  DEFAULT_ALERT_SETTINGS,
  validateAlertSettings,
  type AlertEpisode,
} from '../AlertEngine';
import type { Stride } from '../StrideAssembler';

function stride(
  side: Side,
  v: Partial<Stride['values']>,
  ai: [number | null, number | null] = [null, null],
): Stride {
  return {
    side,
    strideCount: null,
    t: 0,
    values: v,
    aiLabel: ai[0],
    aiConfidence: ai[1],
    missing: [],
    cadenceSpm: null,
    swingPct: null,
    stancePct: null,
  };
}

function setup() {
  const clock = new FakeClock();
  const eng = new AlertEngine(clock);
  const episodes: AlertEpisode[] = [];
  const changes: string[][] = [];
  eng.on('episode', (e) => episodes.push(e));
  eng.on('changed', (a) => changes.push(a.map((x) => `${x.kind}:${x.side}`)));
  return { clock, eng, episodes, changes };
}

describe('AlertEngine', () => {
  it('raises no freezing alert on the healthy session 0007 with default settings (F-01)', () => {
    const { eng, episodes } = setup();
    for (const s of session0007())
      eng.onStride(stride('L', { freezeIndex: s.freezeIndex, asymmetryIndex: s.asymmetryIndex }));
    expect(episodes.filter((e) => e.kind === 'freezing')).toEqual([]);
    expect(eng.isActive('freezing', 'L')).toBe(false);
  });

  it('a single-stride FI >= 2.0 rule WOULD fire on 0007 (why the defaults differ from the brief)', () => {
    const clock = new FakeClock();
    const naive = new AlertEngine(clock, {
      ...DEFAULT_ALERT_SETTINGS,
      fiThreshold: 2.0,
      fiConsecutive: 1,
    });
    let fired = 0;
    naive.on('episode', (e) => {
      if (e.kind === 'freezing') fired++;
    });
    for (const s of session0007()) naive.onStride(stride('L', { freezeIndex: s.freezeIndex }));
    naive.closeAll();
    expect(fired).toBeGreaterThan(5);
  });

  it('needs N consecutive strides at or above the threshold and N below to clear', () => {
    const { clock, eng, episodes } = setup();
    eng.onStride(stride('R', { freezeIndex: 3.5 }));
    expect(eng.isActive('freezing', 'R')).toBe(false);
    clock.advance(1000);
    eng.onStride(stride('R', { freezeIndex: 3.0 }));
    expect(eng.isActive('freezing', 'R')).toBe(true);
    eng.onStride(stride('R', { freezeIndex: 4.6 }));
    eng.onStride(stride('R', { freezeIndex: 1.0 }));
    expect(eng.isActive('freezing', 'R')).toBe(true);
    clock.advance(2000);
    eng.onStride(stride('R', { freezeIndex: 0.9 }));
    expect(eng.isActive('freezing', 'R')).toBe(false);
    expect(episodes).toEqual([
      { kind: 'freezing', side: 'R', since: 1000, until: 3000, peak: 4.6 },
    ]);
    expect(eng.isActive('freezing', 'L')).toBe(false); // sides are independent
  });

  it('shows pre-freeze between the band and the threshold, but not while freezing', () => {
    const { eng } = setup();
    eng.onStride(stride('L', { freezeIndex: 1.4 }));
    expect(eng.isActive('preFreeze', 'L')).toBe(false);
    eng.onStride(stride('L', { freezeIndex: 2.2 }));
    expect(eng.isActive('preFreeze', 'L')).toBe(true);
    eng.onStride(stride('L', { freezeIndex: 3.1 }));
    eng.onStride(stride('L', { freezeIndex: 3.2 }));
    expect(eng.isActive('preFreeze', 'L')).toBe(false);
    eng.onStride(stride('L', { freezeIndex: 2.0 }));
    expect(eng.isActive('freezing', 'L')).toBe(true); // still within the clear window
    expect(eng.isActive('preFreeze', 'L')).toBe(false);
  });

  it('asymmetry uses the bilateral value when given, firmware fraction otherwise, with hysteresis', () => {
    const { eng, changes } = setup();
    eng.onStride(stride('L', { asymmetryIndex: 0.16 }));
    expect(eng.isActive('asymmetry', 'L')).toBe(true);
    eng.onStride(stride('L', { asymmetryIndex: 0.14 }));
    expect(eng.isActive('asymmetry', 'L')).toBe(true); // inside 2-point hysteresis band
    eng.onStride(stride('L', { asymmetryIndex: 0.5 }), 12.9);
    expect(eng.isActive('asymmetry', 'L')).toBe(false); // bilateral value wins
    expect(changes).toEqual([['asymmetry:L'], []]);
  });

  it('shows EdgeAI shuffling/limping badges and clears them on another class', () => {
    const { eng } = setup();
    eng.onStride(stride('L', {}, [2, 0.9]));
    expect(eng.isActive('shuffling', 'L')).toBe(true);
    eng.onStride(stride('L', {}, [null, null]));
    expect(eng.isActive('shuffling', 'L')).toBe(true); // no inference: keep last state
    eng.onStride(stride('L', {}, [3, 0.7]));
    expect(eng.isActive('shuffling', 'L')).toBe(false);
    expect(eng.isActive('limping', 'L')).toBe(true);
    eng.onStride(stride('L', {}, [0, 0.95]));
    expect(eng.getActive()).toEqual([]);
  });

  it('closeAll ends every open alert and resets counters', () => {
    const { eng, episodes } = setup();
    eng.onStride(stride('L', { freezeIndex: 5, asymmetryIndex: 0.3 }));
    eng.onStride(stride('L', { freezeIndex: 5 }));
    eng.closeAll();
    expect(eng.getActive()).toEqual([]);
    expect(episodes.map((e) => e.kind).sort()).toEqual(['asymmetry', 'freezing']);
    eng.onStride(stride('L', { freezeIndex: 5 }));
    expect(eng.isActive('freezing', 'L')).toBe(false); // counter was reset
  });

  it('validates settings', () => {
    expect(validateAlertSettings(DEFAULT_ALERT_SETTINGS)).toEqual([]);
    const bad = { fiThreshold: 0, fiConsecutive: 0.5, preFreezeLow: 5, asymmetryPct: 1 };
    expect(validateAlertSettings(bad)).toHaveLength(4);
    expect(() => new AlertEngine(new FakeClock(), bad)).toThrow(RangeError);
    const eng = new AlertEngine(new FakeClock());
    expect(() => eng.updateSettings(bad)).toThrow(RangeError);
    eng.updateSettings({ ...DEFAULT_ALERT_SETTINGS, fiConsecutive: 1 });
    eng.onStride(stride('L', { freezeIndex: 3 }));
    expect(eng.isActive('freezing', 'L')).toBe(true);
  });
});
