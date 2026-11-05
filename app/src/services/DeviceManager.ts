/**
 * Owns the BLE links to ArcSense-L and ArcSense-R (functionalities F04-F12).
 *
 * - scanning with de-duplication and a timeout (F04)
 * - side identification: advertised name gives the expected side, the Device
 *   Role characteristic decides (F05)
 * - connect with MTU + high connection priority, GATT discovery and validation,
 *   BLE mode detection (F06-F08)
 * - automatic reconnect with exponential backoff after link loss, cancelled by a
 *   manual disconnect (F09)
 * - durable subscriptions that are re-attached after every reconnect, so
 *   services never handle reconnection themselves
 * - a connection event log for the session record (F12)
 */
import { decodeValue, encodeValue } from '@/ble/codec';
import {
  bleModeFromCode,
  charSpec,
  sideFromName,
  sideFromRoleCode,
  SIDES,
  validateGatt,
  type BleMode,
  type CharKey,
  type GattReport,
  type Side,
} from '@/ble/gatt';
import type { AdapterState, BleTransport, Subscription } from '@/ble/transport';
import type { Clock, TimerHandle } from '@/core/clock';
import { Emitter, type Unsubscribe } from '@/core/emitter';
import { ADVERTISED_SERVICE_UUID } from '@/shared/generated/gatt';

export type LinkState = 'idle' | 'connecting' | 'discovering' | 'ready' | 'reconnecting';

export interface SideLink {
  side: Side;
  deviceId: string | null;
  name: string | null;
  state: LinkState;
  mode: BleMode | null;
  gatt: GattReport | null;
  reconnectAttempt: number;
  lastError: string | null;
  readyAt: number | null;
}

export interface DiscoveredDevice {
  id: string;
  name: string | null;
  side: Side | null;
  rssi: number | null;
  lastSeen: number;
}

export type ConnectionEventType =
  | 'adapter_state'
  | 'scan_started'
  | 'scan_stopped'
  | 'scan_error'
  | 'connecting'
  | 'ready'
  | 'role_mismatch'
  | 'gatt_incomplete'
  | 'priority_failed'
  | 'disconnected'
  | 'link_lost'
  | 'reconnect_scheduled'
  | 'connect_failed'
  | 'monitor_error';

export interface ConnectionEvent {
  t: number;
  wall: number;
  type: ConnectionEventType;
  side: Side | null;
  deviceId: string | null;
  detail: string | null;
}

export interface DeviceManagerEvents extends Record<string, unknown> {
  links: Readonly<Record<Side, SideLink>>;
  scan: readonly DiscoveredDevice[];
  scanning: boolean;
  adapter: AdapterState;
  event: ConnectionEvent;
  ready: { side: Side; deviceId: string; mode: BleMode | null };
  lost: { side: Side; deviceId: string };
}

export interface DeviceManagerOptions {
  mtu: number;
  connectTimeoutMs: number;
  scanTimeoutMs: number;
  /** Reconnect delays; the last entry repeats indefinitely. */
  backoffMs: readonly number[];
}

export const DEFAULT_DEVICE_MANAGER_OPTIONS: DeviceManagerOptions = {
  mtu: 185,
  connectTimeoutMs: 10_000,
  scanTimeoutMs: 15_000,
  backoffMs: [1000, 2000, 4000, 8000, 15_000],
};

export class ConnectError extends Error {
  override name = 'ConnectError';
}

interface Durable {
  side: Side;
  key: CharKey;
  onValue: (bytes: Uint8Array) => void;
  active: Subscription | null;
}

interface LinkInternals {
  generation: number;
  manual: boolean;
  disconnectSub: Subscription | null;
  retryTimer: TimerHandle | null;
}

function emptyLink(side: Side): SideLink {
  return {
    side,
    deviceId: null,
    name: null,
    state: 'idle',
    mode: null,
    gatt: null,
    reconnectAttempt: 0,
    lastError: null,
    readyAt: null,
  };
}

