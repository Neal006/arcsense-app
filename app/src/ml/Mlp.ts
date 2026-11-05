/**
 * Framework-free MLP forward pass for the exported gait model (F42, F44).
 * Weights come from ml/arcsense_ml/export.py (mlp_weights.json); a parity test
 * checks the outputs against the float .tflite golden vectors. Running the
 * ~400-parameter model in TypeScript avoids a native TFLite module in the app;
 * the firmware still runs the int8 .tflite.
 */
import { CLASS_NAMES, FEATURE_KEYS, FEATURE_SPEC_HASH } from '@/shared/generated/features';

export interface MlpWeights {
  version: string;
  featureSpecHash: string;
  normalization: { mean: number[]; variance: number[]; epsilon: number };
  layers: { kernel: number[][]; bias: number[]; activation: 'relu' | 'softmax' }[];
}

export class ModelError extends Error {
  override name = 'ModelError';
}

export class Mlp {
  readonly version: string;
  private readonly scale: Float64Array;
  private readonly mean: Float64Array;
  private readonly layers: {
    w: Float64Array;
    b: Float64Array;
    nIn: number;
    nOut: number;
    relu: boolean;
  }[];

  constructor(weights: MlpWeights) {
    if (weights.featureSpecHash !== FEATURE_SPEC_HASH) {
      throw new ModelError(
        `model was trained for feature spec ${weights.featureSpecHash.slice(0, 12)}…, app expects ${FEATURE_SPEC_HASH.slice(0, 12)}…`,
      );
    }
    const nf: number = FEATURE_KEYS.length;
    const { mean, variance, epsilon } = weights.normalization;
    if (mean.length !== nf || variance.length !== nf)
      throw new ModelError(`normalisation must have ${nf} entries`);
    this.mean = Float64Array.from(mean);
    this.scale = Float64Array.from(variance, (v) => 1 / Math.max(Math.sqrt(v), epsilon));
    let nIn: number = nf;
    this.layers = weights.layers.map((l, i) => {
      const nOut = l.bias.length;
      if (l.kernel.length !== nIn || l.kernel.some((row) => row.length !== nOut)) {
        throw new ModelError(`layer ${i}: kernel must be ${nIn}x${nOut}`);
      }
      const last = i === weights.layers.length - 1;
      if (l.activation !== (last ? 'softmax' : 'relu')) {
        throw new ModelError(`layer ${i}: unexpected activation ${l.activation}`);
      }
      const w = new Float64Array(nIn * nOut);
      l.kernel.forEach((row, r) => row.forEach((v, c) => (w[r * nOut + c] = v)));
      const layer = { w, b: Float64Array.from(l.bias), nIn, nOut, relu: !last };
      nIn = nOut;
      return layer;
    });
    if (nIn !== CLASS_NAMES.length)
      throw new ModelError(`model outputs ${nIn} classes, expected ${CLASS_NAMES.length}`);
    this.version = weights.version;
  }

  /** Class probabilities for one feature vector. */
  predict(x: Float32Array): Float64Array {
    let h = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) h[i] = (x[i]! - this.mean[i]!) * this.scale[i]!;
    for (const l of this.layers) {
      const out = Float64Array.from(l.b);
      for (let r = 0; r < l.nIn; r++) {
        const hr = h[r]!;
        if (hr === 0) continue;
        const base = r * l.nOut;
        for (let c = 0; c < l.nOut; c++) out[c]! += hr * l.w[base + c]!;
      }
      if (l.relu) {
        for (let c = 0; c < l.nOut; c++) if (out[c]! < 0) out[c] = 0;
      } else {
        let max = -Infinity;
        for (const v of out) max = Math.max(max, v);
        let sum = 0;
        for (let c = 0; c < l.nOut; c++) sum += out[c] = Math.exp(out[c]! - max);
        for (let c = 0; c < l.nOut; c++) out[c]! /= sum;
      }
      h = out;
    }
    return h;
  }
}
