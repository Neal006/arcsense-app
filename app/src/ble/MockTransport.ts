/**
 * In-process BleTransport with virtual ArcSense devices (functionality F52/F53).
 *
 * Used by every service test and by the app's replay/demo mode. Each virtual
 * device behaves like the firmware described in docs/reference:
 *  - advertises the gait service under ArcSense-L / ArcSense-R
 *  - exposes the GATT map from /shared (optionally with characteristics removed)
 *  - in STREAMING / EDGE_AI mode notifies every gait value once per stride, in a
 *    configurable order, then the AI label/confidence in EDGE_AI mode
 *  - in DATA_COLLECTION mode notifies nothing; values are readable
 *  - records every write with the (fake) time it was dispatched
 * Fault injection: link drops, failing connects, adapter off, raw/malformed
 * notifications, and leaving range.
 */
import type { Clock, TimerHandle } from '@/core/clock';
import {
  ADVERTISED_SERVICE_UUID,
  CHARACTERISTICS,
  DEVICE_NAMES,
  ROLE_CODES,
} from '@/shared/generated/gatt';

import { encodeValue } from './codec';
import { charSpec, type CharKey, type Side } from './gatt';
import type { ReplayStride } from './replay';
import {
  TransportError,
  type AdapterState,
  type BleTransport,
  type ConnectOptions,
  type DiscoveredCharacteristic,
  type ScanResult,
  type Subscription,
} from './transport';

export const GAIT_NOTIFY_ORDER: readonly CharKey[] = [
  'strideTime',
  'swingTime',
  'stanceTime',
  'strideLength',
  'tibialShock',
  'asymmetryIndex',
  'freezeIndex',
  'strideCount',
];

export interface VirtualDeviceConfig {
  id: string;
  side: Side;
  /** Advertised name; defaults to the spec name for `side`. */
  name?: string;
  /** Role byte returned by 0x0009; defaults to the code for `side`. */
  roleCode?: number;
  /** BLE mode byte: 0 data collection, 1 edge AI, 2 streaming. */
  mode: number;
  strides: readonly ReplayStride[];
  rssi?: number;
  /** Characteristics this firmware build does not expose. */
  omit?: readonly CharKey[];
  /** Order in which a stride's values are notified. */
  notifyOrder?: readonly CharKey[];
  /** Delay before the first stride after subscriptions start (ms, real time). */
  firstStrideDelayMs?: number;
}

export interface WriteRecord {
  t: number;
  deviceId: string;
  key: CharKey | null;
  charUuid: string;
  value: Uint8Array;
  withResponse: boolean;
}

interface Monitor {
  charUuid: string;
  onValue: (v: Uint8Array) => void;
  onError: (e: Error) => void;
}

class VirtualDevice {
  connected = false;
  advertising = true;
  failConnects = 0;
  strideIndex = -1;
  strideCount = 0;
  sessionStart = 0;
  monitors = new Set<Monitor>();
  disconnectCbs = new Set<(e: Error | null) => void>();
  strideTimer: TimerHandle | null = null;
  highPriority = false;
  mtu: number | undefined;

  constructor(readonly cfg: VirtualDeviceConfig) {}

  get name(): string {
    return this.cfg.name ?? DEVICE_NAMES[this.cfg.side];
  }

  has(key: CharKey): boolean {
    return !(this.cfg.omit ?? []).includes(key);
  }

  current(): ReplayStride | undefined {
    const n = this.cfg.strides.length;
    if (n === 0 || this.strideIndex < 0) return undefined;
    return this.cfg.strides[this.strideIndex % n];
  }

  valueOf(key: CharKey): Uint8Array {
    const s = this.current();
    const spec = charSpec(key);
    switch (key) {
      case 'deviceRole':
        return encodeValue('u8', this.cfg.roleCode ?? ROLE_CODES[this.cfg.side]);
      case 'bleMode':
        return encodeValue('u8', this.cfg.mode);
      case 'sessionStartTimestamp':
        return encodeValue('u32', this.sessionStart);
      case 'strideCount':
        return encodeValue('u32', this.strideCount);
      case 'aiLabel':
        return encodeValue('u8', s?.aiLabel ?? 0xff);
      case 'aiConfidence':
        return encodeValue('f32', s?.aiConfidence ?? 0);
      default: {
        const field = GAIT_FIELD[key];
        if (!field) throw new TransportError(`${key} has no readable value`);
        return encodeValue(spec.type, s ? (s[field] as number) : 0);
      }
    }
  }
}

const GAIT_FIELD: Partial<Record<CharKey, keyof ReplayStride>> = {
  strideTime: 'strideTimeS',
  swingTime: 'swingTimeS',
  stanceTime: 'stanceTimeS',
  strideLength: 'strideLengthM',
  tibialShock: 'tibialShockG',
  asymmetryIndex: 'asymmetryIndex',
  freezeIndex: 'freezeIndex',
};

export class MockTransport implements BleTransport {
  readonly writes: WriteRecord[] = [];
  private devices = new Map<string, VirtualDevice>();
  private state: AdapterState = 'poweredOn';
  private adapterCbs = new Set<(s: AdapterState) => void>();
  private scanTimer: TimerHandle | null = null;
  private scanning = false;

