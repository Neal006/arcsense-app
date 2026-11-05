/**
 * Transport abstraction over the platform BLE stack. Everything above this
 * interface (DeviceManager, SyncService, acquisition) is platform-independent
 * and is tested against MockTransport. Values cross this boundary as raw bytes;
 * base64 is an implementation detail of PlxTransport.
 */
export type AdapterState =
  'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';

export interface ScanResult {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: string[];
}

export interface DiscoveredCharacteristic {
  serviceUuid: string;
  uuid: string;
  isReadable: boolean;
  isWritableWithResponse: boolean;
  isWritableWithoutResponse: boolean;
  isNotifiable: boolean;
}

export interface Subscription {
  remove(): void;
}

export interface ConnectOptions {
  /** Requested ATT MTU (Android only; iOS negotiates automatically). */
  mtu?: number;
  timeoutMs?: number;
}

export interface BleTransport {
  adapterState(): Promise<AdapterState>;
  onAdapterStateChange(cb: (state: AdapterState) => void): Subscription;

  startScan(
    serviceUuids: string[] | null,
    onResult: (result: ScanResult) => void,
    onError: (error: Error) => void,
  ): void;
  stopScan(): void;

  connect(deviceId: string, options?: ConnectOptions): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  /** Fires once per link loss. `error` is null for a locally requested disconnect. */
  onDisconnected(deviceId: string, cb: (error: Error | null) => void): Subscription;

  discover(deviceId: string): Promise<DiscoveredCharacteristic[]>;
  read(deviceId: string, serviceUuid: string, charUuid: string): Promise<Uint8Array>;
  write(
    deviceId: string,
    serviceUuid: string,
    charUuid: string,
    value: Uint8Array,
    withResponse: boolean,
  ): Promise<void>;
  monitor(
    deviceId: string,
    serviceUuid: string,
    charUuid: string,
    onValue: (value: Uint8Array) => void,
    onError: (error: Error) => void,
  ): Subscription;

  /** Android: request the 7.5 ms connection interval. No-op where unsupported. */
  requestHighPriority(deviceId: string): Promise<void>;
  readRssi(deviceId: string): Promise<number>;
}

export class TransportError extends Error {
  override name = 'TransportError';
}
