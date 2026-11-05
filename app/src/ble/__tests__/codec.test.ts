import {
  CodecError,
  decodeAiLabel,
  decodeBase64,
  decodeTelemetryPacket,
  decodeValue,
  encodeBase64,
  encodeValue,
  TYPE_SIZE,
  type ValueType,
} from '../codec';

const bytes = (...b: number[]) => Uint8Array.from(b);

describe('base64', () => {
  it.each([
    ['', []],
    ['AA==', [0]],
    ['AAE=', [0, 1]],
    ['AAEC', [0, 1, 2]],
    ['/w==', [255]],
    ['AaoAqg==', [0x01, 0xaa, 0x00, 0xaa]],
  ])('decodes %p', (text, expected) => {
    expect(Array.from(decodeBase64(text))).toEqual(expected);
    expect(encodeBase64(Uint8Array.from(expected))).toBe(text);
  });

  it('round-trips every byte value at every length mod 3', () => {
    for (let len = 0; len < 260; len++) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 255);
      expect(decodeBase64(encodeBase64(data))).toEqual(data);
    }
  });

  it('matches the platform implementation', () => {
    const data = Uint8Array.from({ length: 50 }, (_, i) => (i * 91) & 255);
    expect(encodeBase64(data)).toBe(Buffer.from(data).toString('base64'));
  });

  it.each(['A', 'AAA', 'A=AA', '====', 'AA*A', 'AAé='])('rejects malformed %p', (text) => {
    expect(() => decodeBase64(text)).toThrow(CodecError);
  });
});

describe('decodeValue / encodeValue', () => {
  it('decodes little-endian integers', () => {
    expect(decodeValue('u8', bytes(0xfe))).toBe(254);
    expect(decodeValue('i8', bytes(0xff))).toBe(-1);
    expect(decodeValue('u16', bytes(0x01, 0xaa))).toBe(0xaa01);
    expect(decodeValue('u32', bytes(0xf7, 0xd1, 0x3e, 0x00))).toBe(4116983);
    expect(decodeValue('u32', bytes(0xff, 0xff, 0xff, 0xff))).toBe(0xffffffff);
  });

  it('decodes IEEE-754 float32 little-endian', () => {
    // 1.305 as float32 = 0x3FA70A3D
    expect(decodeValue('f32', bytes(0x3d, 0x0a, 0xa7, 0x3f))).toBeCloseTo(1.305, 6);
    expect(Number.isNaN(decodeValue('f32', bytes(0x00, 0x00, 0xc0, 0x7f)))).toBe(true);
  });

  it('round-trips values for every type', () => {
    const cases: [ValueType, number][] = [
      ['u8', 0],
      ['u8', 255],
      ['i8', -128],
      ['i8', 127],
      ['u16', 0xaa01],
      ['u32', 0xdeadbeef],
      ['f32', -3.5],
    ];
    for (const [type, value] of cases) {
      const enc = encodeValue(type, value);
      expect(enc.length).toBe(TYPE_SIZE[type]);
      expect(decodeValue(type, enc)).toBe(value);
    }
  });

  it('encodes sync token 0xAA01 as 01 AA', () => {
    expect(Array.from(encodeValue('u16', 0xaa01))).toEqual([0x01, 0xaa]);
  });

  it('decodes from a subarray view without copying offsets wrongly', () => {
    const buf = bytes(9, 9, 0x01, 0xaa, 9);
    expect(decodeValue('u16', buf.subarray(2, 4))).toBe(0xaa01);
  });

  it.each([
    ['u8', 2],
    ['u16', 1],
    ['u16', 3],
    ['u32', 2],
    ['f32', 8],
  ] as [ValueType, number][])('rejects %s with %i bytes', (type, len) => {
    expect(() => decodeValue(type, new Uint8Array(len))).toThrow(/expects/);
  });

  it.each([
    ['u8', 256],
    ['u8', -1],
    ['i8', 128],
    ['u16', 65536],
    ['u16', 1.5],
    ['u32', -1],
    ['u32', 2 ** 32],
    ['f32', Number.NaN],
    ['f32', Number.POSITIVE_INFINITY],
  ] as [ValueType, number][])('refuses to encode %s %p', (type, value) => {
    expect(() => encodeValue(type, value)).toThrow(CodecError);
  });
});

describe('decodeAiLabel', () => {
  it('maps 0xFF to no inference', () => {
    expect(decodeAiLabel(bytes(0xff))).toBeNull();
  });
  it.each([0, 1, 2, 3])('passes class index %i', (i) => {
    expect(decodeAiLabel(bytes(i))).toBe(i);
  });
  it('rejects out-of-range class indices', () => {
    expect(() => decodeAiLabel(bytes(4))).toThrow(/outside class range/);
    expect(() => decodeAiLabel(bytes(0x80))).toThrow(CodecError);
  });
});

describe('decodeTelemetryPacket', () => {
  // strideCount=54, cadence=92, length=97cm, stride=1305ms, swing=488ms,
  // stance=817ms, shock=382cg, asym=27 (2.7% *10), FI=41 (0.41*100), batt=88, status=3
  const fields = [54, 92, 97, 1305, 488, 817, 382, 27, 41, 88, 3];

  function aligned(): Uint8Array {
    const b = new Uint8Array(20);
    const v = new DataView(b.buffer);
    v.setUint16(0, fields[0]!, true);
    v.setUint8(2, fields[1]!);
    b[3] = 0xee; // padding byte must be ignored
    for (let i = 0; i < 7; i++) v.setUint16(4 + 2 * i, fields[2 + i]!, true);
    v.setUint8(18, fields[9]!);
    v.setUint8(19, fields[10]!);
    return b;
  }

  function packed(): Uint8Array {
    const b = new Uint8Array(19);
    const v = new DataView(b.buffer);
    v.setUint16(0, fields[0]!, true);
    v.setUint8(2, fields[1]!);
    for (let i = 0; i < 7; i++) v.setUint16(3 + 2 * i, fields[2 + i]!, true);
    v.setUint8(17, fields[9]!);
    v.setUint8(18, fields[10]!);
    return b;
  }

  const expected = {
    strideCount: 54,
    cadenceSpm: 92,
    strideLengthM: 0.97,
    strideTimeS: 1.305,
    swingTimeS: 0.488,
    stanceTimeS: 0.817,
    tibialShockG: 3.82,
    asymmetryFraction: 0.027,
    freezeIndex: 0.41,
    batteryPct: 88,
    systemStatus: 3,
  };

  it('decodes the 20-byte naturally aligned layout', () => {
    expect(decodeTelemetryPacket(aligned())).toEqual(expected);
  });

  it('decodes the 19-byte packed layout', () => {
    expect(decodeTelemetryPacket(packed())).toEqual(expected);
  });

  it.each([0, 18, 21])('rejects %i-byte packets', (len) => {
    expect(() => decodeTelemetryPacket(new Uint8Array(len))).toThrow(/telemetry packet must be/);
  });
});
