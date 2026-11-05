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
