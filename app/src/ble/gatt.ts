/**
 * Typed access to the generated GATT map and validation of what a device
 * actually exposes against it (functionality F07).
 */
import {
  CHARACTERISTICS,
  DEVICE_NAMES,
  ROLE_CODES,
  BLE_MODES,
  SERVICE_UUIDS,
  TELEMETRY_PACKET,
} from '@/shared/generated/gatt';

import type { DiscoveredCharacteristic } from './transport';

export type Side = 'L' | 'R';
export const SIDES: readonly Side[] = ['L', 'R'];

export type CharSpec = (typeof CHARACTERISTICS)[number];
export type CharKey = CharSpec['key'];
export type BleMode = 'DATA_COLLECTION' | 'EDGE_AI' | 'STREAMING';

const BY_KEY = new Map<string, CharSpec>(CHARACTERISTICS.map((c) => [c.key, c]));
const BY_UUID = new Map<string, CharSpec>(CHARACTERISTICS.map((c) => [c.uuid, c]));
const OUR_SERVICES = new Set<string>(Object.values(SERVICE_UUIDS));

export function charSpec(key: CharKey): CharSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown characteristic ${key}`); // unreachable for typed callers
  return spec;
}

export function charByUuid(uuid: string): CharSpec | undefined {
  return BY_UUID.get(uuid.toLowerCase());
}

export function sideFromName(name: string | null | undefined): Side | null {
  if (name === DEVICE_NAMES.L) return 'L';
  if (name === DEVICE_NAMES.R) return 'R';
  return null;
}

export function sideFromRoleCode(code: number): Side | null {
  if (code === ROLE_CODES.L) return 'L';
  if (code === ROLE_CODES.R) return 'R';
  return null;
}

export function bleModeFromCode(code: number): BleMode | null {
  const name = (BLE_MODES as Record<string, string>)[String(code)];
  return (name as BleMode | undefined) ?? null;
}

export interface CharCheck {
  key: CharKey;
  present: boolean;
  /** Required properties the device does not advertise for this characteristic. */
  missingProps: string[];
}

export interface GattReport {
  checks: CharCheck[];
  missing: CharKey[];
  propertyMismatches: CharKey[];
  /** Characteristics inside our services that the spec does not know about. */
  unknown: { serviceUuid: string; uuid: string }[];
  telemetryPacketPresent: boolean;
  /** True when per-characteristic gait streaming is fully available. */
  gaitCharacteristicsComplete: boolean;
  /** True when every write-path characteristic needed for a session exists. */
  sessionControlAvailable: boolean;
}

function propsOf(d: DiscoveredCharacteristic): Set<string> {
  const s = new Set<string>();
  if (d.isReadable) s.add('read');
  if (d.isNotifiable) s.add('notify');
  if (d.isWritableWithResponse || d.isWritableWithoutResponse) s.add('write');
  return s;
}

export function validateGatt(discovered: DiscoveredCharacteristic[]): GattReport {
  const found = new Map<string, DiscoveredCharacteristic>();
  for (const d of discovered) found.set(d.uuid.toLowerCase(), d);

  const checks: CharCheck[] = CHARACTERISTICS.map((spec) => {
    const d = found.get(spec.uuid);
    if (!d) return { key: spec.key, present: false, missingProps: [...spec.props] };
    const have = propsOf(d);
    return { key: spec.key, present: true, missingProps: spec.props.filter((p) => !have.has(p)) };
  });

  const unknown = discovered
    .filter((d) => OUR_SERVICES.has(d.serviceUuid.toLowerCase()))
    .filter((d) => !BY_UUID.has(d.uuid.toLowerCase()))
    .filter((d) => d.uuid.toLowerCase() !== TELEMETRY_PACKET.uuid)
    .map((d) => ({ serviceUuid: d.serviceUuid.toLowerCase(), uuid: d.uuid.toLowerCase() }));

  const ok = (key: CharKey) => {
    const c = checks.find((x) => x.key === key);
    return !!c && c.present && c.missingProps.length === 0;
  };
  const gaitKeys = CHARACTERISTICS.filter((c) => c.service === 'gait').map((c) => c.key);

  return {
    checks,
    missing: checks.filter((c) => !c.present).map((c) => c.key),
    propertyMismatches: checks.filter((c) => c.present && c.missingProps.length).map((c) => c.key),
    unknown,
    telemetryPacketPresent: TELEMETRY_PACKET.uuid !== null && found.has(TELEMETRY_PACKET.uuid),
    gaitCharacteristicsComplete: gaitKeys.every(ok),
    sessionControlAvailable: ok('syncMarker') && ok('labelMarker'),
  };
}
