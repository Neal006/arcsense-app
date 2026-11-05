"""Invariants of the cross-language contracts in /shared.

The app runs the equivalent checks in app/src/shared/__tests__; both sides must
agree on the feature-spec hash (pinned below and in the app test).
"""

from __future__ import annotations

import copy
import re

import pytest

from arcsense_ml import shared

TYPE_SIZES = {"u8": 1, "i8": 1, "u16": 2, "i16": 2, "u32": 4, "f32": 4}


def test_gatt_suffixes_unique_and_hex() -> None:
    spec = shared.gatt_spec()
    seen: set[str] = set()
    for svc in spec["services"]:
        for s in [svc["suffix"], *(c["suffix"] for c in svc["characteristics"])]:
            assert re.fullmatch(r"[0-9A-F]{4}", s), s
            if s == svc["suffix"]:
                continue
            assert s not in seen, f"duplicate characteristic suffix {s}"
            seen.add(s)
    assert spec["advertisedServiceSuffix"] == spec["services"][0]["suffix"]


def test_gatt_types_and_props_valid() -> None:
    for svc in shared.gatt_spec()["services"]:
        for c in svc["characteristics"]:
            assert c["type"] in TYPE_SIZES, c
            assert set(c["props"]) <= {"read", "write", "notify"}, c
            assert c["props"], c


def test_gatt_keys_unique() -> None:
    keys = [c["key"] for s in shared.gatt_spec()["services"] for c in s["characteristics"]]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize(
    ("offset_key", "size_key"), [("alignedOffset", "alignedSize"), ("packedOffset", "packedSize")]
)
def test_telemetry_packet_layout_tiles_exactly(offset_key: str, size_key: str) -> None:
    pkt = shared.gatt_spec()["telemetryPacket"]
    covered = bytearray(pkt[size_key])
    for f in pkt["fields"]:
        start = f[offset_key]
        for b in range(start, start + TYPE_SIZES[f["type"]]):
            assert b < len(covered), f"{f['key']} overruns {size_key}"
            assert covered[b] == 0, f"{f['key']} overlaps at byte {b}"
            covered[b] = 1
        if f["type"] in ("u16", "u32", "i16") and offset_key == "alignedOffset":
            assert start % TYPE_SIZES[f["type"]] == 0, f"{f['key']} misaligned"
    padding = covered.count(0)
    assert padding == (1 if offset_key == "alignedOffset" else 0)


def test_label_catalog_integrity() -> None:
    labels = shared.labels_by_id()
    void_id = shared.void_label_id()
    assert labels[void_id].kind == "void"
    for lab in labels.values():
        assert 1 <= lab.id <= 0xFFFF
        if lab.kind in ("start", "end"):
            assert lab.pair_id is not None, lab
            partner = labels[lab.pair_id]
            assert partner.pair_id == lab.id
            assert {lab.kind, partner.kind} == {"start", "end"}
            assert partner.name == lab.name
        else:
            assert lab.pair_id is None, lab
        if lab.training_class is not None:
            assert lab.kind == "start"
            assert lab.training_class in shared.class_names()


def test_every_class_is_annotatable() -> None:
    annotated = {lab.training_class for lab in shared.labels_by_id().values()}
    assert set(shared.class_names()) <= annotated


def test_duplicate_label_id_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    cat = copy.deepcopy(shared.label_catalog())
    cat["labels"].append(dict(cat["labels"][0]))
    shared.labels_by_id.cache_clear()
    monkeypatch.setattr(shared, "label_catalog", lambda: cat)
    with pytest.raises(ValueError, match="duplicate label id"):
        shared.labels_by_id()
    monkeypatch.undo()
    shared.labels_by_id.cache_clear()


def test_feature_spec_shape() -> None:
    names = shared.feature_names()
    assert len(names) == 10
    assert len(set(names)) == 10
    assert shared.class_names() == ["Normal", "Freezing", "Shuffling", "Limping"]
    fo = shared.feature_spec()["freezeOverride"]
    assert shared.class_names()[fo["classIndex"]] == "Freezing"


# Pinned so that an accidental edit to feature_spec.json is caught here AND in the
# app test (which pins the same value). Bump both together, deliberately.
EXPECTED_FEATURE_SPEC_HASH = "1a66e940e1be4294e24f6d0b2b16729cfc312a918e320b9eedfcd47fee96bc42"


def test_feature_spec_hash_is_pinned() -> None:
    assert shared.feature_spec_hash() == EXPECTED_FEATURE_SPEC_HASH


def test_feature_spec_hash_ignores_runtime_thresholds() -> None:
    spec = copy.deepcopy(shared.feature_spec())
    spec["freezeOverride"]["threshold"] = 2.0
    assert shared.feature_spec_hash(spec) == shared.feature_spec_hash()
    spec["features"] = list(reversed(spec["features"]))
    assert shared.feature_spec_hash(spec) != shared.feature_spec_hash()


def test_canonical_json_is_order_independent() -> None:
    assert shared.canonical_json({"b": 1, "a": [1, "é"]}) == '{"a":[1,"é"],"b":1}'


def test_canonical_json_rejects_floats() -> None:
    with pytest.raises(TypeError, match="not portable"):
        shared.canonical_json({"t": 3.5})
