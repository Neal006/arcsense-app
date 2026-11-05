import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from './canonical';
import { featureSpecHash, renderAll, renderReplay, uuidFor } from './gen-shared';

// Same value is pinned in ml/tests/test_shared_contract.py.
const EXPECTED_FEATURE_SPEC_HASH =
  '1a66e940e1be4294e24f6d0b2b16729cfc312a918e320b9eedfcd47fee96bc42';

describe('canonicalJson', () => {
  it('matches Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)', () => {
    expect(canonicalJson({ b: 1, a: [1, 'é'] })).toBe('{"a":[1,"é"],"b":1}');
    expect(canonicalJson({ z: { y: null, x: true } })).toBe('{"z":{"x":true,"y":null}}');
    expect(canonicalJson('tab\there "q"')).toBe('"tab\\there \\"q\\""');
  });

  it('rejects values whose formatting differs between languages', () => {
    expect(() => canonicalJson({ t: 3.5 })).toThrow(/non-integer/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/unsupported/);
    expect(() => canonicalJson(undefined)).toThrow(/unsupported/);
  });
});

describe('gen-shared', () => {
  it('produces the pinned feature-spec hash shared with the Python pipeline', () => {
    const spec = JSON.parse(
      readFileSync(join(__dirname, '../../shared/feature_spec.json'), 'utf8'),
    );
    expect(featureSpecHash(spec)).toBe(EXPECTED_FEATURE_SPEC_HASH);
  });

  it('builds lowercase 128-bit UUIDs from the template', () => {
    expect(uuidFor('19B1XXXX-E8F2-537E-4F6C-D104768A1214', '000A')).toBe(
      '19b1000a-e8f2-537e-4f6c-d104768a1214',
    );
    expect(() => uuidFor('19B1XXXX-0000', '12345')).toThrow(/bad UUID suffix/);
  });

  it('committed generated files are up to date', () => {
    for (const [file, content] of Object.entries(renderAll())) {
      const committed = readFileSync(join(__dirname, '../src/shared/generated', file), 'utf8');
      expect(committed).toBe(content);
    }
  });
});

describe('renderReplay', () => {
  const header =
    'session_us,timestamp_us,sampleIndex,strideTimeS,swingTimeS,stanceTimeS,strideLengthM,tibialShockG,asymmetryIndex,freezeIndex,edgeai_label,edgeai_confidence';

  it('extracts the replay columns in a fixed order', () => {
    const out = renderReplay(`${header}\r\n1,2,3,1.4,0.5,0.9,1.0,2.8,0.01,0.4,-1,0\r\n`, 'x.csv');
    expect(out).toContain('[2, 3, 1.4, 0.5, 0.9, 1, 2.8, 0.01, 0.4],');
  });

  it('rejects missing columns and non-numeric cells', () => {
    expect(() => renderReplay('a,b\n1,2', 'x.csv')).toThrow(/missing column timestamp_us/);
    expect(() =>
      renderReplay(`${header}\n1,2,3,abc,0.5,0.9,1.0,2.8,0.01,0.4,-1,0`, 'x.csv'),
    ).toThrow(/bad number in row 1/);
  });
});
