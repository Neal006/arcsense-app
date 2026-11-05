import { decodeValue } from '@/ble/codec';
import type { Side } from '@/ble/gatt';
import { MockTransport, type VirtualDeviceConfig } from '@/ble/MockTransport';
import { session0007 } from '@/ble/replay';
import { FakeClock } from '@/core/clock';

import { ConnectError, DeviceManager, type LinkState } from '../DeviceManager';

const L = 'dev-L';
const R = 'dev-R';

function rig(
  cfg: {
    l?: Partial<VirtualDeviceConfig>;
    r?: Partial<VirtualDeviceConfig>;
    extra?: VirtualDeviceConfig[];
  } = {},
) {
  const clock = new FakeClock();
  const strides = session0007();
  const transport = new MockTransport(clock, [
    { id: L, side: 'L', mode: 2, strides, rssi: -55, firstStrideDelayMs: 500, ...cfg.l },
    { id: R, side: 'R', mode: 2, strides, rssi: -65, firstStrideDelayMs: 700, ...cfg.r },
    ...(cfg.extra ?? []),
  ]);
  const dm = new DeviceManager(transport, clock);
  const states: Record<Side, LinkState[]> = { L: [], R: [] };
  dm.on('links', (links) => {
    for (const s of ['L', 'R'] as const) {
      const arr = states[s];
      if (arr[arr.length - 1] !== links[s].state) arr.push(links[s].state);
    }
  });
  return { clock, transport, dm, states };
}

async function scan(dm: DeviceManager, clock: FakeClock) {
  dm.startScan();
  await clock.advanceAsync(0);
}

async function connectSide(dm: DeviceManager, clock: FakeClock, id: string, side?: Side) {
  const p = dm.connect(id, side);
  await clock.advanceAsync(100);
  return p;
}

const eventTypes = (dm: DeviceManager) => dm.getEventLog().map((e) => e.type);

describe('adapter', () => {
  it('reads the initial state and follows changes', async () => {
    const { dm, transport } = rig();
    const seen: string[] = [];
    dm.on('adapter', (s) => seen.push(s));
    expect(await dm.init()).toBe('poweredOn');
    transport.setAdapterState('poweredOff');
    expect(dm.getAdapterState()).toBe('poweredOff');
    expect(seen).toEqual(['poweredOn', 'poweredOff']);
    expect(eventTypes(dm)).toEqual(['adapter_state', 'adapter_state']);
  });
});

describe('scanning (F04)', () => {
  it('discovers both ankles, ignores other names, picks strongest per side', async () => {
    const { dm, clock } = rig({
      extra: [
        { id: 'dev-L2', side: 'L', mode: 2, strides: [], rssi: -80 },
        { id: 'other', side: 'L', name: 'SomethingElse', mode: 2, strides: [] },
      ],
    });
    const lists: number[] = [];
    dm.on('scan', (l) => lists.push(l.length));
    await scan(dm, clock);
    expect(dm.scanning()).toBe(true);
    const found = dm.getDiscovered();
    expect(found.map((d) => d.id).sort()).toEqual(['dev-L', 'dev-L2', 'dev-R']);
    const best = dm.bestCandidates();
    expect(best.L?.id).toBe(L);
    expect(best.R?.id).toBe(R);
    expect(lists[0]).toBe(0); // list cleared on start
  });

  it('stops automatically after the scan timeout', async () => {
    const { dm, clock } = rig();
    await scan(dm, clock);
    await clock.advanceAsync(14_999);
    expect(dm.scanning()).toBe(true);
    await clock.advanceAsync(1);
    expect(dm.scanning()).toBe(false);
    expect(eventTypes(dm)).toEqual(['scan_started', 'scan_stopped']);
  });

  it('logs and stops on scan error (adapter off)', async () => {
    const { dm, clock, transport } = rig();
    transport.setAdapterState('poweredOff');
    await scan(dm, clock);
    expect(dm.scanning()).toBe(false);
    expect(eventTypes(dm)).toContain('scan_error');
  });

  it('stops scanning when the adapter powers off', async () => {
    const { dm, clock, transport } = rig();
    await dm.init();
    await scan(dm, clock);
    transport.setAdapterState('poweredOff');
    expect(dm.scanning()).toBe(false);
  });
});

