import { encodeValue } from '@/ble/codec';
import type { CharKey } from '@/ble/gatt';
import { FakeClock } from '@/core/clock';

import { derive, StrideAssembler, type Stride } from '../StrideAssembler';

const f32 = (v: number) => encodeValue('f32', v);
const u32 = (v: number) => encodeValue('u32', v);

const STRIDE: [CharKey, Uint8Array][] = [
  ['strideTime', f32(1.3)],
  ['swingTime', f32(0.49)],
  ['stanceTime', f32(0.81)],
  ['strideLength', f32(0.97)],
  ['tibialShock', f32(3.8)],
  ['asymmetryIndex', f32(0.03)],
  ['freezeIndex', f32(0.4)],
];

function setup() {
  const clock = new FakeClock();
  const a = new StrideAssembler('L', clock);
  const out: Stride[] = [];
  a.on('stride', (s) => out.push(s));
  return { clock, a, out };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe('StrideAssembler', () => {
  it('assembles the same stride whatever the arrival order', () => {
    const keys: [CharKey, Uint8Array][] = [...STRIDE.slice(0, 4), ['strideCount', u32(5)]];
    const results = permutations(keys).map((order) => {
      const { clock, a, out } = setup();
      for (const [k, v] of order) a.push(k, v);
      clock.advance(300);
      return out[0]!;
    });
    expect(results).toHaveLength(120);
    for (const s of results) {
      expect(s.strideCount).toBe(5);
      expect(s.values.strideTime).toBeCloseTo(1.3, 6);
      expect(s.values.strideLength).toBeCloseTo(0.97, 6);
    }
  });

  it('commits on timeout and derives cadence and phase percentages', () => {
    const { clock, a, out } = setup();
    for (const [k, v] of STRIDE) a.push(k, v);
    clock.advance(299);
    expect(out).toHaveLength(0);
    clock.advance(1);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.missing).toEqual([]);
    expect(s.cadenceSpm).toBeCloseTo(120 / 1.3, 4);
    expect(s.swingPct! + s.stancePct!).toBeCloseTo(100, 3);
    expect(s.aiLabel).toBeNull();
    expect(s.aiConfidence).toBeNull();
  });

  it('commits immediately when the next stride starts (repeated field)', () => {
    const { a, out } = setup();
    for (const [k, v] of STRIDE) a.push(k, v);
    a.push('strideTime', f32(1.25));
    expect(out).toHaveLength(1);
    a.flush();
    expect(out[1]!.values.strideTime).toBeCloseTo(1.25, 6);
    expect(out[1]!.missing).toHaveLength(6);
  });

  it('counts missed strides from counter gaps', () => {
    const { a } = setup();
    for (const c of [1, 2, 5, 6, 9]) {
      a.push('strideCount', u32(c));
      a.flush();
    }
    expect(a.stats()).toEqual({ committed: 5, missedStrides: 4, malformed: 0 });
  });

  it('treats zero stride length (first stride) and non-finite values as missing', () => {
    const { a, out } = setup();
    a.push('strideLength', f32(0));
    a.push('freezeIndex', f32(0.4));
    a.flush();
    a.push('freezeIndex', Uint8Array.from([0, 0, 0xc0, 0x7f])); // NaN
    a.flush();
    expect(out[0]!.missing).toContain('strideLength');
    expect(out[1]!.missing).toContain('freezeIndex');
    expect(out[1]!.cadenceSpm).toBeNull();
  });

  it('carries the AI label and confidence (EDGE_AI mode)', () => {
    const { a, out } = setup();
    a.push('aiLabel', Uint8Array.from([2]));
    a.push('aiConfidence', f32(0.8));
    a.flush();
    a.push('aiLabel', Uint8Array.from([0xff]));
    a.push('aiConfidence', f32(0.9));
    a.flush();
    expect([out[0]!.aiLabel, out[0]!.aiConfidence]).toEqual([2, expect.closeTo(0.8, 5)]);
    expect([out[1]!.aiLabel, out[1]!.aiConfidence]).toEqual([null, null]);
  });

  it('drops malformed packets and reports them', () => {
    const { a, out } = setup();
    const bad: string[] = [];
    a.on('malformed', (m) => bad.push(`${m.key}: ${m.error}`));
    a.push('strideTime', Uint8Array.from([1, 2]));
    a.push('aiLabel', Uint8Array.from([9]));
    a.flush();
    expect(out).toHaveLength(0);
    expect(bad).toEqual([
      'strideTime: f32 expects 4 byte(s), got 2',
      'aiLabel: AI label 9 outside class range 0..3',
    ]);
    expect(a.stats().malformed).toBe(2);
  });

  it('derive handles missing or zero stride time', () => {
    expect(derive({})).toEqual({ cadenceSpm: null, swingPct: null, stancePct: null });
    expect(derive({ strideTime: 0, swingTime: 1 })).toEqual({
      cadenceSpm: null,
      swingPct: null,
      stancePct: null,
    });
    expect(derive({ strideTime: 1.2 }).swingPct).toBeNull();
  });

  it('dispose cancels a pending commit', () => {
    const { clock, a, out } = setup();
    a.push('strideTime', f32(1.3));
    a.dispose();
    clock.advance(1000);
    expect(out).toHaveLength(0);
    expect(clock.pendingTimers()).toBe(0);
  });
});
