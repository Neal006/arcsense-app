import { FakeClock } from '@/core/clock';
import { AlertEngine } from '@/services/AlertEngine';
import type { Stride } from '@/services/StrideAssembler';
import { FEATURE_SPEC_HASH } from '@/shared/generated/features';

import { agreement, FREEZING, GaitClassifier, type Classification } from '../GaitClassifier';
import { Mlp, ModelError, type MlpWeights } from '../Mlp';

/** 10 -> 2 (relu) -> 4 (softmax) network whose output we can compute by hand. */
function tinyWeights(): MlpWeights {
  const k1 = Array.from({ length: 10 }, (_, r) => [r === 0 ? 1 : 0, r === 3 ? 1 : 0]);
  return {
    version: 'tiny',
    featureSpecHash: FEATURE_SPEC_HASH,
    normalization: { mean: Array(10).fill(1), variance: Array(10).fill(4), epsilon: 1e-7 },
    layers: [
      { kernel: k1, bias: [0, -0.5], activation: 'relu' },
      {
        kernel: [
          [1, 0, 0, 0],
          [0, 0, 2, 0],
        ],
        bias: [0, 0, 0, 0],
        activation: 'softmax',
      },
    ],
  };
}

const stride = (v: Partial<Stride['values']>, aiLabel: number | null = null): Stride => ({
  side: 'L',
  strideCount: 1,
  t: 5,
  values: {
    strideTime: 1.3,
    swingTime: 0.5,
    stanceTime: 0.8,
    strideLength: 1,
    tibialShock: 3,
    asymmetryIndex: 0.02,
    freezeIndex: 0.4,
    ...v,
  },
  aiLabel,
  aiConfidence: null,
  missing: [],
  cadenceSpm: null,
  swingPct: null,
  stancePct: null,
});

describe('Mlp', () => {
  it('normalises, applies relu layers and softmax', () => {
    const m = new Mlp(tinyWeights());
    const x = new Float32Array(10).fill(1);
    x[0] = 5; // (5 - 1) / 2 = 2  -> h0 = 2
    x[3] = 3; // (3 - 1) / 2 = 1  -> h1 = relu(1 - 0.5) = 0.5
    const p = m.predict(x);
    // logits [2, 0, 1, 0]
    const e = [Math.exp(2), 1, Math.exp(1), 1];
    const s = e.reduce((a, b) => a + b, 0);
    e.forEach((v, i) => expect(p[i]).toBeCloseTo(v / s, 12));
    expect(m.version).toBe('tiny');
  });

  it('refuses a model for another feature spec or with the wrong shapes', () => {
    expect(() => new Mlp({ ...tinyWeights(), featureSpecHash: 'deadbeef'.repeat(8) })).toThrow(
      /feature spec/,
    );
    const w = tinyWeights();
    w.normalization.mean = [1];
    expect(() => new Mlp(w)).toThrow(/normalisation/);
    const w2 = tinyWeights();
    w2.layers[0]!.kernel = w2.layers[0]!.kernel.slice(1);
    expect(() => new Mlp(w2)).toThrow(/kernel must be 10x2/);
    const w3 = tinyWeights();
    w3.layers[1]!.activation = 'relu';
    expect(() => new Mlp(w3)).toThrow(ModelError);
    const w4 = tinyWeights();
    w4.layers[1] = { kernel: [[1], [1]], bias: [0], activation: 'softmax' };
    expect(() => new Mlp(w4)).toThrow(/outputs 1 classes/);
  });
});

describe('GaitClassifier', () => {
  it('uses the model when no freezing alert is active', () => {
    const c = new GaitClassifier(new Mlp(tinyWeights()), new AlertEngine(new FakeClock()));
    const r = c.classify(stride({}, 0))!;
    expect(r.source).toBe('model');
    expect(r.confidence).toBeGreaterThan(0.25);
    expect(r.firmwareLabel).toBe(0);
  });

  it('overrides to Freezing while the FI rule is active (brief 7.4)', () => {
    const alerts = new AlertEngine(new FakeClock());
    const c = new GaitClassifier(new Mlp(tinyWeights()), alerts);
    for (let i = 0; i < 2; i++) alerts.onStride(stride({ freezeIndex: 4 }));
    expect(c.classify(stride({ freezeIndex: 4 }))).toMatchObject({
      label: FREEZING,
      source: 'fi-override',
      confidence: 1,
    });
  });

  it('returns null without a model or for unclassifiable strides', () => {
    const alerts = new AlertEngine(new FakeClock());
    expect(new GaitClassifier(null, alerts).classify(stride({}))).toBeNull();
    expect(
      new GaitClassifier(new Mlp(tinyWeights()), alerts).classify(stride({ strideLength: 0 })),
    ).toBeNull();
  });

  it('measures agreement with the firmware labels', () => {
    const r = (label: number, fw: number | null): Classification => ({
      side: 'L',
      t: 0,
      label,
      confidence: 1,
      source: 'model',
      firmwareLabel: fw,
    });
    expect(agreement([r(0, 0), r(1, 0), r(2, null)])).toBe(0.5);
    expect(agreement([r(0, null)])).toBeNull();
  });
});
