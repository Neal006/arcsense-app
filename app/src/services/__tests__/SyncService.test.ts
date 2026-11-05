import { decodeValue } from '@/ble/codec';
import { MockTransport, type VirtualDeviceConfig } from '@/ble/MockTransport';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';

import { DeviceManager } from '../DeviceManager';
import { FIRST_SYNC_TOKEN, nextToken, SyncService, type SyncTokenRecord } from '../SyncService';

const L = 'dev-L';
const R = 'dev-R';

async function rig(
  opts: {
    l?: Partial<VirtualDeviceConfig>;
    r?: Partial<VirtualDeviceConfig>;
    connect?: ('L' | 'R')[];
  } = {},
) {
  const clock = new FakeClock();
  const transport = new MockTransport(clock, [
    { id: L, side: 'L', mode: 0, strides: session0007(), ...opts.l },
    { id: R, side: 'R', mode: 0, strides: session0007(), ...opts.r },
  ]);
  const dm = new DeviceManager(transport, clock);
  for (const side of opts.connect ?? ['L', 'R']) {
    const p = dm.connect(side === 'L' ? L : R, side);
    await clock.advanceAsync(100);
    await p;
  }
  const sync = new SyncService(dm, clock);
  const tokens: SyncTokenRecord[] = [];
  sync.on('token', (t) => tokens.push(t));
  return { clock, transport, dm, sync, tokens };
}

const syncWrites = (t: MockTransport) =>
  t.writes
    .filter((w) => w.key === 'syncMarker')
    .map((w) => ({ id: w.deviceId, t: w.t, token: decodeValue('u16', w.value) }));

describe('nextToken', () => {
  it('increments and wraps without ever producing 0', () => {
    expect(nextToken(0xaa01)).toBe(0xaa02);
    expect(nextToken(0xfffe)).toBe(0xffff);
    expect(nextToken(0xffff)).toBe(0x0001);
  });
});

