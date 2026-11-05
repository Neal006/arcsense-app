import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { session0007 } from '@/ble/replay';
import { FEATURE_KEYS, FEATURE_SPEC_HASH } from '@/shared/generated/features';
import type { Stride } from '@/services/StrideAssembler';

import { featureVector, strideFeatureVector } from '../features';

const golden = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../shared/fixtures/features_0007.json'), 'utf8'),
) as { featureSpecHash: string; features: string[]; valid: boolean[]; rows: number[][] };

describe('featureVector parity with the Python pipeline', () => {
  it('uses the same spec', () => {
    expect(golden.featureSpecHash).toBe(FEATURE_SPEC_HASH);
    expect(golden.features).toEqual([...FEATURE_KEYS]);
  });

  it('reproduces every session 0007 row and the validity mask', () => {
    const rows = session0007().map((s) =>
      featureVector({
        strideTimeS: s.strideTimeS,
        swingTimeS: s.swingTimeS,
        stanceTimeS: s.stanceTimeS,
        strideLengthM: s.strideLengthM,
        tibialShockG: s.tibialShockG,
        asymmetryIndex: s.asymmetryIndex,
        freezeIndex: s.freezeIndex,
      }),
    );
    expect(rows.map((r) => r !== null)).toEqual(golden.valid);
    const valid = rows.filter((r): r is Float32Array => r !== null);
    expect(valid).toHaveLength(golden.rows.length);
    valid.forEach((r, i) => {
      golden.rows[i]!.forEach((g, j) => {
        // float32 in the app vs float64 in Python: relative error < 1e-6
        expect(Math.abs(r[j]! - g)).toBeLessThanOrEqual(Math.abs(g) * 1e-6 + 1e-7);
      });
    });
  });
});

describe('strideFeatureVector', () => {
  const base: Stride = {
    side: 'L',
    strideCount: 1,
    t: 0,
    values: {
      strideTime: 1.3,
      swingTime: 0.5,
      stanceTime: 0.8,
      strideLength: 1,
      tibialShock: 3,
      asymmetryIndex: 0.02,
      freezeIndex: 0.4,
    },
    aiLabel: null,
    aiConfidence: null,
    missing: [],
    cadenceSpm: null,
    swingPct: null,
    stancePct: null,
  };

  it('builds the vector from a complete stride', () => {
    const v = strideFeatureVector(base)!;
    expect(Array.from(v.slice(7))).toEqual([
      expect.closeTo(120 / 1.3, 4),
      expect.closeTo(0.5 / 1.3, 6),
      expect.closeTo(0.8 / 1.3, 6),
    ]);
  });

  it('returns null for incomplete or non-physical strides', () => {
    const { freezeIndex: _fi, ...rest } = base.values;
    expect(strideFeatureVector({ ...base, values: rest })).toBeNull();
    expect(
      strideFeatureVector({ ...base, values: { ...base.values, strideTime: 0.1 } }),
    ).toBeNull();
    expect(
      strideFeatureVector({ ...base, values: { ...base.values, strideLength: 0 } }),
    ).toBeNull();
    expect(strideFeatureVector({ ...base, values: { ...base.values, strideTime: 0 } })).toBeNull();
  });
});
