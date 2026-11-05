from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from arcsense_ml.dataset import build_dataset, loso_splits, xy
from arcsense_ml.shared import class_names, feature_names
from arcsense_ml.synth import reference_strides, synth_dataset, synth_strides


def test_reference_strides_are_the_53_valid_0007_strides() -> None:
    assert len(reference_strides()) == 53


def test_synthetic_rows_are_tagged_and_physically_consistent() -> None:
    df = synth_dataset(n_subjects=3, strides_per_class=40, seed=1)
    assert (df["provenance"] == "synthetic").all()
    assert set(df["label"]) == set(class_names())
    assert df.groupby("subject").size().tolist() == [160, 160, 160]
    np.testing.assert_allclose(df["swingTimeS"] + df["stanceTimeS"], df["strideTimeS"])
    assert (df[["strideTimeS", "strideLengthM"]] > 0).all().all()


def test_class_signatures_differ_in_the_expected_direction() -> None:
    df = synth_dataset(n_subjects=4, strides_per_class=200, seed=2)

    def med(cls: str, col: str) -> float:
        return float(df.loc[df["label"] == cls, col].median())

    assert med("Shuffling", "strideLengthM") < 0.75 * med("Normal", "strideLengthM")
    assert med("Limping", "asymmetryIndex") > 0.1 > med("Normal", "asymmetryIndex")
    assert med("Freezing", "freezeIndex") >= 3.0


def test_synth_is_deterministic_and_rejects_unknown_class() -> None:
    a = synth_strides("Normal", 5, np.random.default_rng(7))
    b = synth_strides("Normal", 5, np.random.default_rng(7))
    pd.testing.assert_frame_equal(a, b)
    with pytest.raises(ValueError, match="unknown class"):
        synth_strides("Running", 5, np.random.default_rng(0))


def test_build_dataset_drops_unlabelled_and_invalid_and_validates() -> None:
    syn = synth_dataset(n_subjects=1, strides_per_class=5, seed=3)
    syn.loc[0, "label"] = None
    syn.loc[1, "strideLengthM"] = 0.0
    ds = build_dataset([syn])
    assert len(ds) == len(syn) - 2
    assert list(ds.columns) == [*feature_names(), "label", "subject", "provenance"]
    X, y = xy(ds)
    assert X.shape == (len(ds), 10) and X.dtype == np.float32
    assert set(y) == {0, 1, 2, 3}
    with pytest.raises(ValueError, match="missing column"):
        build_dataset([syn.drop(columns="subject")])
    with pytest.raises(ValueError, match="unknown provenance"):
        build_dataset([syn.assign(provenance="guess")])
    with pytest.raises(ValueError, match="unknown class labels"):
        build_dataset([syn.assign(label="Running")])
    assert build_dataset([]).empty


def test_loso_never_leaks_a_subject() -> None:
    ds = build_dataset([synth_dataset(n_subjects=3, strides_per_class=10, seed=4)])
    folds = list(loso_splits(ds))
    assert [f[0] for f in folds] == ["SYN00", "SYN01", "SYN02"]
    for subject, train, test in folds:
        assert set(ds.iloc[test]["subject"]) == {subject}
        assert subject not in set(ds.iloc[train]["subject"])
        assert len(train) + len(test) == len(ds)
    with pytest.raises(ValueError, match="at least two"):
        list(loso_splits(ds[ds["subject"] == "SYN00"]))