  constructor(
    private readonly clock: Clock,
    configs: readonly VirtualDeviceConfig[],
    private readonly opts: {
      speed?: number;
      connectLatencyMs?: number;
      scanIntervalMs?: number;
    } = {},
  ) {
    for (const c of configs) this.devices.set(c.id, new VirtualDevice(c));
  }

  // ---- test / demo controls ------------------------------------------------

  setAdapterState(state: AdapterState): void {
    this.state = state;
    for (const cb of [...this.adapterCbs]) cb(state);
    if (state !== 'poweredOn') {
      this.stopScan();
      for (const d of this.devices.values()) if (d.connected) this.linkLost(d, 'adapter off');
    }
  }

  /** Simulate an unexpected link loss (out of range, device reset). */
  dropLink(deviceId: string, reason = 'connection lost'): void {
    const d = this.device(deviceId);
    if (d.connected) this.linkLost(d, reason);
  }

  setAdvertising(deviceId: string, advertising: boolean): void {
    this.device(deviceId).advertising = advertising;
  }

  failNextConnects(deviceId: string, count: number): void {
    this.device(deviceId).failConnects = count;
  }

  /** Deliver arbitrary bytes on a characteristic (malformed-packet injection). */
  injectNotification(deviceId: string, key: CharKey, bytes: Uint8Array): void {
    const uuid = charSpec(key).uuid;
    for (const m of [...this.device(deviceId).monitors]) if (m.charUuid === uuid) m.onValue(bytes);
  }

  isConnected(deviceId: string): boolean {
    return this.device(deviceId).connected;
  }

  isHighPriority(deviceId: string): boolean {
    return this.device(deviceId).highPriority;
  }

  requestedMtu(deviceId: string): number | undefined {
    return this.device(deviceId).mtu;
  }

  strideCountOf(deviceId: string): number {
    return this.device(deviceId).strideCount;
  }

  // ---- BleTransport ----------------------------------------------------------

  async adapterState(): Promise<AdapterState> {
    return this.state;
  }

  onAdapterStateChange(cb: (state: AdapterState) => void): Subscription {
    this.adapterCbs.add(cb);
    return { remove: () => this.adapterCbs.delete(cb) };
  }

  startScan(
    serviceUuids: string[] | null,
    onResult: (r: ScanResult) => void,
    onError: (e: Error) => void,
  ): void {
    if (this.state !== 'poweredOn') {
      onError(new TransportError(`cannot scan: adapter ${this.state}`));
      return;
    }
    this.stopScan();
    this.scanning = true;
    const interval = this.opts.scanIntervalMs ?? 1000;
    let round = 0;
    const emit = () => {
      if (!this.scanning) return;
      for (const d of this.devices.values()) {
        if (!d.advertising || d.connected) continue;
        if (
          serviceUuids &&
          !serviceUuids.map((u) => u.toLowerCase()).includes(ADVERTISED_SERVICE_UUID)
        ) {
          continue;
        }
        // deterministic RSSI wobble of +/-3 dB around the configured level
        const rssi = (d.cfg.rssi ?? -60) + (((round + d.cfg.id.length) % 7) - 3);
        onResult({ id: d.cfg.id, name: d.name, rssi, serviceUuids: [ADVERTISED_SERVICE_UUID] });
      }
      round++;
      this.scanTimer = this.clock.setTimeout(emit, interval);
    };
    this.scanTimer = this.clock.setTimeout(emit, 0);
  }

  stopScan(): void {
    this.scanning = false;
    if (this.scanTimer !== null) this.clock.clearTimeout(this.scanTimer);
    this.scanTimer = null;
  }

  async connect(deviceId: string, options?: ConnectOptions): Promise<void> {
    const d = this.device(deviceId);
    await this.sleep(this.opts.connectLatencyMs ?? 50);
    if (this.state !== 'poweredOn') throw new TransportError(`adapter ${this.state}`);
    if (d.connected) return;
    if (!d.advertising) throw new TransportError(`device ${deviceId} not reachable`);
    if (d.failConnects > 0) {
      d.failConnects--;
      throw new TransportError(`connection to ${deviceId} failed (injected)`);
    }
    d.connected = true;
    d.mtu = options?.mtu;
    this.ensureStriding(d);
  }

  async disconnect(deviceId: string): Promise<void> {
    const d = this.device(deviceId);
    if (!d.connected) return;
    this.teardown(d, new TransportError('disconnected by host'));
    for (const cb of [...d.disconnectCbs]) cb(null);
  }

  onDisconnected(deviceId: string, cb: (error: Error | null) => void): Subscription {
    const d = this.device(deviceId);
    d.disconnectCbs.add(cb);
    return { remove: () => d.disconnectCbs.delete(cb) };
  }

