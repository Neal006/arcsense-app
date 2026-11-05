"""Per-stride gait classifier training and evaluation (M09). Requires the
``train`` extra (TensorFlow, scikit-learn).

Model: Normalization (adapted on training data, baked into the graph so the
firmware feeds raw features) -> Dense(16, relu) -> Dense(8, relu) ->
Dense(4, softmax). About 400 parameters: small enough for TFLite Micro on the
nRF52840 (target < 8 KB flatbuffer).

Evaluation is leave-one-subject-out when there are at least two subjects,
otherwise a stratified 80/20 split. A report built from data that contains
any synthetic rows is marked ``synthetic: true`` and must not be quoted as a
performance figure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
import pandas as pd

from .dataset import loso_splits, xy
from .shared import class_names, feature_names, feature_spec_hash

SEED = 20261105


@dataclass
class TrainConfig:
    hidden: tuple[int, ...] = (16, 8)
    epochs: int = 120
    batch_size: int = 32
    learning_rate: float = 3e-3
    seed: int = SEED


@dataclass
class EvalReport:
    scheme: str
    folds: int
    accuracy: float
    per_class: dict[str, dict[str, float]]
    confusion: list[list[int]]
    provenance: list[str]
    synthetic: bool
    n_strides: int
    subjects: list[str]
    feature_spec_hash: str
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _tf() -> Any:
    import tensorflow as tf

    return tf


def build_model(X_train: npt.NDArray[np.float32], cfg: TrainConfig) -> Any:
    tf = _tf()
    tf.keras.utils.set_random_seed(cfg.seed)
    norm = tf.keras.layers.Normalization(axis=-1, name="normalize")
    norm.adapt(X_train)
    inputs = tf.keras.Input(shape=(len(feature_names()),), name="features", dtype="float32")
    h = norm(inputs)
    for i, units in enumerate(cfg.hidden):
        h = tf.keras.layers.Dense(units, activation="relu", name=f"dense_{i}")(h)
    out = tf.keras.layers.Dense(len(class_names()), activation="softmax", name="probs")(h)
    model = tf.keras.Model(inputs, out, name="arcsense_gait")
    model.compile(
        optimizer=tf.keras.optimizers.Adam(cfg.learning_rate),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def class_weights(y: npt.NDArray[np.int64]) -> dict[int, float]:
    counts = np.bincount(y, minlength=len(class_names()))
    present = counts > 0
    w = np.zeros(len(counts))
    w[present] = len(y) / (present.sum() * counts[present])
    return {i: float(w[i]) for i in range(len(counts)) if present[i]}


def fit(X: npt.NDArray[np.float32], y: npt.NDArray[np.int64], cfg: TrainConfig) -> Any:
    tf = _tf()
    tf.config.experimental.enable_op_determinism()
    model = build_model(X, cfg)
    model.fit(
        X,
        y,
        epochs=cfg.epochs,
        batch_size=cfg.batch_size,
        class_weight=class_weights(y),
        shuffle=True,
        verbose=0,
    )
    return model


def _summarise(
    y_true: npt.NDArray[np.int64], y_pred: npt.NDArray[np.int64]
) -> tuple[float, dict[str, dict[str, float]], list[list[int]]]:
    from sklearn.metrics import confusion_matrix, precision_recall_fscore_support

    labels = list(range(len(class_names())))
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=labels, zero_division=0)
    per = {
        c: {
            "precision": float(p[i]),
            "recall": float(r[i]),
            "f1": float(f[i]),
            "support": int(s[i]),
        }
        for i, c in enumerate(class_names())
    }
    cm = confusion_matrix(y_true, y_pred, labels=labels).tolist()
    return float(np.mean(y_true == y_pred)), per, cm


def evaluate(df: pd.DataFrame, cfg: TrainConfig | None = None) -> EvalReport:
    cfg = cfg or TrainConfig()
    X, y = xy(df)
    subjects = sorted(df["subject"].unique())
    preds = np.full(len(y), -1, dtype=np.int64)
    notes: list[str] = []
    if len(subjects) >= 2:
        scheme = "leave-one-subject-out"
        splits = list(loso_splits(df))
        for _, train_idx, test_idx in splits:
            model = fit(X[train_idx], y[train_idx], cfg)
            preds[test_idx] = np.argmax(model.predict(X[test_idx], verbose=0), axis=1)
        folds = len(splits)
    else:
        from sklearn.model_selection import train_test_split

        scheme = "stratified-80-20 (single subject: optimistic)"
        notes.append("Only one subject: the test set shares the subject, so this overestimates.")
        idx = np.arange(len(y))
        train_idx, test_idx = train_test_split(
            idx, test_size=0.2, random_state=cfg.seed, stratify=y
        )
        model = fit(X[train_idx], y[train_idx], cfg)
        preds[test_idx] = np.argmax(model.predict(X[test_idx], verbose=0), axis=1)
        folds = 1
    mask = preds >= 0
    acc, per, cm = _summarise(y[mask], preds[mask])
    prov = sorted(df["provenance"].unique())
    synthetic = "synthetic" in prov
    if synthetic:
        notes.insert(0, "SYNTHETIC DATA - pipeline test only, not a performance claim.")
    if "imitated" in prov:
        notes.append(
            "Includes imitated gait from healthy volunteers; patient performance will differ."
        )
    return EvalReport(
        scheme=scheme,
        folds=folds,
        accuracy=acc,
        per_class=per,
        confusion=cm,
        provenance=prov,
        synthetic=synthetic,
        n_strides=len(y),
        subjects=subjects,
        feature_spec_hash=feature_spec_hash(),
        notes=notes,
    )


def train_final(df: pd.DataFrame, cfg: TrainConfig | None = None) -> Any:
    """Fit on all data (for export) after evaluate() has been reported."""
    X, y = xy(df)
    return fit(X, y, cfg or TrainConfig())