describe('SyncService', () => {
  it('start writes session start (both), then token 0xAA01 to both in the same tick', async () => {
    const { clock, transport, sync } = await rig();
    clock.advance(1000);
    const rec = await sync.start();
    const ss = transport.writes.filter((w) => w.key === 'sessionStartTimestamp');
    expect(ss.map((w) => w.deviceId)).toEqual([L, R]);
    expect(ss.every((w) => w.withResponse)).toBe(true);
    const start = sync.getSessionStart()!;
    expect(decodeValue('u32', ss[0]!.value)).toBe(start.value);
    expect(start.value).toBe(Math.floor(start.t * 1000) % 2 ** 32);

    expect(rec).toMatchObject({
      seq: 0,
      token: FIRST_SYNC_TOKEN,
      reason: 'start',
      partial: false,
      jsDispatchSkewMs: 0,
    });
    expect(rec.sides.L).toMatchObject({
      status: 'sent',
      writeMode: 'without-response',
      error: null,
    });
    const w = syncWrites(transport);
    expect(w).toEqual([
      { id: L, t: w[0]!.t, token: 0xaa01 },
      { id: R, t: w[0]!.t, token: 0xaa01 },
    ]);
    expect(sync.running()).toBe(true);
  });

  it('sends exactly one token per minute on a fixed grid for 10 minutes', async () => {
    const { clock, sync, tokens } = await rig();
    await sync.start();
    const t0 = tokens[0]!.t;
    await clock.advanceAsync(10 * 60_000);
    expect(tokens).toHaveLength(11);
    expect(tokens.map((x) => x.token)).toEqual(Array.from({ length: 11 }, (_, i) => 0xaa01 + i));
    expect(tokens.slice(1).map((x) => x.t - t0)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i + 1) * 60_000),
    );
    expect(tokens.slice(1).every((x) => x.reason === 'periodic')).toBe(true);
  });

  it('manual sync sends the next token now and restarts the 60 s grid', async () => {
    const { clock, sync, tokens } = await rig();
    await sync.start();
    await clock.advanceAsync(25_000);
    const m = await sync.manualSync();
    expect(m).toMatchObject({ token: 0xaa02, reason: 'manual' });
    await clock.advanceAsync(59_999);
    expect(tokens).toHaveLength(2);
    await clock.advanceAsync(1);
    expect(tokens).toHaveLength(3);
    expect(tokens[2]!.t - m.t).toBe(60_000);
  });

  it('marks a token partial when one ankle is not connected and resyncs on reconnect', async () => {
    const { clock, transport, dm, sync, tokens } = await rig();
    await sync.start();
    transport.dropLink(R);
    await clock.advanceAsync(60_000); // periodic tick while R is reconnecting... R reconnects after 1 s
    // R came back after the 1 s backoff -> resync token went out before the periodic one
    const resync = tokens.find((t) => t.reason === 'resync');
    expect(resync).toBeDefined();
    expect(resync!.partial).toBe(false);
    expect(dm.isReady('R')).toBe(true);

    transport.setAdvertising(R, false);
    transport.dropLink(R);
    await clock.advanceAsync(60_000);
    const periodic = tokens.at(-1)!;
    expect(periodic.reason).toBe('periodic');
    expect(periodic.partial).toBe(true);
    expect(periodic.sides.R).toMatchObject({
      status: 'skipped',
      dispatchT: null,
      error: 'not connected',
    });
    expect(periodic.sides.L.status).toBe('sent');
    expect(periodic.jsDispatchSkewMs).toBeNull();
  });

  it('a resync does not shift the periodic grid', async () => {
    const { clock, transport, sync, tokens } = await rig();
    await sync.start();
    const t0 = tokens[0]!.t;
    await clock.advanceAsync(10_000);
    transport.dropLink(L);
    await clock.advanceAsync(50_000);
    const periodic = tokens.filter((t) => t.reason === 'periodic');
    expect(periodic.map((t) => t.t - t0)).toEqual([60_000]);
  });

  it('records a failed write per side', async () => {
    const { transport, sync } = await rig();
    jest.spyOn(transport, 'write').mockImplementation(async (id) => {
      if (id === R) throw new Error('GATT busy');
    });
    const rec = await sync.start();
    expect(rec.partial).toBe(true);
    expect(rec.sides.R).toMatchObject({ status: 'failed', error: 'GATT busy' });
    expect(rec.sides.R.dispatchT).not.toBeNull();
    expect(rec.jsDispatchSkewMs).toBe(0);
  });

  it('falls back to write-with-response when the firmware lacks write-without-response', async () => {
    const { transport, sync } = await rig({ r: { noWriteWithoutResponse: true } });
    const rec = await sync.start();
    expect(rec.sides.L.writeMode).toBe('without-response');
    expect(rec.sides.R.writeMode).toBe('with-response');
    expect(rec.partial).toBe(false);
    expect(
      transport.writes.filter((w) => w.key === 'syncMarker' && w.deviceId === R)[0]!.withResponse,
    ).toBe(true);
  });

  it('serialises concurrent syncs so tokens stay in order', async () => {
    const { sync } = await rig();
    await sync.start();
    const [a, b, c] = await Promise.all([sync.manualSync(), sync.manualSync(), sync.manualSync()]);
    expect([a.token, b.token, c.token]).toEqual([0xaa02, 0xaa03, 0xaa04]);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it('stop sends a final token, stops the schedule and is idempotent', async () => {
    const { clock, sync, tokens } = await rig();
    const running: boolean[] = [];
    sync.on('running', (r) => running.push(r));
    await sync.start();
    const fin = await sync.stop();
    expect(fin).toMatchObject({ token: 0xaa02, reason: 'stop' });
    expect(await sync.stop()).toBeNull();
    await clock.advanceAsync(10 * 60_000);
    expect(tokens).toHaveLength(2);
    expect(running).toEqual([true, false]);
    // only the two virtual ankles' stride timers remain; nothing from SyncService
    expect(clock.pendingTimers()).toBe(2);
  });

  it('resumes a sequence without rewriting Session Start (crash recovery)', async () => {
    const { sync, transport, clock, tokens } = await rig();
    const rec = await sync.resume(0xaa2a, 41);
    expect(rec).toMatchObject({ token: 0xaa2a, seq: 41, reason: 'resume' });
    expect(sync.peekNextToken()).toBe(0xaa2b);
    expect(sync.getSessionStart()).toBeNull();
    expect(transport.writes.some((w) => w.key === 'sessionStartTimestamp')).toBe(false);
    await clock.advanceAsync(60_000);
    expect(tokens.at(-1)).toMatchObject({ seq: 42, reason: 'periodic' });
  });

  it('validates inputs and state', async () => {
    const { sync, dm, clock } = await rig();
    expect(() => new SyncService(dm, clock, 500)).toThrow(RangeError);
    await expect(sync.manualSync()).rejects.toThrow(/not running/);
    await expect(sync.resume(0, 0)).rejects.toThrow(RangeError);
    await expect(sync.resume(0x10000, 0)).rejects.toThrow(RangeError);
    await expect(sync.resume(0xaa01, -1)).rejects.toThrow(RangeError);
    await sync.start();
    await expect(sync.start()).rejects.toThrow(/already running/);
  });

  it('works with only one ankle (single-side session)', async () => {
    const { sync } = await rig({ connect: ['L'] });
    const rec = await sync.start();
    expect(rec.partial).toBe(true);
    expect(rec.sides.L.status).toBe('sent');
    expect(sync.getSessionStart()!.sides.R.status).toBe('skipped');
  });

  it('dispose cancels everything', async () => {
    const { clock, sync } = await rig();
    await sync.start();
    sync.dispose();
    expect(sync.running()).toBe(false);
    expect(clock.pendingTimers()).toBe(2); // device stride timers only
    const before = sync.getTokens().length;
    await clock.advanceAsync(120_000);
    expect(sync.getTokens()).toHaveLength(before);
  });
});