export class DeviceManager {
  private readonly emitter = new Emitter<DeviceManagerEvents>();
  private readonly opts: DeviceManagerOptions;
  private links: Record<Side, SideLink> = { L: emptyLink('L'), R: emptyLink('R') };
  private internals: Record<Side, LinkInternals> = {
    L: { generation: 0, manual: false, disconnectSub: null, retryTimer: null },
    R: { generation: 0, manual: false, disconnectSub: null, retryTimer: null },
  };
  private discovered = new Map<string, DiscoveredDevice>();
  private scanTimer: TimerHandle | null = null;
  private isScanning = false;
  private adapter: AdapterState = 'unknown';
  private adapterSub: Subscription | null = null;
  private durables = new Set<Durable>();
  private readonly events: ConnectionEvent[] = [];

  constructor(
    private readonly transport: BleTransport,
    private readonly clock: Clock,
    options: Partial<DeviceManagerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_DEVICE_MANAGER_OPTIONS, ...options };
  }

  // ---- observation -----------------------------------------------------------

  on<K extends keyof DeviceManagerEvents>(
    event: K,
    fn: (payload: DeviceManagerEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  getLinks(): Readonly<Record<Side, SideLink>> {
    return this.links;
  }

  getLink(side: Side): SideLink {
    return this.links[side];
  }

  isReady(side: Side): boolean {
    return this.links[side].state === 'ready';
  }

  getDiscovered(): DiscoveredDevice[] {
    return [...this.discovered.values()];
  }

  getEventLog(): readonly ConnectionEvent[] {
    return this.events;
  }

  getAdapterState(): AdapterState {
    return this.adapter;
  }

  scanning(): boolean {
    return this.isScanning;
  }

  // ---- adapter -----------------------------------------------------------------

  async init(): Promise<AdapterState> {
    this.adapterSub?.remove();
    this.adapterSub = this.transport.onAdapterStateChange((s) => this.setAdapter(s));
    this.setAdapter(await this.transport.adapterState());
    return this.adapter;
  }

  private setAdapter(state: AdapterState): void {
    if (state === this.adapter) return;
    this.adapter = state;
    this.log('adapter_state', null, null, state);
    this.emitter.emit('adapter', state);
    if (state !== 'poweredOn' && this.isScanning) this.stopScan();
    if (state === 'poweredOn') {
      // Bluetooth came back: retry waiting links now rather than after the backoff.
      for (const side of SIDES) {
        const link = this.links[side];
        const internals = this.internals[side];
        if (link.state === 'reconnecting' && link.deviceId && internals.retryTimer !== null) {
          this.cancelRetry(side);
          this.establish(side, link.deviceId, link.name, true).catch(() => undefined);
        }
      }
    }
  }

  // ---- scanning (F04) ------------------------------------------------------------

  startScan(): void {
    this.stopScan(false);
    this.discovered.clear();
    this.isScanning = true;
    this.emitter.emit('scanning', true);
    this.emitter.emit('scan', []);
    this.log('scan_started', null, null, null);
    this.transport.startScan(
      [ADVERTISED_SERVICE_UUID],
      (r) => {
        if (!this.isScanning) return;
        const side = sideFromName(r.name);
        if (side === null) return; // other devices advertising the service UUID
        this.discovered.set(r.id, {
          id: r.id,
          name: r.name,
          side,
          rssi: r.rssi,
          lastSeen: this.clock.now(),
        });
        this.emitter.emit('scan', this.getDiscovered());
      },
      (err) => {
        this.log('scan_error', null, null, err.message);
        this.stopScan();
      },
    );
    this.scanTimer = this.clock.setTimeout(() => this.stopScan(), this.opts.scanTimeoutMs);
  }

  stopScan(log = true): void {
    if (this.scanTimer !== null) this.clock.clearTimeout(this.scanTimer);
    this.scanTimer = null;
    if (!this.isScanning) return;
    this.transport.stopScan();
    this.isScanning = false;
    this.emitter.emit('scanning', false);
    if (log) this.log('scan_stopped', null, null, null);
  }

  /** Strongest-signal discovered device for each side. */
  bestCandidates(): Partial<Record<Side, DiscoveredDevice>> {
    const out: Partial<Record<Side, DiscoveredDevice>> = {};
    for (const d of this.discovered.values()) {
      if (!d.side) continue;
      const cur = out[d.side];
      if (!cur || (d.rssi ?? -999) > (cur.rssi ?? -999)) out[d.side] = d;
    }
    return out;
  }

  // ---- connection (F05-F08, F10, F11) ------------------------------------------

  /**
   * Connect to a device and bring the link to `ready`. `expectedSide` comes from
   * the advertised name (or from a remembered pairing); the Device Role
   * characteristic overrides it. Resolves with the side actually assigned.
   */
  async connect(deviceId: string, expectedSide?: Side): Promise<Side> {
    const name = this.discovered.get(deviceId)?.name ?? null;
    const side = expectedSide ?? sideFromName(name);
    if (!side) throw new ConnectError(`cannot tell which ankle ${deviceId} is (name ${name})`);
    const link = this.links[side];
    if (link.deviceId && link.deviceId !== deviceId && link.state !== 'idle') {
      throw new ConnectError(`${side} is already assigned to ${link.deviceId}`);
    }
    this.cancelRetry(side);
    this.internals[side].manual = false;
    if (this.isScanning) this.stopScan();
    return this.establish(side, deviceId, name, false);
  }

  /** Connect the strongest discovered L and R devices in parallel. */
  async connectBoth(): Promise<Record<Side, Side | Error>> {
    const best = this.bestCandidates();
    const results = await Promise.all(
      SIDES.map(async (side): Promise<Side | Error> => {
        const cand = best[side];
        if (!cand) return new ConnectError(`no ${side} device found`);
        if (this.links[side].state === 'ready') return side;
        try {
          return await this.connect(cand.id, side);
        } catch (e) {
          return e instanceof Error ? e : new ConnectError(String(e));
        }
      }),
    );
    return { L: results[0]!, R: results[1]! };
  }

  async disconnect(side: Side): Promise<void> {
    const link = this.links[side];
    const internals = this.internals[side];
    internals.manual = true;
    internals.generation++;
    this.cancelRetry(side);
    this.detachDurables(side);
    internals.disconnectSub?.remove();
    internals.disconnectSub = null;
    const id = link.deviceId;
    if (id && link.state !== 'idle') {
      try {
        await this.transport.disconnect(id);
      } catch {
        // the link may already be gone; local state is what matters
      }
      this.log('disconnected', side, id, 'by user');
    }
    this.update(side, { state: 'idle', reconnectAttempt: 0, readyAt: null, lastError: null });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(SIDES.map((s) => this.disconnect(s)));
  }

  /** Forget the pairing for a side (F11). */
  async forget(side: Side): Promise<void> {
    await this.disconnect(side);
    this.links[side] = emptyLink(side);
    this.emitLinks();
  }

  private async establish(
    side: Side,
    deviceId: string,
    name: string | null,
    isReconnect: boolean,
  ): Promise<Side> {
    const internals = this.internals[side];
    const gen = ++internals.generation;
    const stale = () => internals.generation !== gen;

    this.update(side, {
      deviceId,
      name: name ?? this.links[side].name,
      state: isReconnect ? 'reconnecting' : 'connecting',
      lastError: null,
    });
    this.log(
      'connecting',
      side,
      deviceId,
      isReconnect ? `attempt ${this.links[side].reconnectAttempt}` : null,
    );

    try {
      await this.transport.connect(deviceId, {
        mtu: this.opts.mtu,
        timeoutMs: this.opts.connectTimeoutMs,
      });
      if (stale()) throw new ConnectError('superseded');

      internals.disconnectSub?.remove();
      internals.disconnectSub = this.transport.onDisconnected(deviceId, (err) =>
        this.handleDisconnect(side, deviceId, gen, err),
      );

      try {
        await this.transport.requestHighPriority(deviceId);
      } catch (e) {
        this.log('priority_failed', side, deviceId, (e as Error).message);
      }

      if (!isReconnect) this.update(side, { state: 'discovering' });
      const gatt = validateGatt(await this.transport.discover(deviceId));
      if (stale()) throw new ConnectError('superseded');
      if (gatt.missing.length || gatt.propertyMismatches.length) {
        this.log(
          'gatt_incomplete',
          side,
          deviceId,
          `missing=[${gatt.missing.join(',')}] props=[${gatt.propertyMismatches.join(',')}]`,
        );
      }

      const actual = await this.resolveRole(side, deviceId, gatt);
      if (stale()) throw new ConnectError('superseded');
      if (actual !== side) {
        // Hand the device over to the correct slot and clean this one up.
        internals.disconnectSub?.remove();
        internals.disconnectSub = null;
        this.update(side, { state: 'idle', deviceId: null, name: null, gatt: null, mode: null });
        const other = this.links[actual];
        if (other.deviceId && other.deviceId !== deviceId && other.state !== 'idle') {
          await this.transport.disconnect(deviceId).catch(() => undefined);
          throw new ConnectError(`device reports role ${actual}, which is already connected`);
        }
        this.cancelRetry(actual);
        this.internals[actual].manual = false;
        await this.transport.disconnect(deviceId).catch(() => undefined);
        return await this.establish(actual, deviceId, name, isReconnect);
      }

      const mode = gatt.checks.find((c) => c.key === 'bleMode')?.present
        ? bleModeFromCode(await this.readValue('bleMode', deviceId))
        : null;
      if (stale()) throw new ConnectError('superseded');

      this.update(side, {
        state: 'ready',
        gatt,
        mode,
        reconnectAttempt: 0,
        readyAt: this.clock.now(),
        lastError: null,
      });
      this.log('ready', side, deviceId, `mode=${mode ?? 'unknown'}`);
      this.attachDurables(side);
      this.emitter.emit('ready', { side, deviceId, mode });
      return side;
    } catch (e) {
      const msg = (e as Error).message;
      if (stale()) throw e; // a newer attempt or a manual disconnect owns the link now
      this.log('connect_failed', side, deviceId, msg);
      if (isReconnect && !internals.manual) {
        this.update(side, { lastError: msg });
        this.scheduleReconnect(side, deviceId);
      } else {
        internals.disconnectSub?.remove();
        internals.disconnectSub = null;
        await this.transport.disconnect(deviceId).catch(() => undefined);
        this.update(side, { state: 'idle', lastError: msg });
      }
      throw e;
    }
  }

  /** Device Role decides the side (F05); falls back to the expected side. */
  private async resolveRole(expected: Side, deviceId: string, gatt: GattReport): Promise<Side> {
    if (!gatt.checks.find((c) => c.key === 'deviceRole')?.present) return expected;
    const code = await this.readValue('deviceRole', deviceId);
    const role = sideFromRoleCode(code);
    if (role === null) {
      this.log('role_mismatch', expected, deviceId, `unknown role code ${code}; using ${expected}`);
      return expected;
    }
    if (role !== expected) {
      this.log(
        'role_mismatch',
        expected,
        deviceId,
        `name says ${expected}, role says ${role}; role wins`,
      );
    }
    return role;
  }

  // ---- link loss and reconnect (F09) -------------------------------------------

  private handleDisconnect(side: Side, deviceId: string, gen: number, err: Error | null): void {
    const internals = this.internals[side];
    if (internals.generation !== gen || internals.manual) return;
    internals.disconnectSub?.remove();
    internals.disconnectSub = null;
    this.detachDurables(side);
    const reason = err?.message ?? 'disconnected';
    this.log('link_lost', side, deviceId, reason);
    this.emitter.emit('lost', { side, deviceId });
    this.update(side, { state: 'reconnecting', lastError: reason, readyAt: null });
    internals.generation++; // invalidate any in-flight setup for the dead link
    this.scheduleReconnect(side, deviceId);
  }

  private scheduleReconnect(side: Side, deviceId: string): void {
    const link = this.links[side];
    const attempt = link.reconnectAttempt;
    const delays = this.opts.backoffMs;
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    this.update(side, { state: 'reconnecting', reconnectAttempt: attempt + 1 });
    this.log('reconnect_scheduled', side, deviceId, `attempt ${attempt + 1} in ${delay} ms`);
    this.cancelRetry(side);
    this.internals[side].retryTimer = this.clock.setTimeout(() => {
      this.internals[side].retryTimer = null;
      if (this.internals[side].manual) return;
      this.establish(side, deviceId, link.name, true).catch(() => {
        // failure already logged and the next attempt scheduled
      });
    }, delay);
  }

  private cancelRetry(side: Side): void {
    const t = this.internals[side].retryTimer;
    if (t !== null) this.clock.clearTimeout(t);
    this.internals[side].retryTimer = null;
  }

  // ---- GATT operations ------------------------------------------------------------

  private requireReady(side: Side): string {
    const link = this.links[side];
    if (link.state !== 'ready' || !link.deviceId) {
      throw new ConnectError(`${side} is not connected (state ${link.state})`);
    }
    return link.deviceId;
  }

  private async readValue(key: CharKey, deviceId: string): Promise<number> {
    const spec = charSpec(key);
    return decodeValue(spec.type, await this.transport.read(deviceId, spec.serviceUuid, spec.uuid));
  }

  async readRaw(side: Side, key: CharKey): Promise<Uint8Array> {
    const id = this.requireReady(side);
    const spec = charSpec(key);
    return this.transport.read(id, spec.serviceUuid, spec.uuid);
  }

  async read(side: Side, key: CharKey): Promise<number> {
    const spec = charSpec(key);
    return decodeValue(spec.type, await this.readRaw(side, key));
  }

  /** Encode per the spec type and write. Throws if the side is not ready. */
  async write(side: Side, key: CharKey, value: number, withResponse: boolean): Promise<void> {
    const id = this.requireReady(side);
    const spec = charSpec(key);
    await this.transport.write(
      id,
      spec.serviceUuid,
      spec.uuid,
      encodeValue(spec.type, value),
      withResponse,
    );
  }

  /**
   * Lowest-latency write: write-without-response when the device supports it on
   * this characteristic, otherwise write-with-response. Resolves with the mode used.
   */
  async writeFast(
    side: Side,
    key: CharKey,
    value: number,
  ): Promise<'without-response' | 'with-response'> {
    const check = this.links[side].gatt?.checks.find((c) => c.key === key);
    const withoutResponse = check?.writableWithoutResponse ?? false;
    await this.write(side, key, value, !withoutResponse);
    return withoutResponse ? 'without-response' : 'with-response';
  }

  async readRssi(side: Side): Promise<number> {
    return this.transport.readRssi(this.requireReady(side));
  }

  /**
   * Durable subscription: attached whenever the side is ready, re-attached after
   * every reconnect, detached on link loss. Returns an unsubscribe function.
   */
  subscribe(side: Side, key: CharKey, onValue: (bytes: Uint8Array) => void): Unsubscribe {
    const d: Durable = { side, key, onValue, active: null };
    this.durables.add(d);
    if (this.isReady(side)) this.attach(d);
    return () => {
      d.active?.remove();
      d.active = null;
      this.durables.delete(d);
    };
  }

  private attach(d: Durable): void {
    const link = this.links[d.side];
    if (!link.deviceId) return;
    const present = link.gatt?.checks.find((c) => c.key === d.key)?.present ?? false;
    if (!present) return;
    const spec = charSpec(d.key);
    const deviceId = link.deviceId;
    d.active = this.transport.monitor(deviceId, spec.serviceUuid, spec.uuid, d.onValue, (err) => {
      // Errors caused by link loss are handled by the disconnect path.
      if (this.links[d.side].state === 'ready') {
        this.log('monitor_error', d.side, deviceId, `${d.key}: ${err.message}`);
      }
    });
  }

  private attachDurables(side: Side): void {
    for (const d of this.durables) if (d.side === side && !d.active) this.attach(d);
  }

  private detachDurables(side: Side): void {
    for (const d of this.durables) {
      if (d.side !== side) continue;
      d.active?.remove();
      d.active = null;
    }
  }

  // ---- bookkeeping -------------------------------------------------------------------

  private update(side: Side, patch: Partial<SideLink>): void {
    this.links = { ...this.links, [side]: { ...this.links[side], ...patch } };
    this.emitLinks();
  }

  private emitLinks(): void {
    this.emitter.emit('links', this.links);
  }

  private log(
    type: ConnectionEventType,
    side: Side | null,
    deviceId: string | null,
    detail: string | null,
  ): void {
    const ev: ConnectionEvent = {
      t: this.clock.now(),
      wall: this.clock.wallNow(),
      type,
      side,
      deviceId,
      detail,
    };
    this.events.push(ev);
    this.emitter.emit('event', ev);
  }

  dispose(): void {
    this.stopScan(false);
    this.adapterSub?.remove();
    for (const side of SIDES) {
      this.cancelRetry(side);
      this.internals[side].disconnectSub?.remove();
    }
    for (const d of this.durables) d.active?.remove();
    this.durables.clear();
  }
}
