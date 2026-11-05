from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import pytest

from arcsense_ml.app_export import read_app_export
from arcsense_ml.io import SchemaError
from arcsense_ml.shared import REPO_ROOT

GOLDEN = REPO_ROOT / "shared" / "fixtures" / "app_export_v1"


def test_reads_golden_export_from_folder() -> None:
    exp = read_app_export(GOLDEN)
    assert exp.session_id == "P001_golden"
    assert exp.session["condition"] == 'Overground, "fast", 10 m'  # CSV/JSON quoting survived
    assert list(exp.sync_tokens["token_hex"]) == ["0xAA01", "0xAA02", "0xAA03", "0xAA04", "0xAA05"]
    assert list(exp.sync_tokens["reason"]) == ["start", "resync", "periodic", "resume", "stop"]
    assert list(exp.sync_tokens["run"]) == [0, 0, 0, 1, 1]
    assert exp.sync_tokens["session_ms"].is_monotonic_increasing
    assert not exp.sync_tokens["partial"].any()
    assert exp.sync_tokens["l_dispatch_session_ms"].iloc[3] == pytest.approx(84_100)


def test_golden_labels_and_notes() -> None:
    exp = read_app_export(GOLDEN)
    lab = exp.labels
    assert list(lab["key"]) == [
        "trialNormalStart",
        "fogStart",
        "fogEnd",
        "turn",
        "void",
        "trialNormalEnd",
    ]
    assert list(lab["voided"]) == [False, False, False, True, False, False]
    assert lab["voids_seq"].iloc[4] == 3
    assert lab["voids_seq"].isna().sum() == 5
    assert list(lab["auto_closed"]) == [False] * 5 + [True]
    assert exp.notes["text"].iloc[0] == "turned, at the wall"
    assert "link_lost" in set(exp.connection_events["type"])


def test_reads_zip_with_session_folder(tmp_path: Path) -> None:
    z = tmp_path / "P001_golden.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for f in GOLDEN.iterdir():
            zf.write(f, f"P001_golden/{f.name}")
    assert read_app_export(z).session_id == "P001_golden"


def test_rejects_wrong_format_and_version(tmp_path: Path) -> None:
    d = tmp_path / "exp"
    shutil.copytree(GOLDEN, d)
    meta = json.loads((d / "session.json").read_text())
    meta["version"] = 99
    (d / "session.json").write_text(json.dumps(meta))
    with pytest.raises(SchemaError, match="unsupported export version"):
        read_app_export(d)
    meta["format"] = "other"
    (d / "session.json").write_text(json.dumps(meta))
    with pytest.raises(SchemaError, match="not an arcsense-session-export"):
        read_app_export(d)


def test_rejects_missing_files_and_count_mismatch(tmp_path: Path) -> None:
    d = tmp_path / "exp"
    shutil.copytree(GOLDEN, d)
    lines = (d / "labels.csv").read_text().splitlines(keepends=True)
    (d / "labels.csv").write_text("".join(lines[:-1]))
    with pytest.raises(SchemaError, match="says 6 labels, CSV has 5"):
        read_app_export(d)
    (d / "notes.csv").unlink()
    with pytest.raises(SchemaError, match="missing"):
        read_app_export(d)
    with pytest.raises(SchemaError, match="expected an export folder"):
        read_app_export(d / "session.json")


def test_rejects_bad_boolean(tmp_path: Path) -> None:
    d = tmp_path / "exp"
    shutil.copytree(GOLDEN, d)
    raw = (d / "sync_tokens.csv").read_bytes()
    assert b",0\r\n" in raw
    (d / "sync_tokens.csv").write_bytes(raw.replace(b",0\r\n", b",yes\r\n", 1))
    with pytest.raises(SchemaError, match="expected 0/1"):
        read_app_export(d)


def test_rejects_zip_with_duplicates_or_missing(tmp_path: Path) -> None:
    z = tmp_path / "dup.zip"
    with zipfile.ZipFile(z, "w") as zf:
        for f in GOLDEN.iterdir():
            zf.write(f, f"a/{f.name}")
        zf.write(GOLDEN / "notes.csv", "b/notes.csv")
    with pytest.raises(SchemaError, match=r"more than one notes\.csv"):
        read_app_export(z)
    z2 = tmp_path / "partial.zip"
    with zipfile.ZipFile(z2, "w") as zf:
        zf.write(GOLDEN / "session.json", "a/session.json")
    with pytest.raises(SchemaError, match="archive is missing"):
        read_app_export(z2)
