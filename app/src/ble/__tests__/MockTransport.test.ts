import { FakeClock } from '@/core/clock';
import { ADVERTISED_SERVICE_UUID } from '@/shared/generated/gatt';

import { decodeAiLabel, decodeValue, encodeValue } from '../codec';
import { charSpec, type CharKey } from '../gatt';
import { GAIT_NOTIFY_ORDER, MockTransport, type VirtualDeviceConfig } from '../MockTransport';
import { mirrorSide, session0007, type ReplayStride } from '../replay';
import type { ScanResult } from '../transport';

const L = 'dev-L';
const R = 'dev-R';

function setup(over: Partial<VirtualDeviceConfig> = {}, overR: Partial<VirtualDeviceConfig> = {}) {
  const clock = new FakeClock();
  const strides = session0007();
  const t = new MockTransport(clock, [
    { id: L, side: 'L', mode: 2, strides, rssi: -55, firstStrideDelayMs: 500, ...over },
    {
      id: R,
      side: 'R',
      mode: 2,
      strides: mirrorSide(strides, { swingAsymmetry: 0.05, lengthAsymmetry: -0.03 }),
      rssi: -70,
      ...overR,
    },
  ]);
  return { clock, t, strides };
}

const svc = (k: CharKey) => charSpec(k).serviceUuid;
const uuid = (k: CharKey) => charSpec(k).uuid;

async function connect(t: MockTransport, clock: FakeClock, id: string) {
  const p = t.connect(id, { mtu: 185 });
  await clock.advanceAsync(50);
  await p;
}

describe('replay data', () => {
  it('loads all 54 strides of session 0007', () => {
    const s = session0007();
    expect(s).toHaveLength(54);
    expect(s[0]!.strideTimeS).toBeCloseTo(1.409, 4);
    expect(s.every((x) => x.aiLabel === null)).toBe(true);
  });

  it('mirrors a contralateral side keeping swing + stance = stride', () => {
    const r = mirrorSide(session0007(), { swingAsymmetry: 0.1, lengthAsymmetry: 0.2 });
    const l = session0007();
    expect(r[5]!.swingTimeS).toBeCloseTo(l[5]!.swingTimeS * 1.1, 10);
    expect(r[5]!.swingTimeS + r[5]!.stanceTimeS).toBeCloseTo(r[5]!.strideTimeS, 10);
    expect(r[5]!.strideLengthM).toBeCloseTo(l[5]!.strideLengthM * 1.2, 10);
  });
});

describe('MockTransport scanning', () => {
  it('reports advertising devices periodically with RSSI and filters by service', () => {
    const { clock, t } = setup();
    const seen: ScanResult[] = [];
    t.startScan([ADVERTISED_SERVICE_UUID.toUpperCase()], (r) => seen.push(r), fail);
    clock.advance(0);
    expect(seen.map((r) => r.name)).toEqual(['ArcSense-L', 'ArcSense-R']);
    clock.advance(1000);
    expect(seen).toHaveLength(4);
    expect(Math.abs(seen[0]!.rssi! + 55)).toBeLessThanOrEqual(3);
    t.stopScan();
    clock.advance(5000);
    expect(seen).toHaveLength(4);

    const other: ScanResult[] = [];
    t.startScan(['0000180f-0000-1000-8000-00805f9b34fb'], (r) => other.push(r), fail);
    clock.advance(0);
    expect(other).toEqual([]);
  });

  it('hides devices that are out of range or already connected', async () => {
    const { clock, t } = setup();
    t.setAdvertising(R, false);
    await connect(t, clock, L);
    const seen: ScanResult[] = [];
    t.startScan(null, (r) => seen.push(r), fail);
    clock.advance(0);
    expect(seen).toEqual([]);
  });

  it('errors when the adapter is off', () => {
    const { t } = setup();
    t.setAdapterState('poweredOff');
    const onError = jest.fn();
    t.startScan(null, fail, onError);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/poweredOff/) }),
    );
  });
});