describe('connect (F05-F08)', () => {
  it('walks connecting -> discovering -> ready and records mode, GATT, MTU, priority', async () => {
    const { dm, clock, transport, states } = rig();
    await scan(dm, clock);
    const ready = jest.fn();
    dm.on('ready', ready);
    await expect(connectSide(dm, clock, L)).resolves.toBe('L');
    expect(states.L).toEqual(['connecting', 'discovering', 'ready']);
    const link = dm.getLink('L');
    expect(link).toMatchObject({
      deviceId: L,
      name: 'ArcSense-L',
      mode: 'STREAMING',
      reconnectAttempt: 0,
    });
    expect(link.gatt?.missing).toEqual([]);
    expect(link.readyAt).toBe(50); // after the 50 ms connect latency
    expect(transport.requestedMtu(L)).toBe(185);
    expect(transport.isHighPriority(L)).toBe(true);
    expect(ready).toHaveBeenCalledWith({ side: 'L', deviceId: L, mode: 'STREAMING' });
    expect(dm.scanning()).toBe(false); // connecting stops the scan
  });

  it('connectBoth connects the best L and R in parallel', async () => {
    const { dm, clock } = rig();
    await scan(dm, clock);
    const p = dm.connectBoth();
    await clock.advanceAsync(100);
    expect(await p).toEqual({ L: 'L', R: 'R' });
    expect(dm.isReady('L') && dm.isReady('R')).toBe(true);
    // already-ready sides are left alone
    const again = dm.connectBoth();
    await clock.advanceAsync(100);
    expect(await again).toEqual({ L: 'L', R: 'R' });
  });

  it('connectBoth reports a side that was not found', async () => {
    const { dm, clock, transport } = rig();
    transport.setAdvertising(R, false);
    await scan(dm, clock);
    const p = dm.connectBoth();
    await clock.advanceAsync(100);
    const res = await p;
    expect(res.L).toBe('L');
    expect(res.R).toBeInstanceOf(ConnectError);
  });

  it('role characteristic overrides the advertised name', async () => {
    const { dm, clock, states } = rig({ l: { roleCode: 82 } }); // named ArcSense-L, reports R
    await scan(dm, clock);
    const p = dm.connect(L);
    await clock.advanceAsync(300);
    await expect(p).resolves.toBe('R');
    expect(dm.getLink('R')).toMatchObject({ deviceId: L, state: 'ready' });
    expect(dm.getLink('L')).toMatchObject({ deviceId: null, state: 'idle' });
    expect(states.L).toContain('idle');
    const ev = dm.getEventLog().find((e) => e.type === 'role_mismatch');
    expect(ev?.detail).toMatch(/role says R; role wins/);
  });

  it('refuses a role handover onto a side that is already connected', async () => {
    const { dm, clock } = rig({ l: { roleCode: 82 } });
    await scan(dm, clock);
    await connectSide(dm, clock, R);
    const p = dm.connect(L);
    const assertion = expect(p).rejects.toThrow(/already connected/);
    await clock.advanceAsync(300);
    await assertion;
    expect(dm.getLink('R').deviceId).toBe(R);
  });

  it('falls back to the expected side for an unknown role code', async () => {
    const { dm, clock } = rig({ l: { roleCode: 0 } });
    await scan(dm, clock);
    await expect(connectSide(dm, clock, L)).resolves.toBe('L');
    expect(dm.getEventLog().find((e) => e.type === 'role_mismatch')?.detail).toMatch(
      /unknown role code 0/,
    );
  });

  it('uses the expected side when the role characteristic is absent', async () => {
    const { dm, clock } = rig({ l: { omit: ['deviceRole', 'bleMode'] } });
    await scan(dm, clock);
    await expect(connectSide(dm, clock, L)).resolves.toBe('L');
    expect(dm.getLink('L').mode).toBeNull();
    expect(eventTypes(dm)).toContain('gatt_incomplete');
  });

  it('detects DATA_COLLECTION mode', async () => {
    const { dm, clock } = rig({ l: { mode: 0 } });
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    expect(dm.getLink('L').mode).toBe('DATA_COLLECTION');
  });

  it('rejects a device whose side cannot be determined', async () => {
    const { dm } = rig();
    await expect(dm.connect('never-scanned')).rejects.toThrow(ConnectError);
  });

  it('rejects connecting a second device to an occupied side', async () => {
    const { dm, clock } = rig({ extra: [{ id: 'dev-L2', side: 'L', mode: 2, strides: [] }] });
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    await expect(dm.connect('dev-L2')).rejects.toThrow(/already assigned/);
  });

  it('a failed user connect ends idle with the error and no retry', async () => {
    const { dm, clock, transport } = rig();
    await scan(dm, clock);
    transport.failNextConnects(L, 1);
    const p = dm.connect(L);
    const assertion = expect(p).rejects.toThrow(/injected/);
    await clock.advanceAsync(100);
    await assertion;
    expect(dm.getLink('L')).toMatchObject({
      state: 'idle',
      lastError: expect.stringMatching(/injected/),
    });
    await clock.advanceAsync(60_000);
    expect(eventTypes(dm)).not.toContain('reconnect_scheduled');
  });

  it('a priority request failure is logged but not fatal', async () => {
    const { dm, clock, transport } = rig();
    jest.spyOn(transport, 'requestHighPriority').mockRejectedValue(new Error('not supported'));
    await scan(dm, clock);
    await expect(connectSide(dm, clock, L)).resolves.toBe('L');
    expect(dm.getEventLog().find((e) => e.type === 'priority_failed')?.detail).toBe(
      'not supported',
    );
  });
});

