from __future__ import annotations

import json
import shutil
from pathlib import Path

import pandas as pd
import pytest

from arcsense_ml.app_export import LABEL_COLUMNS, SYNC_COLUMNS
from arcsense_ml.cli import align_main, bin2csv_main, qa_main
from arcsense_ml.qa import discover, qa_session
from arcsense_ml.simulate import simulate_session


def write_session_folder(folder: Path, *, seed: int = 0) -> Path:
    """A simulated bilateral session laid out exactly as copied from the field."""
    sim = simulate_session(duration_s=600.0, seed=seed)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "I_L_0001.BIN").write_bytes(sim.bin_l)
    (folder / "I_R_0001.BIN").write_bytes(sim.bin_r)
    exp = folder / "P009_sim"
    exp.mkdir()
    sync = sim.sync_tokens.assign(
        seq=range(len(sim.sync_tokens)),
        run=0,
        token_hex=[f"0x{t:04X}" for t in sim.sync_tokens["token"]],
        reason=["start"] + ["periodic"] * (len(sim.sync_tokens) - 1),
        wall_iso="2026-11-09T10:00:00.000Z",
        l_write_mode="without-response",
        l_error="",
        r_write_mode="without-response",
        r_error="",
        js_dispatch_skew_ms=0,
        partial=0,
    )[list(SYNC_COLUMNS)]
    sync.to_csv(exp / "sync_tokens.csv", index=False)
    keys = {1: "trialNormalStart", 7: "fogStart", 8: "fogEnd", 2: "trialNormalEnd"}
    kinds = {1: "start", 7: "start", 8: "end", 2: "end"}
    lab = sim.labels.assign(
        seq=range(len(sim.labels)),
        run=0,
        key=[keys[i] for i in sim.labels["label_id"]],
        name="x",
        kind=[kinds[i] for i in sim.labels["label_id"]],
        group="trial",
        wall_iso="2026-11-09T10:00:00.000Z",
        l_status="sent",
        l_dispatch_session_ms=sim.labels["session_ms"],
        l_write_mode="without-response",
        l_error="",
        r_status="sent",
        r_dispatch_session_ms=sim.labels["session_ms"],
        r_write_mode="without-response",
        r_error="",
        delivered=1,
        voided=0,
        voids_seq="",
        auto_closed=0,
    )[list(LABEL_COLUMNS)]
    lab.to_csv(exp / "labels.csv", index=False)
    pd.DataFrame(columns=["seq", "run", "session_ms", "wall_iso", "text"]).to_csv(
        exp / "notes.csv", index=False
    )
    pd.DataFrame(
        columns=["idx", "run", "session_ms", "wall_iso", "type", "side", "device_id", "detail"]
    ).to_csv(exp / "connection_events.csv", index=False)
    meta = {
        "format": "arcsense-session-export",
        "version": 1,
        "session": {"id": "P009_sim"},
        "runs": [],
    }
    (exp / "session.json").write_text(json.dumps(meta))
    return folder


def levels(report) -> dict[tuple[str, str], str]:  # type: ignore[no-untyped-def]
    return {(i.area, i.check): i.level for i in report.items}


def test_qa_on_session_0007_flags_missing_sync(ref0007: Path) -> None:
    inputs = discover(ref0007)
    assert set(inputs.bins) == {"L"} and set(inputs.strides) == {"L"}
    report = qa_session(inputs)
    lv = levels(report)
    assert lv[("BIN L", "samples")] == "pass"
    assert lv[("BIN L", "sample rate")] == "pass"
    assert lv[("BIN L", "torn record")] == "warn"
    assert lv[("BIN L", "sync tokens in file")] == "fail"
    assert lv[("Files", "app export")] == "warn"
    assert lv[("Files", "sides")] == "info"
    assert report.status == "fail"
    fi = next(i for i in report.items if i.check == "freeze index")
    assert "max 4.11" in fi.detail and "15% >= 3.0" in fi.detail  # FINDINGS F-01
    md = report.to_markdown()
    assert md.startswith("# Session QA") and "**Overall: FAIL**" in md


def test_qa_on_a_good_simulated_bilateral_session(tmp_path: Path) -> None:
    folder = write_session_folder(tmp_path / "s1")
    report = qa_session(discover(folder))
    bad = [i for i in report.items if i.level in ("warn", "fail")]
    assert bad == []
    lv = levels(report)
    assert lv[("Sync L", "tokens matched")] == "pass"
    assert lv[("Sync L-R", "ankle alignment")] == "pass"
    assert lv[("Labels", "labels")] == "pass"


def test_qa_reports_role_mismatch_and_missing_tokens(tmp_path: Path) -> None:
    folder = write_session_folder(tmp_path / "s2")
    # swap file names: header role no longer matches the name
    (folder / "I_L_0001.BIN").rename(folder / "tmp.BIN")
    (folder / "I_R_0001.BIN").rename(folder / "I_L_0001.BIN")
    (folder / "tmp.BIN").rename(folder / "I_R_0001.BIN")
    report = qa_session(discover(folder))
    assert levels(report)[("BIN L", "role")] == "fail"


def test_qa_with_no_files(tmp_path: Path) -> None:
    report = qa_session(discover(tmp_path))
    assert levels(report)[("Files", "IMU recordings")] == "fail"


def test_cli_qa_exit_codes_and_report_file(
    tmp_path: Path, ref0007: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "qa.md"
    assert qa_main([str(ref0007), "--out", str(out)]) == 2
    assert "FAIL" in out.read_text()
    good = write_session_folder(tmp_path / "good")
    assert qa_main([str(good)]) == 0
    assert "**Overall: PASS**" in capsys.readouterr().out


def test_cli_bin2csv_drops_the_torn_record(tmp_path: Path, ref0007: Path) -> None:
    out = tmp_path / "I_L_0007.csv"
    assert bin2csv_main([str(ref0007 / "I_L_0007.BIN"), "--out", str(out)]) == 0
    df = pd.read_csv(out)
    assert len(df) == 32177
    assert df["gyro_y_dps"].abs().max() < 1000


def test_cli_align_writes_labels_per_side(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    folder = write_session_folder(tmp_path / "s3")
    out = tmp_path / "aligned.csv"
    assert align_main([str(folder), "--out", str(out)]) == 0
    df = pd.read_csv(out)
    assert sorted(df["side"].unique()) == ["L", "R"]
    assert len(df) == 8
    assert "drift" in capsys.readouterr().out
    empty = tmp_path / "empty"
    empty.mkdir()
    assert align_main([str(empty), "--out", str(out)]) == 2


def test_discover_accepts_zip_and_export_root(tmp_path: Path) -> None:
    folder = write_session_folder(tmp_path / "s4")
    shutil.make_archive(str(folder / "P009_sim"), "zip", folder, "P009_sim")
    shutil.rmtree(folder / "P009_sim")
    assert discover(folder).export == folder / "P009_sim.zip"
    assert qa_session(discover(folder)).status == "pass"
