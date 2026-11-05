/**
 * BleTransport backed by react-native-ble-plx. The only file that talks to the
 * native BLE stack; base64 <-> bytes conversion happens here and nowhere else.
 */
import { Platform } from 'react-native';
import {
  BleManager,
  ConnectionPriority,
  type BleError,
  type Characteristic,
  type Device,
  type State,
} from 'react-native-ble-plx';

import { decodeBase64, encodeBase64 } from './codec';
import {
  TransportError,
  type AdapterState,
  type BleTransport,
  type ConnectOptions,
  type DiscoveredCharacteristic,
  type ScanResult,
  type Subscription,
} from './transport';

/** The subset of BleManager used here; lets tests supply a fake. */
export type PlxManager = Pick<
  BleManager,
  | 'state'
  | 'onStateChange'
  | 'startDeviceScan'
  | 'stopDeviceScan'
  | 'connectToDevice'
  | 'cancelDeviceConnection'
  | 'onDeviceDisconnected'
  | 'discoverAllServicesAndCharacteristicsForDevice'
  | 'servicesForDevice'
  | 'characteristicsForDevice'
  | 'readCharacteristicForDevice'
  | 'writeCharacteristicWithResponseForDevice'
  | 'writeCharacteristicWithoutResponseForDevice'
  | 'monitorCharacteristicForDevice'
  | 'requestConnectionPriorityForDevice'
  | 'readRSSIForDevice'
>;

const STATE_MAP: Record<string, AdapterState> = {
  Unknown: 'unknown',
  Resetting: 'resetting',
  Unsupported: 'unsupported',
  Unauthorized: 'unauthorized',
  PoweredOff: 'poweredOff',
  PoweredOn: 'poweredOn',
};

export function mapState(s: State | string): AdapterState {
  return STATE_MAP[s] ?? 'unknown';
}

function wrap(e: unknown): TransportError {
  if (e instanceof TransportError) return e;
  const err = e as Partial<BleError> & { message?: string };
  const code = err?.errorCode !== undefined ? ` [${err.errorCode}]` : '';
  return new TransportError(`${err?.message ?? String(e)}${code}`);
}

export class PlxTransport implements BleTransport {
  constructor(
    private readonly manager: PlxManager = new BleManager(),
    private readonly os: string = Platform.OS,
  ) {}

  async adapterState(): Promise<AdapterState> {
    return mapState(await this.manager.state());
  }

  onAdapterStateChange(cb: (state: AdapterState) => void): Subscription {
    const sub = this.manager.onStateChange((s) => cb(mapState(s)), false);
    return { remove: () => sub.remove() };
  }

  startScan(
    serviceUuids: string[] | null,
    onResult: (r: ScanResult) => void,
    onError: (e: Error) => void,
  ): void {
    void this.manager
      .startDeviceScan(serviceUuids, { allowDuplicates: true }, (error, device) => {
        if (error) {
          onError(wrap(error));
          return;
        }
        if (!device) return;
        onResult({
          id: device.id,
          name: device.name ?? device.localName ?? null,
          rssi: device.rssi ?? null,
          serviceUuids: (device.serviceUUIDs ?? []).map((u) => u.toLowerCase()),
        });
      })
      .catch((e: unknown) => onError(wrap(e)));
  }

  stopScan(): void {
    void this.manager.stopDeviceScan();
  }

  async connect(deviceId: string, options?: ConnectOptions): Promise<void> {
    try {
      await this.manager.connectToDevice(deviceId, {
        // MTU negotiation is Android-only; iOS negotiates automatically.
        ...(this.os === 'android' && options?.mtu ? { requestMTU: options.mtu } : {}),
        ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
      });
    } catch (e) {
      throw wrap(e);
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    try {
      await this.manager.cancelDeviceConnection(deviceId);
    } catch (e) {
      throw wrap(e);
    }
  }

  onDisconnected(deviceId: string, cb: (error: Error | null) => void): Subscription {
    const sub = this.manager.onDeviceDisconnected(deviceId, (error: BleError | null) =>
      cb(error ? wrap(error) : null),
    );
    return { remove: () => sub.remove() };
  }

  async discover(deviceId: string): Promise<DiscoveredCharacteristic[]> {
    try {
      await this.manager.discoverAllServicesAndCharacteristicsForDevice(deviceId);
      const out: DiscoveredCharacteristic[] = [];
      for (const svc of await this.manager.servicesForDevice(deviceId)) {
        for (const c of await this.manager.characteristicsForDevice(deviceId, svc.uuid)) {
          out.push({
            serviceUuid: svc.uuid.toLowerCase(),
            uuid: c.uuid.toLowerCase(),
            isReadable: c.isReadable,
            isNotifiable: c.isNotifiable || c.isIndicatable,
            isWritableWithResponse: c.isWritableWithResponse,
            isWritableWithoutResponse: c.isWritableWithoutResponse,
          });
        }
      }
      return out;
    } catch (e) {
      throw wrap(e);
    }
  }

  async read(deviceId: string, serviceUuid: string, charUuid: string): Promise<Uint8Array> {
    let c: Characteristic;
    try {
      c = await this.manager.readCharacteristicForDevice(deviceId, serviceUuid, charUuid);
    } catch (e) {
      throw wrap(e);
    }
    return c.value ? decodeBase64(c.value) : new Uint8Array(0);
  }

  async write(
    deviceId: string,
    serviceUuid: string,
    charUuid: string,
    value: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    const b64 = encodeBase64(value);
    try {
      if (withResponse) {
        await this.manager.writeCharacteristicWithResponseForDevice(
          deviceId,
          serviceUuid,
          charUuid,
          b64,
        );
      } else {
        await this.manager.writeCharacteristicWithoutResponseForDevice(
          deviceId,
          serviceUuid,
          charUuid,
          b64,
        );
      }
    } catch (e) {
      throw wrap(e);
    }
  }

  monitor(
    deviceId: string,
    serviceUuid: string,
    charUuid: string,
    onValue: (v: Uint8Array) => void,
    onError: (e: Error) => void,
  ): Subscription {
    let removed = false;
    const sub = this.manager.monitorCharacteristicForDevice(
      deviceId,
      serviceUuid,
      charUuid,
      (error, c) => {
        if (removed) return;
        if (error) {
          onError(wrap(error));
          return;
        }
        if (!c?.value) return;
        try {
          onValue(decodeBase64(c.value));
        } catch (e) {
          onError(wrap(e));
        }
      },
    );
    return {
      remove: () => {
        removed = true;
        sub.remove();
      },
    };
  }

  async requestHighPriority(deviceId: string): Promise<void> {
    if (this.os !== 'android') return; // iOS has no API for this
    try {
      await this.manager.requestConnectionPriorityForDevice(deviceId, ConnectionPriority.High);
    } catch (e) {
      throw wrap(e);
    }
  }

  async readRssi(deviceId: string): Promise<number> {
    let d: Device;
    try {
      d = await this.manager.readRSSIForDevice(deviceId);
    } catch (e) {
      throw wrap(e);
    }
    if (d.rssi === null || d.rssi === undefined) throw new TransportError('RSSI unavailable');
    return d.rssi;
  }
}