describe('reconnect (F09)', () => {
  it('re-establishes after link loss and re-attaches durable subscriptions', async () => {
    const { dm, clock, transport, states } = rig();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    const counts: number[] = [];
    dm.subscribe('L', 'strideCount', (b) => counts.push(decodeValue('u32', b)));
    await clock.advanceAsync(500);
    expect(counts).toEqual([1]);

    const lost = jest.fn();
    dm.on('lost', lost);
    transport.dropLink(L, 'out of range');
    expect(lost).toHaveBeenCalledWith({ side: 'L', deviceId: L });
    expect(dm.getLink('L')).toMatchObject({ state: 'reconnecting', lastError: 'out of range' });

    await clock.advanceAsync(1000 + 100); // first backoff + connect latency
    expect(dm.getLink('L').state).toBe('ready');
    expect(dm.getLink('L').reconnectAttempt).toBe(0);
    await clock.advanceAsync(500); // device's first stride after reconnect
    // The stride counter lives on the device, so it continues across a BLE reconnect.
    expect(counts).toEqual([1, 2]);
    expect(states.L.slice(-2)).toEqual(['reconnecting', 'ready']);
  });

  it('backs off 1, 2, 4, 8, 15, 15 s between failed attempts', async () => {
    const { dm, clock, transport } = rig();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    transport.failNextConnects(L, 6);
    const t0 = clock.now();
    transport.dropLink(L);
    await clock.advanceAsync(80_000);
    const starts = dm
      .getEventLog()
      .filter((e) => e.type === 'connecting' && e.t > t0)
      .map((e) => e.t - t0);
    // each attempt starts after the delay; a failed attempt takes 50 ms (connect latency)
    expect(starts).toEqual([1000, 3050, 7100, 15150, 30200, 45250, 60300].slice(0, 7));
    expect(dm.getLink('L').state).toBe('ready');
  });

  it('manual disconnect cancels pending reconnects', async () => {
    const { dm, clock, transport } = rig();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    transport.dropLink(L);
    await dm.disconnect('L');
    await clock.advanceAsync(60_000);
    expect(dm.getLink('L').state).toBe('idle');
    expect(transport.isConnected(L)).toBe(false);
  });

  it('a manual disconnect is not treated as link loss', async () => {
    const { dm, clock } = rig();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    const lost = jest.fn();
    dm.on('lost', lost);
    await dm.disconnect('L');
    await clock.advanceAsync(60_000);
    expect(lost).not.toHaveBeenCalled();
    expect(eventTypes(dm)).toContain('disconnected');
    expect(dm.getLink('L').deviceId).toBe(L); // remembered for quick reconnect (F10)
  });

  it('retries immediately when the adapter powers back on', async () => {
    const { dm, clock, transport } = rig();
    await dm.init();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    transport.setAdapterState('poweredOff');
    expect(dm.getLink('L').state).toBe('reconnecting');
    await clock.advanceAsync(1100); // first retry fails: adapter still off
    expect(dm.getLink('L').state).toBe('reconnecting');
    transport.setAdapterState('poweredOn');
    await clock.advanceAsync(100); // well before the 2 s backoff
    expect(dm.getLink('L').state).toBe('ready');
  });

  it('quick-reconnects a remembered device without scanning (F10)', async () => {
    const { dm, clock } = rig();
    await expect(connectSide(dm, clock, R, 'R')).resolves.toBe('R');
  });

  it('forget clears the pairing (F11)', async () => {
    const { dm, clock } = rig();
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    await dm.forget('L');
    expect(dm.getLink('L')).toMatchObject({ state: 'idle', deviceId: null, name: null });
  });
});