  async discover(deviceId: string): Promise<DiscoveredCharacteristic[]> {
    const d = this.requireConnected(deviceId);
    return CHARACTERISTICS.filter((c) => d.has(c.key)).map((c) => {
      const props = c.props as readonly string[];
      return {
        serviceUuid: c.serviceUuid,
        uuid: c.uuid,
        isReadable: props.includes('read'),
        isNotifiable: props.includes('notify'),
        isWritableWithResponse: props.includes('write'),
        isWritableWithoutResponse: props.includes('write'),
      };
    });
  }

  async read(deviceId: string, _serviceUuid: string, charUuid: string): Promise<Uint8Array> {
    const d = this.requireConnected(deviceId);
    const spec = this.specFor(d, charUuid);
    if (!(spec.props as readonly string[]).includes('read')) {
      throw new TransportError(`${spec.key} is not readable`);
    }
    return d.valueOf(spec.key);
  }

  async write(
    deviceId: string,
    _serviceUuid: string,
    charUuid: string,
    value: Uint8Array,
    withResponse: boolean,
  ): Promise<void> {
    // Record at dispatch time, before any await, like a real stack queuing the PDU.
    const t = this.clock.now();
    const d = this.requireConnected(deviceId);
    const spec = this.specFor(d, charUuid);
    if (!(spec.props as readonly string[]).includes('write')) {
      throw new TransportError(`${spec.key} is not writable`);
    }
    this.writes.push({
      t,
      deviceId,
      key: spec.key,
      charUuid: spec.uuid,
      value: value.slice(),
      withResponse,
    });
    if (spec.key === 'sessionStartTimestamp' && value.length === 4) {
      d.sessionStart = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
    }
  }

  monitor(
    deviceId: string,
    _serviceUuid: string,
    charUuid: string,
    onValue: (v: Uint8Array) => void,
    onError: (e: Error) => void,
  ): Subscription {
    const d = this.device(deviceId);
    if (!d.connected) {
      onError(new TransportError(`device ${deviceId} not connected`));
      return { remove: () => undefined };
    }
    let spec;
    try {
      spec = this.specFor(d, charUuid);
    } catch (e) {
      onError(e as Error);
      return { remove: () => undefined };
    }
    const m: Monitor = { charUuid: spec.uuid, onValue, onError };
    d.monitors.add(m);
    return {
      remove: () => {
        d.monitors.delete(m);
      },
    };
  }

  async requestHighPriority(deviceId: string): Promise<void> {
    this.requireConnected(deviceId).highPriority = true;
  }

  async readRssi(deviceId: string): Promise<number> {
    return this.requireConnected(deviceId).cfg.rssi ?? -60;
  }

  // ---- internals -------------------------------------------------------------

  private device(id: string): VirtualDevice {
    const d = this.devices.get(id);
    if (!d) throw new TransportError(`unknown device ${id}`);
    return d;
  }

  private requireConnected(id: string): VirtualDevice {
    const d = this.device(id);
    if (!d.connected) throw new TransportError(`device ${id} not connected`);
    return d;
  }

  private specFor(d: VirtualDevice, charUuid: string) {
    const spec = CHARACTERISTICS.find((c) => c.uuid === charUuid.toLowerCase());
    if (!spec || !d.has(spec.key)) throw new TransportError(`characteristic ${charUuid} not found`);
    return spec;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.clock.setTimeout(r, ms));
  }

  private speed(): number {
    return this.opts.speed ?? 1;
  }

  /** The wearer walks continuously while the device is connected. */
  private ensureStriding(d: VirtualDevice): void {
    if (d.strideTimer !== null || d.cfg.strides.length === 0) return;
    const scheduleNext = (delayMs: number) => {
      d.strideTimer = this.clock.setTimeout(() => {
        d.strideTimer = null;
        if (!d.connected) return;
        this.emitStride(d);
        const s = d.current()!;
        scheduleNext((s.strideTimeS * 1000) / this.speed());
      }, delayMs);
    };
    scheduleNext((d.cfg.firstStrideDelayMs ?? 1000) / this.speed());
  }

  private emitStride(d: VirtualDevice): void {
    d.strideIndex++;
    d.strideCount++;
    if (d.cfg.mode === 0) return; // DATA_COLLECTION: characteristics are not notified
    const order = [...(d.cfg.notifyOrder ?? GAIT_NOTIFY_ORDER)];
    if (d.cfg.mode === 1) order.push('aiLabel', 'aiConfidence');
    for (const key of order) {
      if (!d.has(key)) continue;
      const uuid = charSpec(key).uuid;
      const bytes = d.valueOf(key);
      for (const m of [...d.monitors]) if (m.charUuid === uuid) m.onValue(bytes);
    }
  }

  private teardown(d: VirtualDevice, monitorError: Error): void {
    d.connected = false;
    d.highPriority = false;
    if (d.strideTimer !== null) this.clock.clearTimeout(d.strideTimer);
    d.strideTimer = null;
    const monitors = [...d.monitors];
    d.monitors.clear();
    for (const m of monitors) m.onError(monitorError);
  }

  private linkLost(d: VirtualDevice, reason: string): void {
    const err = new TransportError(reason);
    this.teardown(d, err);
    for (const cb of [...d.disconnectCbs]) cb(err);
  }
}
