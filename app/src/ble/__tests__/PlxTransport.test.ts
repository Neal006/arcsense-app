import { encodeBase64 } from '../codec';
import { mapState, PlxTransport, type PlxManager } from '../PlxTransport';
import { TransportError } from '../transport';

jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn(),
  ConnectionPriority: { Balanced: 0, High: 1, LowPower: 2 },
}));

type Listener = (error: unknown, value: unknown) => void;

function fakeManager() {
  const subs = { remove: jest.fn() };
  let scanListener: Listener | null = null;
  let monitorListener: Listener | null = null;
  let disconnectListener: Listener | null = null;
  const m = {
    state: jest.fn().mockResolvedValue('PoweredOn'),
    onStateChange: jest.fn((cb: (s: string) => void) => {
      cb('PoweredOff');
      return subs;
    }),
    startDeviceScan: jest.fn(async (_u: unknown, _o: unknown, l: Listener) => {
      scanListener = l;
    }),
    stopDeviceScan: jest.fn().mockResolvedValue(undefined),
    connectToDevice: jest.fn().mockResolvedValue({}),
    cancelDeviceConnection: jest.fn().mockResolvedValue({}),
    onDeviceDisconnected: jest.fn((_id: string, l: Listener) => {
      disconnectListener = l;
      return subs;
    }),
    discoverAllServicesAndCharacteristicsForDevice: jest.fn().mockResolvedValue({}),
    servicesForDevice: jest
      .fn()
      .mockResolvedValue([{ uuid: '19B10010-E8F2-537E-4F6C-D104768A1214' }]),
    characteristicsForDevice: jest.fn().mockResolvedValue([
      {
        uuid: '19B10011-E8F2-537E-4F6C-D104768A1214',
        isReadable: false,
        isNotifiable: false,
        isIndicatable: true,
        isWritableWithResponse: true,
        isWritableWithoutResponse: false,
      },
    ]),
    readCharacteristicForDevice: jest
      .fn()
      .mockResolvedValue({ value: encodeBase64(Uint8Array.from([76])) }),
    writeCharacteristicWithResponseForDevice: jest.fn().mockResolvedValue({}),
    writeCharacteristicWithoutResponseForDevice: jest.fn().mockResolvedValue({}),
    monitorCharacteristicForDevice: jest.fn((_d: string, _s: string, _c: string, l: Listener) => {
      monitorListener = l;
      return subs;
    }),
    requestConnectionPriorityForDevice: jest.fn().mockResolvedValue({}),
    readRSSIForDevice: jest.fn().mockResolvedValue({ rssi: -61 }),
  };
  return {
    m,
    subs,
    scan: (e: unknown, d: unknown) => scanListener!(e, d),
    notify: (e: unknown, c: unknown) => monitorListener!(e, c),
    drop: (e: unknown) => disconnectListener!(e, {}),
    asManager: m as unknown as PlxManager,
  };
}

