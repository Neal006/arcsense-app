import { MockTransport, type VirtualDeviceConfig } from '@/ble/MockTransport';
import { mirrorSide, session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';

import { DeviceManager } from '../DeviceManager';
import { asymmetry, GaitAcquisition, RunningStat, type BilateralPair } from '../GaitAcquisition';
import type { Stride } from '../StrideAssembler';

async function rig(mode: number, extra: Partial<VirtualDeviceConfig> = {}) {
  const clock = new FakeClock();
  const left = session0007();
  const transport = new MockTransport(clock, [
    { id: 'L', side: 'L', mode, strides: left, firstStrideDelayMs: 500, ...extra },
    {
      id: 'R',
      side: 'R',
      mode,
      strides: mirrorSide(left, { swingAsymmetry: 0.2, lengthAsymmetry: 0 }),
      firstStrideDelayMs: 650,
    },
  ]);
  const dm = new DeviceManager(transport, clock);
  const acq = new GaitAcquisition(dm, clock);
  acq.start();
  const p = Promise.all([dm.connect('L', 'L'), dm.connect('R', 'R')]);
  await clock.advanceAsync(100);
  await p;
  const strides: Stride[] = [];
  const pairs: BilateralPair[] = [];
  acq.on('stride', (s) => strides.push(s));
  acq.on('pair', (x) => pairs.push(x));
  return { clock, transport, dm, acq, strides, pairs };
}

describe('RunningStat', () => {
  it('matches the two-pass mean, sample SD and CV', () => {
    // The report's figures (1.305 s, CV 2.90 %) exclude the first stride, which
    // was recorded while the subject was still starting to walk.
    const xs = session0007()
      .slice(1)
      .map((s) => s.strideTimeS);
    const r = new RunningStat();
    xs.forEach((x) => r.add(x));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    const s = r.summary();
    expect(s.mean).toBeCloseTo(mean, 12);
    expect(s.sd).toBeCloseTo(sd, 12);
    expect(s.mean).toBeCloseTo(1.305, 3);
    expect(s.cvPct).toBeCloseTo(2.9, 2);
    expect(new RunningStat().summary()).toEqual({
      n: 0,
      mean: null,
      sd: null,
      cvPct: null,
      min: null,
      max: null,
    });
  });

  it('asymmetry is |L-R| / mean x 100 and undefined for a zero mean', () => {
    expect(asymmetry(1.1, 0.9)).toBeCloseTo(20, 10);
    expect(asymmetry(0, 0)).toBeNull();
  });
});

describe('GaitAcquisition', () => {
  it('streams the whole 0007 replay into strides with report-matching statistics', async () => {
    const { clock, acq, strides } = await rig(2);
    await clock.advanceAsync(80_000);
    const left = strides.filter((s) => s.side === 'L');
    expect(left.length).toBeGreaterThanOrEqual(54);
    // the virtual ankle loops over the 54 recorded strides; compare against exactly those replayed
    const rows = session0007();
    const replayed = left.map((_, i) => rows[i % rows.length]!.strideTimeS);
    const expected = replayed.reduce((a, b) => a + b, 0) / replayed.length;
    const st = acq.sessionStats('L');
    expect(st.strideTime!.n).toBe(left.length);
    expect(st.strideTime!.mean).toBeCloseTo(expected, 6);
    expect(st.cadenceSpm!.mean).toBeCloseTo(91.9, 0);
    expect(acq.assemblerStats('L')).toMatchObject({ missedStrides: 0, malformed: 0 });
    expect(acq.recent('L')).toHaveLength(20);
    expect(acq.alerts.getActive().filter((a) => a.kind === 'freezing')).toEqual([]);
  });

  it('pairs left and right strides and computes true bilateral asymmetry', async () => {
    const { clock, pairs } = await rig(2);
    await clock.advanceAsync(10_000);
    expect(pairs.length).toBeGreaterThan(3);
    const p = pairs.at(-1)!;
    // right swing is 20 % longer: |s - 1.2 s| / (1.1 s) = 18.18 %
    expect(p.asymmetryPct.swingTime).toBeCloseTo((100 * 0.2) / 1.1, 4);
    expect(p.asymmetryPct.strideTime).toBeCloseTo(0, 6);
  });

  it('raises the asymmetry alert from the bilateral value', async () => {
    const { clock, acq } = await rig(2);
    await clock.advanceAsync(10_000);
    expect(acq.alerts.isActive('asymmetry', 'L') || acq.alerts.isActive('asymmetry', 'R')).toBe(
      true,
    );
  });

  it('polls DATA_COLLECTION firmware and assembles strides from reads', async () => {
    const { clock, strides } = await rig(0);
    await clock.advanceAsync(6_000);
    const left = strides.filter((s) => s.side === 'L');
    expect(left.length).toBeGreaterThanOrEqual(3);
    expect(left[1]!.strideCount).toBe(left[0]!.strideCount! + 1);
  });

  it('re-attaches after a link drop and keeps counting', async () => {
    const { clock, transport, strides } = await rig(2);
    await clock.advanceAsync(5_000);
    const before = strides.filter((s) => s.side === 'R').length;
    transport.dropLink('R');
    await clock.advanceAsync(10_000);
    expect(strides.filter((s) => s.side === 'R').length).toBeGreaterThan(before + 3);
  });

  it('stop detaches everything', async () => {
    const { clock, acq, strides } = await rig(0);
    acq.stop();
    await clock.advanceAsync(10_000);
    expect(strides).toEqual([]);
  });
});
