import { fullDiscovery } from '@/testing/gattFixtures';
import { SERVICE_UUIDS } from '@/shared/generated/gatt';

import {
  bleModeFromCode,
  charByUuid,
  charSpec,
  sideFromName,
  sideFromRoleCode,
  validateGatt,
} from '../gatt';

describe('lookups', () => {
  it('resolves characteristics by key and case-insensitive UUID', () => {
    const sync = charSpec('syncMarker');
    expect(sync.uuid).toBe('19b10011-e8f2-537e-4f6c-d104768a1214');
    expect(sync.type).toBe('u16');
    expect(charByUuid(sync.uuid.toUpperCase())?.key).toBe('syncMarker');
    expect(charByUuid('0000180f-0000-1000-8000-00805f9b34fb')).toBeUndefined();
  });

  it('places strideCount (0x0013) in the gait service despite its command-range suffix', () => {
    expect(charSpec('strideCount').serviceUuid).toBe(SERVICE_UUIDS.gait);
  });

  it('maps names, role codes and modes', () => {
    expect(sideFromName('ArcSense-L')).toBe('L');
    expect(sideFromName('ArcSense-R')).toBe('R');
    expect(sideFromName('arcsense-l')).toBeNull();
    expect(sideFromName(null)).toBeNull();
    expect(sideFromRoleCode(76)).toBe('L');
    expect(sideFromRoleCode(82)).toBe('R');
    expect(sideFromRoleCode(0)).toBeNull();
    expect(bleModeFromCode(0)).toBe('DATA_COLLECTION');
    expect(bleModeFromCode(1)).toBe('EDGE_AI');
    expect(bleModeFromCode(2)).toBe('STREAMING');
    expect(bleModeFromCode(3)).toBeNull();
  });
});

describe('validateGatt', () => {
  it('accepts a complete device', () => {
    const r = validateGatt(fullDiscovery());
    expect(r.missing).toEqual([]);
    expect(r.propertyMismatches).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.gaitCharacteristicsComplete).toBe(true);
    expect(r.sessionControlAvailable).toBe(true);
    expect(r.telemetryPacketPresent).toBe(false);
  });

  it('reports missing characteristics and degrades capabilities', () => {
    const d = fullDiscovery().filter(
      (c) => !c.uuid.startsWith('19B10013') && !c.uuid.startsWith('19B10012'),
    );
    const r = validateGatt(d);
    expect(r.missing.sort()).toEqual(['labelMarker', 'strideCount']);
    expect(r.gaitCharacteristicsComplete).toBe(false);
    expect(r.sessionControlAvailable).toBe(false);
  });

  it('reports missing properties (e.g. freeze index not notifiable)', () => {
    const d = fullDiscovery().map((c) =>
      c.uuid.startsWith('19B10007') ? { ...c, isNotifiable: false } : c,
    );
    const r = validateGatt(d);
    expect(r.propertyMismatches).toEqual(['freezeIndex']);
    expect(r.checks.find((c) => c.key === 'freezeIndex')?.missingProps).toEqual(['notify']);
    expect(r.gaitCharacteristicsComplete).toBe(false);
  });

  it('accepts write-without-response as satisfying write and records it', () => {
    const d = fullDiscovery().map((c) =>
      c.uuid.startsWith('19B10011') ? { ...c, isWritableWithResponse: false } : c,
    );
    const r = validateGatt(d);
    expect(r.sessionControlAvailable).toBe(true);
    expect(r.checks.find((c) => c.key === 'syncMarker')?.writableWithoutResponse).toBe(true);
  });

  it('records when only write-with-response is supported', () => {
    const d = fullDiscovery().map((c) =>
      c.uuid.startsWith('19B10012') ? { ...c, isWritableWithoutResponse: false } : c,
    );
    const r = validateGatt(d);
    expect(r.checks.find((c) => c.key === 'labelMarker')?.writableWithoutResponse).toBe(false);
    expect(r.sessionControlAvailable).toBe(true);
  });

  it('lists unknown characteristics inside our services only', () => {
    const extra = [
      {
        serviceUuid: SERVICE_UUIDS.gait,
        uuid: '19B10020-E8F2-537E-4F6C-D104768A1214',
        isReadable: true,
        isNotifiable: true,
        isWritableWithResponse: false,
        isWritableWithoutResponse: false,
      },
      {
        serviceUuid: '0000180f-0000-1000-8000-00805f9b34fb', // battery service: not ours
        uuid: '00002a19-0000-1000-8000-00805f9b34fb',
        isReadable: true,
        isNotifiable: true,
        isWritableWithResponse: false,
        isWritableWithoutResponse: false,
      },
    ];
    const r = validateGatt([...fullDiscovery(), ...extra]);
    expect(r.unknown).toEqual([
      { serviceUuid: SERVICE_UUIDS.gait, uuid: '19b10020-e8f2-537e-4f6c-d104768a1214' },
    ]);
  });

  it('handles an empty discovery', () => {
    const r = validateGatt([]);
    expect(r.missing).toHaveLength(15);
    expect(r.sessionControlAvailable).toBe(false);
  });
});
