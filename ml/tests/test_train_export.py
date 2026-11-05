"""Training and export (requires the `train` extra: uv sync --extra train)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("tensorflow")
pytest.importorskip("sklearn")

from arcsense_ml.dataset import build_dataset, xy
from arcsense_ml.export import ALLOWED_OPS, MAX_INT8_BYTES, TfliteRunner, export_model
from arcsense_ml.shared import feature_spec_hash
from arcsense_ml.synth import synth_dataset
from arcsense_ml.train import TrainConfig, class_weights, evaluate, train_final

pytestmark = pytest.mark.train

FAST = TrainConfig(epochs=40)


@pytest.fixture(scope="module")
def data():  # type: ignore[no-untyped-def]
    return build_dataset([synth_dataset(n_subjects=3, strides_per_class=40, seed=11)])


@pytest.fixture(scope="module")
def exported(data, tmp_path_factory):  # type: ignore[no-untyped-def]
    model = train_final(data, FAST)
    X, _ = xy(data)
    out = tmp_path_factory.mktemp("model")
    res = export_model(model, X, X[::17], out, version="test", trained_on={"synthetic": True})
    return model, X, res


def test_class_weights_balance_classes() -> None:
    w = class_weights(np.array([0, 0, 0, 1, 2, 2], dtype=np.int64))
    assert w == pytest.approx({0: 6 / 9, 1: 2.0, 2: 1.0})


def test_loso_evaluation_on_synthetic_data_is_flagged(data) -> None:  # type: ignore[no-untyped-def]
    rep = evaluate(data, FAST)
    assert rep.scheme == "leave-one-subject-out" and rep.folds == 3
    assert rep.synthetic and rep.notes[0].startswith("SYNTHETIC DATA")
    assert rep.n_strides == len(data)
    assert sum(map(sum, rep.confusion)) == len(data)
    assert rep.accuracy > 0.7  # synthetic classes are separable by construction
    assert rep.feature_spec_hash == feature_spec_hash()


def test_single_subject_uses_holdout_and_says_it_is_optimistic(data) -> None:  # type: ignore[no-untyped-def]
    one = data[data["subject"] == "SYN00"]
    rep = evaluate(one, FAST)
    assert rep.scheme.startswith("stratified-80-20")
    assert any("overestimates" in n for n in rep.notes)


def test_training_is_deterministic(data) -> None:  # type: ignore[no-untyped-def]
    a = train_final(data, TrainConfig(epochs=3))
    b = train_final(data, TrainConfig(epochs=3))
    for wa, wb in zip(a.get_weights(), b.get_weights(), strict=True):
        np.testing.assert_array_equal(wa, wb)


def test_export_artifacts_and_checks(exported) -> None:  # type: ignore[no-untyped-def]
    _, _, res = exported
    names = sorted(p.name for p in res.out_dir.iterdir())
    assert sorted(names) == sorted(
        [
            "feature_spec.h",
            "golden_vectors.h",
            "golden_vectors.json",
            "model.tflite",
            "model_data.h",
            "model_int8.tflite",
            "model_meta.json",
            "mlp_weights.json",
        ]
    )
    assert set(res.ops) <= ALLOWED_OPS
    assert "FULLY_CONNECTED" in res.ops
    assert res.int8_bytes < MAX_INT8_BYTES
    assert res.int8_agreement >= 0.98
    meta = json.loads((res.out_dir / "model_meta.json").read_text())
    assert meta["featureSpecHash"] == feature_spec_hash()
    assert meta["int8Bytes"] == res.int8_bytes


def test_float_tflite_matches_keras(exported) -> None:  # type: ignore[no-untyped-def]
    model, X, res = exported
    runner = TfliteRunner((res.out_dir / "model.tflite").read_bytes())
    np.testing.assert_allclose(runner.predict(X[:50]), model.predict(X[:50], verbose=0), atol=1e-5)


def test_golden_vectors_reproduce(exported) -> None:  # type: ignore[no-untyped-def]
    _, _, res = exported
    g = json.loads((res.out_dir / "golden_vectors.json").read_text())
    runner = TfliteRunner((res.out_dir / "model_int8.tflite").read_bytes())
    pred = runner.predict(np.array(g["inputs"], dtype=np.float32)).argmax(1)
    assert pred.tolist() == g["int8Argmax"]


@pytest.mark.skipif(shutil.which("g++") is None, reason="g++ not installed")
def test_c_headers_compile_as_arduino_cpp(exported, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    _, _, res = exported
    src = tmp_path / "check.cpp"
    src.write_text(
        '#include "model_data.h"\n#include "golden_vectors.h"\n'
        'static_assert(ARCSENSE_NUM_FEATURES == 10, "features");\n'
        "int main() { return (g_arcsense_model_len > 0 && kGoldenArgmax[0] >= 0) ? 0 : 1; }\n"
    )
    exe = tmp_path / "check"
    subprocess.run(
        ["g++", "-std=c++17", "-Wall", "-Werror", "-I", str(res.out_dir), str(src), "-o", str(exe)],
        check=True,
    )
    assert subprocess.run([str(exe)]).returncode == 0


def test_framework_free_mlp_reproduces_float_tflite(exported) -> None:  # type: ignore[no-untyped-def]
    _, X, res = exported
    w = json.loads((res.out_dir / "mlp_weights.json").read_text())
    n = w["normalization"]
    h = (X[:100].astype(np.float64) - np.array(n["mean"])) / np.maximum(
        np.sqrt(np.array(n["variance"])), n["epsilon"]
    )
    for layer in w["layers"]:
        h = h @ np.array(layer["kernel"]) + np.array(layer["bias"])
        if layer["activation"] == "relu":
            h = np.maximum(h, 0)
        else:
            assert layer["activation"] == "softmax"
            e = np.exp(h - h.max(axis=1, keepdims=True))
            h = e / e.sum(axis=1, keepdims=True)
    tfl = TfliteRunner((res.out_dir / "model.tflite").read_bytes()).predict(X[:100])
    np.testing.assert_allclose(h, tfl, atol=1e-5)