describe('PlxTransport', () => {
  it('maps adapter states', async () => {
    expect(mapState('PoweredOn')).toBe('poweredOn');
    expect(mapState('Unauthorized')).toBe('unauthorized');
    expect(mapState('Weird')).toBe('unknown');
    const f = fakeManager();
    const t = new PlxTransport(f.asManager, 'android');
    expect(await t.adapterState()).toBe('poweredOn');
    const seen: string[] = [];
    t.onAdapterStateChange((s) => seen.push(s)).remove();
    expect(seen).toEqual(['poweredOff']);
    expect(f.subs.remove).toHaveBeenCalled();
  });

  it('scans with duplicates allowed and normalises results', () => {
    const f = fakeManager();
    const t = new PlxTransport(f.asManager, 'android');
    const results: unknown[] = [];
    const errors: Error[] = [];
    t.startScan(
      ['abc'],
      (r) => results.push(r),
      (e) => errors.push(e),
    );
    expect(f.m.startDeviceScan).toHaveBeenCalledWith(
      ['abc'],
      { allowDuplicates: true },
      expect.any(Function),
    );
    f.scan(null, {
      id: 'X',
      name: null,
      localName: 'ArcSense-L',
      rssi: -50,
      serviceUUIDs: ['ABC'],
    });
    f.scan(null, null);
    f.scan({ message: 'scan failed', errorCode: 600 }, null);
    expect(results).toEqual([{ id: 'X', name: 'ArcSense-L', rssi: -50, serviceUuids: ['abc'] }]);
    expect(errors[0]).toBeInstanceOf(TransportError);
    expect(errors[0]!.message).toBe('scan failed [600]');
    t.stopScan();
    expect(f.m.stopDeviceScan).toHaveBeenCalled();
  });

  it('requests MTU on Android only and passes the timeout', async () => {
    const f = fakeManager();
    await new PlxTransport(f.asManager, 'android').connect('X', { mtu: 185, timeoutMs: 5000 });
    expect(f.m.connectToDevice).toHaveBeenLastCalledWith('X', { requestMTU: 185, timeout: 5000 });
    await new PlxTransport(f.asManager, 'ios').connect('X', { mtu: 185 });
    expect(f.m.connectToDevice).toHaveBeenLastCalledWith('X', {});
  });

  it('wraps native errors as TransportError', async () => {
    const f = fakeManager();
    f.m.connectToDevice.mockRejectedValueOnce({ message: 'Device not found', errorCode: 205 });
    const t = new PlxTransport(f.asManager, 'android');
    await expect(t.connect('X')).rejects.toThrow(new TransportError('Device not found [205]'));
    f.m.readCharacteristicForDevice.mockRejectedValueOnce(new Error('gatt 133'));
    await expect(t.read('X', 's', 'c')).rejects.toBeInstanceOf(TransportError);
    f.m.cancelDeviceConnection.mockRejectedValueOnce('boom');
    await expect(t.disconnect('X')).rejects.toThrow('boom');
  });

  it('reports disconnects with and without error', () => {
    const f = fakeManager();
    const t = new PlxTransport(f.asManager, 'android');
    const cb = jest.fn();
    t.onDisconnected('X', cb);
    f.drop(null);
    f.drop({ message: 'link loss' });
    expect(cb.mock.calls[0]![0]).toBeNull();
    expect(cb.mock.calls[1]![0]).toEqual(new TransportError('link loss'));
  });

  it('discovers characteristics with lowercase UUIDs; indicate counts as notify', async () => {
    const f = fakeManager();
    const chars = await new PlxTransport(f.asManager, 'android').discover('X');
    expect(chars).toEqual([
      {
        serviceUuid: '19b10010-e8f2-537e-4f6c-d104768a1214',
        uuid: '19b10011-e8f2-537e-4f6c-d104768a1214',
        isReadable: false,
        isNotifiable: true,
        isWritableWithResponse: true,
        isWritableWithoutResponse: false,
      },
    ]);
    f.m.servicesForDevice.mockRejectedValueOnce(new Error('x'));
    await expect(new PlxTransport(f.asManager).discover('X')).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('reads and writes bytes via base64', async () => {
    const f = fakeManager();
    const t = new PlxTransport(f.asManager, 'android');
    expect(Array.from(await t.read('X', 's', 'c'))).toEqual([76]);
    f.m.readCharacteristicForDevice.mockResolvedValueOnce({ value: null });
    expect((await t.read('X', 's', 'c')).length).toBe(0);
    await t.write('X', 's', 'c', Uint8Array.from([0x01, 0xaa]), false);
    expect(f.m.writeCharacteristicWithoutResponseForDevice).toHaveBeenCalledWith(
      'X',
      's',
      'c',
      'Aao=',
    );
    await t.write('X', 's', 'c', Uint8Array.from([0x01, 0xaa]), true);
    expect(f.m.writeCharacteristicWithResponseForDevice).toHaveBeenCalledWith(
      'X',
      's',
      'c',
      'Aao=',
    );
    f.m.writeCharacteristicWithResponseForDevice.mockRejectedValueOnce({ message: 'busy' });
    await expect(t.write('X', 's', 'c', new Uint8Array(1), true)).rejects.toThrow('busy');
  });

  it('monitors values, routes errors, and ignores callbacks after removal', () => {
    const f = fakeManager();
    const t = new PlxTransport(f.asManager, 'android');
    const values: number[][] = [];
    const errors: Error[] = [];
    const sub = t.monitor(
      'X',
      's',
      'c',
      (v) => values.push(Array.from(v)),
      (e) => errors.push(e),
    );
    f.notify(null, { value: 'TA==' });
    f.notify(null, { value: null });
    f.notify(null, { value: 'not base64!' });
    f.notify({ message: 'disconnected' }, null);
    expect(values).toEqual([[76]]);
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/base64/), 'disconnected']);
    sub.remove();
    f.notify(null, { value: 'TA==' });
    expect(values).toHaveLength(1);
  });

  it('requests high priority on Android only; reads RSSI', async () => {
    const f = fakeManager();
    await new PlxTransport(f.asManager, 'ios').requestHighPriority('X');
    expect(f.m.requestConnectionPriorityForDevice).not.toHaveBeenCalled();
    await new PlxTransport(f.asManager, 'android').requestHighPriority('X');
    expect(f.m.requestConnectionPriorityForDevice).toHaveBeenCalledWith('X', 1);
    f.m.requestConnectionPriorityForDevice.mockRejectedValueOnce({ message: 'no' });
    await expect(new PlxTransport(f.asManager, 'android').requestHighPriority('X')).rejects.toThrow(
      'no',
    );
    expect(await new PlxTransport(f.asManager).readRssi('X')).toBe(-61);
    f.m.readRSSIForDevice.mockResolvedValueOnce({ rssi: null });
    await expect(new PlxTransport(f.asManager).readRssi('X')).rejects.toThrow(/unavailable/);
    f.m.readRSSIForDevice.mockRejectedValueOnce({ message: 'gone' });
    await expect(new PlxTransport(f.asManager).readRssi('X')).rejects.toThrow('gone');
  });

  it('surfaces a rejected startDeviceScan promise', async () => {
    const f = fakeManager();
    f.m.startDeviceScan.mockRejectedValueOnce({ message: 'BluetoothUnauthorized', errorCode: 101 });
    const errors: Error[] = [];
    new PlxTransport(f.asManager, 'android').startScan(null, jest.fn(), (e) => errors.push(e));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors[0]!.message).toBe('BluetoothUnauthorized [101]');
  });
});
