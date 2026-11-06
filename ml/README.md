# arcsense-ml

Python tooling for ARC SENSE recordings and for training the EdgeML model.

```bash
uv sync                     # core and dev dependencies (Python 3.12 is installed by uv)
uv sync --extra train       # also installs TensorFlow and scikit-learn for training and export
uv run pytest --cov         # tests
uv run ruff check . && uv run mypy arcsense_ml tests
```

| Module | Purpose |
|---|---|
| `shared` | Loads `/shared/*.json` and computes the feature-spec hash. |
| `io` | Readers for `S_*`, `E_*` and `I_*` CSV files, with schema validation. |
| `bin_reader` | Raw `I_*.BIN` reader: detects end of data and torn records, unwraps the 24-bit timer, and works out what the label channel is used for. |

## Toolchain notes

- The TF runtime installs the XNNPACK delegate by default. `TfliteRunner` disables
  delegates (`BUILTIN_WITHOUT_DEFAULT_DELEGATES`) so op lists and predictions match
  what the firmware's plain TFLite Micro kernels do. With the delegate on, the
  interpreter reports a synthetic `DELEGATE` op that is not in the flatbuffer and
  can change int8 results.
- The int8 model takes **normalised** features; the float model takes raw features.
  The constants are emitted into `feature_spec.h` and `mlp_weights.json`.