describe('MockTransport connection and GATT', () => {
  it('connects with latency, records MTU and priority, discovers the full map', async () => {
    const { clock, t } = setup();
    const p = t.connect(L, { mtu: 185 });
    await clock.advanceAsync(49);
    expect(t.isConnected(L)).toBe(false);
    await clock.advanceAsync(1);
    await p;
    expect(t.isConnected(L)).toBe(true);
    expect(t.requestedMtu(L)).toBe(185);
    await t.requestHighPriority(L);
    expect(t.isHighPriority(L)).toBe(true);
    expect(await t.discover(L)).toHaveLength(15);
    expect(await t.readRssi(L)).toBe(-55);
  });

  it('omits characteristics for partial firmware builds', async () => {
    const { clock, t } = setup({ omit: ['strideCount', 'labelMarker'] });
    await connect(t, clock, L);
    const keys = (await t.discover(L)).map((d) => d.uuid);
    expect(keys).not.toContain(uuid('strideCount'));
    await expect(t.read(L, svc('strideCount'), uuid('strideCount'))).rejects.toThrow(/not found/);
  });

  it('fails injected connects then succeeds', async () => {
    const { clock, t } = setup();
    t.failNextConnects(L, 1);
    const p1 = t.connect(L);
    const assertion = expect(p1).rejects.toThrow(/injected/);
    await clock.advanceAsync(50);
    await assertion;
    await connect(t, clock, L);
    expect(t.isConnected(L)).toBe(true);
  });

  it('rejects connecting to unreachable or unknown devices and when adapter is off', async () => {
    const { clock, t } = setup();
    t.setAdvertising(L, false);
    const p = t.connect(L);
    const a = expect(p).rejects.toThrow(/not reachable/);
    await clock.advanceAsync(50);
    await a;
    await expect(t.connect('nope')).rejects.toThrow(/unknown device/);
    t.setAdapterState('poweredOff');
    const p2 = t.connect(R);
    const b = expect(p2).rejects.toThrow(/adapter poweredOff/);
    await clock.advanceAsync(50);
    await b;
  });

  it('reads role, mode, and session start; rejects reads of write-only characteristics', async () => {
    const { clock, t } = setup({ roleCode: 82, mode: 1 });
    await connect(t, clock, L);
    expect(decodeValue('u8', await t.read(L, svc('deviceRole'), uuid('deviceRole')))).toBe(82);
    expect(decodeValue('u8', await t.read(L, svc('bleMode'), uuid('bleMode')))).toBe(1);
    await t.write(
      L,
      svc('sessionStartTimestamp'),
      uuid('sessionStartTimestamp'),
      encodeValue('u32', 123456),
      true,
    );
    expect(
      decodeValue(
        'u32',
        await t.read(L, svc('sessionStartTimestamp'), uuid('sessionStartTimestamp')),
      ),
    ).toBe(123456);
    await expect(t.read(L, svc('syncMarker'), uuid('syncMarker'))).rejects.toThrow(/not readable/);
    await expect(t.read(R, svc('bleMode'), uuid('bleMode'))).rejects.toThrow(/not connected/);
  });

  it('records writes with dispatch time and rejects non-writable characteristics', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    clock.advance(1234);
    await t.write(L, svc('syncMarker'), uuid('syncMarker'), encodeValue('u16', 0xaa01), false);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]).toMatchObject({
      t: 1284,
      deviceId: L,
      key: 'syncMarker',
      withResponse: false,
    });
    expect(Array.from(t.writes[0]!.value)).toEqual([0x01, 0xaa]);
    await expect(
      t.write(L, svc('strideTime'), uuid('strideTime'), new Uint8Array(4), true),
    ).rejects.toThrow(/not writable/);
  });
});

