"""Loaders for the cross-language contracts in ``/shared``.

The app (TypeScript) is generated from the same JSON files; ``feature_spec_hash``
must produce byte-identical output to ``app/scripts/gen-shared.ts`` so that a model
exported here can be verified by the app before it is loaded.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_DIR = REPO_ROOT / "shared"


def _load(name: str) -> dict[str, Any]:
    with (SHARED_DIR / f"{name}.json").open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


@cache
def gatt_spec() -> dict[str, Any]:
    return _load("gatt_spec")


@cache
def label_catalog() -> dict[str, Any]:
    return _load("label_catalog")


@cache
def feature_spec() -> dict[str, Any]:
    return _load("feature_spec")


def _assert_portable(obj: Any) -> None:
    """Reject floats: Python prints ``3.0`` where JavaScript prints ``3``."""
    if isinstance(obj, bool) or obj is None or isinstance(obj, (str, int)):
        return
    if isinstance(obj, list):
        for v in obj:
            _assert_portable(v)
        return
    if isinstance(obj, dict):
        for v in obj.values():
            _assert_portable(v)
        return
    raise TypeError(f"canonical_json: {type(obj).__name__} value {obj!r} is not portable")


def canonical_json(obj: Any) -> str:
    """Deterministic JSON identical to ``app/scripts/canonical.ts``.

    Sorted keys, no whitespace, UTF-8 (non-ASCII kept). Only strings, booleans,
    null, integers, lists and dicts are allowed.
    """
    _assert_portable(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def feature_spec_hash(spec: dict[str, Any] | None = None) -> str:
    """SHA-256 over the parts of the feature spec that define the model input/output.

    Only ``version``, ``features`` and ``classes`` participate; thresholds in
    ``freezeOverride`` are runtime settings and must not invalidate a model.
    """
    spec = feature_spec() if spec is None else spec
    payload = {
        "version": spec["version"],
        "features": spec["features"],
        "classes": spec["classes"],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def feature_names() -> list[str]:
    return [f["key"] for f in feature_spec()["features"]]


def class_names() -> list[str]:
    return list(feature_spec()["classes"])


@dataclass(frozen=True)
class Label:
    id: int
    key: str
    name: str
    kind: str  # "start" | "end" | "instant" | "void"
    group: str
    pair_id: int | None
    training_class: str | None


@cache
def labels_by_id() -> dict[int, Label]:
    out: dict[int, Label] = {}
    for raw in label_catalog()["labels"]:
        lab = Label(
            id=int(raw["id"]),
            key=raw["key"],
            name=raw["name"],
            kind=raw["kind"],
            group=raw["group"],
            pair_id=raw.get("pairId"),
            training_class=raw.get("trainingClass"),
        )
        if lab.id in out:
            raise ValueError(f"duplicate label id {lab.id} in label_catalog.json")
        out[lab.id] = lab
    return out


def void_label_id() -> int:
    return int(label_catalog()["voidId"])