describe('concurrency and teardown', () => {
  it('a disconnect during setup supersedes the in-flight connect', async () => {
    const { dm, clock, transport } = rig();
    await scan(dm, clock);
    const p = dm.connect(L);
    const assertion = expect(p).rejects.toThrow(/superseded/);
    await dm.disconnect('L');
    await clock.advanceAsync(200);
    await assertion;
    expect(dm.getLink('L').state).toBe('idle');
    await clock.advanceAsync(60_000);
    expect(dm.getLink('L').state).toBe('idle');
    expect(transport.isConnected(L) && dm.isReady('L')).toBe(false);
  });

  it('connectBoth returns the connect error for a side that fails', async () => {
    const { dm, clock, transport } = rig();
    await scan(dm, clock);
    transport.failNextConnects(R, 1);
    const p = dm.connectBoth();
    await clock.advanceAsync(200);
    const res = await p;
    expect(res.L).toBe('L');
    expect((res.R as Error).message).toMatch(/injected/);
  });

  it('disconnectAll idles both sides; getLinks exposes the snapshot', async () => {
    const { dm, clock } = rig();
    await scan(dm, clock);
    const p = dm.connectBoth();
    await clock.advanceAsync(200);
    await p;
    expect(dm.getLinks().L.state).toBe('ready');
    await dm.disconnectAll();
    expect(dm.getLinks().L.state).toBe('idle');
    expect(dm.getLinks().R.state).toBe('idle');
  });

  it('disconnect on an idle side is harmless', async () => {
    const { dm } = rig();
    await dm.disconnect('R');
    expect(dm.getLink('R').state).toBe('idle');
    expect(eventTypes(dm)).not.toContain('disconnected');
  });
});

describe('GATT operations', () => {
  it('reads and writes with spec encoding; refuses when not ready', async () => {
    const { dm, clock, transport } = rig();
    await expect(dm.write('L', 'syncMarker', 0xaa01, false)).rejects.toThrow(/not connected/);
    await expect(dm.read('L', 'bleMode')).rejects.toThrow(ConnectError);
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    await dm.write('L', 'syncMarker', 0xaa01, false);
    expect(transport.writes.at(-1)).toMatchObject({ key: 'syncMarker', withResponse: false });
    expect(Array.from(transport.writes.at(-1)!.value)).toEqual([0x01, 0xaa]);
    expect(await dm.read('L', 'deviceRole')).toBe(76);
    expect(await dm.readRssi('L')).toBe(-55);
  });

  it('attaches subscriptions made before ready and stops after unsubscribe', async () => {
    const { dm, clock } = rig();
    const got: number[] = [];
    const off = dm.subscribe('L', 'strideCount', (b) => got.push(decodeValue('u32', b)));
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    await clock.advanceAsync(500);
    expect(got).toEqual([1]);
    off();
    await clock.advanceAsync(5000);
    expect(got).toEqual([1]);
  });

  it('ignores subscriptions to characteristics the firmware lacks', async () => {
    const { dm, clock } = rig({ l: { omit: ['freezeIndex'] } });
    const got = jest.fn();
    dm.subscribe('L', 'freezeIndex', got);
    await scan(dm, clock);
    await connectSide(dm, clock, L);
    await clock.advanceAsync(5000);
    expect(got).not.toHaveBeenCalled();
  });

  it('dispose releases timers and subscriptions', async () => {
    const { dm, clock } = rig();
    await dm.init();
    await scan(dm, clock);
    const got = jest.fn();
    dm.subscribe('L', 'strideCount', got);
    dm.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });
});