describe('MockTransport streaming', () => {
  function collect(t: MockTransport, id: string, keys: readonly CharKey[]) {
    const events: { key: CharKey; bytes: Uint8Array }[] = [];
    for (const key of keys) {
      t.monitor(id, svc(key), uuid(key), (bytes) => events.push({ key, bytes }), fail);
    }
    return events;
  }

  it('notifies every gait value once per stride in the configured order', async () => {
    const { clock, t, strides } = setup();
    await connect(t, clock, L);
    const events = collect(t, L, GAIT_NOTIFY_ORDER);
    clock.advance(500);
    expect(events.map((e) => e.key)).toEqual([...GAIT_NOTIFY_ORDER]);
    expect(decodeValue('f32', events[0]!.bytes)).toBeCloseTo(strides[0]!.strideTimeS, 5);
    expect(decodeValue('u32', events[7]!.bytes)).toBe(1);
    // next stride arrives one stride time later
    clock.advance(strides[0]!.strideTimeS * 1000 - 1);
    expect(events).toHaveLength(8);
    clock.advance(1);
    expect(events).toHaveLength(16);
    expect(decodeValue('u32', events[15]!.bytes)).toBe(2);
  });

  it('honours a custom notify order and replays at speed', async () => {
    const order: CharKey[] = ['strideCount', 'freezeIndex', 'strideTime'];
    const clock = new FakeClock();
    const t = new MockTransport(
      clock,
      [
        {
          id: L,
          side: 'L',
          mode: 2,
          strides: session0007(),
          notifyOrder: order,
          firstStrideDelayMs: 1000,
        },
      ],
      { speed: 10 },
    );
    await connect(t, clock, L);
    const events = collect(t, L, GAIT_NOTIFY_ORDER);
    clock.advance(100);
    expect(events.map((e) => e.key)).toEqual(order);
  });

  it('adds AI label and confidence in EDGE_AI mode', async () => {
    const strides: ReplayStride[] = session0007().map((s) => ({
      ...s,
      aiLabel: 2,
      aiConfidence: 0.75,
    }));
    const { clock, t } = setup({ mode: 1, strides });
    await connect(t, clock, L);
    const events = collect(t, L, [...GAIT_NOTIFY_ORDER, 'aiLabel', 'aiConfidence']);
    clock.advance(500);
    expect(events.slice(-2).map((e) => e.key)).toEqual(['aiLabel', 'aiConfidence']);
    expect(decodeAiLabel(events[8]!.bytes)).toBe(2);
    expect(decodeValue('f32', events[9]!.bytes)).toBeCloseTo(0.75, 6);
  });

  it('notifies nothing in DATA_COLLECTION mode but values stay readable', async () => {
    const { clock, t, strides } = setup({ mode: 0 });
    await connect(t, clock, L);
    const events = collect(t, L, GAIT_NOTIFY_ORDER);
    clock.advance(500 + strides[0]!.strideTimeS * 1000);
    expect(events).toEqual([]);
    expect(decodeValue('u32', await t.read(L, svc('strideCount'), uuid('strideCount')))).toBe(2);
    expect(decodeValue('f32', await t.read(L, svc('strideTime'), uuid('strideTime')))).toBeCloseTo(
      strides[1]!.strideTimeS,
      5,
    );
    expect(decodeAiLabel(await t.read(L, svc('aiLabel'), uuid('aiLabel')))).toBeNull();
  });

  it('reads zeros before the first stride', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    expect(decodeValue('f32', await t.read(L, svc('strideTime'), uuid('strideTime')))).toBe(0);
    expect(decodeValue('u32', await t.read(L, svc('strideCount'), uuid('strideCount')))).toBe(0);
  });

  it('injects raw notifications for malformed-packet tests', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    const events = collect(t, L, ['freezeIndex']);
    t.injectNotification(L, 'freezeIndex', Uint8Array.from([1, 2]));
    expect(events).toHaveLength(1);
    expect(events[0]!.bytes.length).toBe(2);
  });

  it('monitor reports errors for disconnected devices and unknown characteristics', async () => {
    const { clock, t } = setup({ omit: ['freezeIndex'] });
    const onError = jest.fn();
    t.monitor(L, svc('strideTime'), uuid('strideTime'), fail, onError).remove();
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/not connected/) }),
    );
    await connect(t, clock, L);
    t.monitor(L, svc('freezeIndex'), uuid('freezeIndex'), fail, onError);
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/not found/) }),
    );
  });
});

describe('MockTransport link loss', () => {
  it('drops the link: monitors error, disconnect callbacks get the error, striding stops', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    const onDisc = jest.fn();
    const onMonErr = jest.fn();
    const values = jest.fn();
    t.onDisconnected(L, onDisc);
    t.monitor(L, svc('strideTime'), uuid('strideTime'), values, onMonErr);
    t.dropLink(L, 'out of range');
    expect(t.isConnected(L)).toBe(false);
    expect(onDisc).toHaveBeenCalledWith(expect.objectContaining({ message: 'out of range' }));
    expect(onMonErr).toHaveBeenCalledTimes(1);
    clock.advance(10_000);
    expect(values).not.toHaveBeenCalled();
    t.dropLink(L); // no-op when already down
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  it('host disconnect reports null error; unsubscribed callbacks are not called', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    const a = jest.fn();
    const b = jest.fn();
    t.onDisconnected(L, a);
    t.onDisconnected(L, b).remove();
    await t.disconnect(L);
    await t.disconnect(L);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(null);
    expect(b).not.toHaveBeenCalled();
  });

  it('adapter power-off drops all links and notifies listeners', async () => {
    const { clock, t } = setup();
    await connect(t, clock, L);
    await connect(t, clock, R);
    const states: string[] = [];
    const sub = t.onAdapterStateChange((s) => states.push(s));
    const onDisc = jest.fn();
    t.onDisconnected(R, onDisc);
    t.setAdapterState('poweredOff');
    expect(await t.adapterState()).toBe('poweredOff');
    expect(states).toEqual(['poweredOff']);
    expect(t.isConnected(L) || t.isConnected(R)).toBe(false);
    expect(onDisc).toHaveBeenCalledWith(expect.objectContaining({ message: 'adapter off' }));
    sub.remove();
    t.setAdapterState('poweredOn');
    expect(states).toEqual(['poweredOff']);
  });
});

function fail(): never {
  throw new Error('unexpected callback');
}
