from __future__ import annotations

from pathlib import Path

import pytest

from arcsense_ml.io import (
    EVENT_TYPES,
    SchemaError,
    parse_session_filename,
    read_events,
    read_imu_csv,
    read_strides,
)


def test_read_strides_0007(ref0007: Path) -> None:
    df = read_strides(ref0007 / "S_L_0007.CSV")
    assert len(df) == 54
    assert df["sampleIndex"].is_monotonic_increasing
    # report: mean stride time 1.305 s, SD 0.038 s
    assert df["strideTimeS"].mean() == pytest.approx(1.305, abs=0.003)
    assert df["strideTimeS"].std() == pytest.approx(0.038, abs=0.003)
    # no inference was run in this session (edgeai_label == -1)
    assert not df["edgeai_label_valid"].any()


def test_read_events_0007_sorted_and_named(ref0007: Path) -> None:
    df = read_events(ref0007 / "E_L_0007.CSV")
    assert len(df) == 217
    assert df["sampleIndex"].is_monotonic_increasing
    assert set(df["eventType"]) == set(EVENT_TYPES)
    counts = df["eventType"].value_counts()
    assert counts["HEEL_STRIKE"] == 54


def test_read_events_accepts_integer_codes(tmp_path: Path) -> None:
    p = tmp_path / "E_R_0001.CSV"
    p.write_text("session_us,timestamp_us,sampleIndex,eventType\n10,10,5,2\n5,5,1,0\n")
    df = read_events(p)
    assert list(df["eventType"]) == ["MID_SWING", "HEEL_STRIKE"]


def test_read_events_rejects_unknown_type(tmp_path: Path) -> None:
    p = tmp_path / "E_R_0001.CSV"
    p.write_text("session_us,timestamp_us,sampleIndex,eventType\n10,10,5,JUMP\n")
    with pytest.raises(SchemaError, match="unknown event type"):
        read_events(p)
    p.write_text("session_us,timestamp_us,sampleIndex,eventType\n10,10,5,7\n")
    with pytest.raises(SchemaError, match="unknown event code 7"):
        read_events(p)


def test_read_imu_csv_0007(ref0007: Path) -> None:
    df = read_imu_csv(ref0007 / "I_L_0007.csv")
    assert len(df) == 32178
    assert df["sample_idx"].iloc[-1] == 32177


def test_missing_column_raises(tmp_path: Path) -> None:
    p = tmp_path / "S_L_0001.CSV"
    p.write_text("session_us,timestamp_us\n1,2\n")
    with pytest.raises(SchemaError, match="missing columns"):
        read_strides(p)


def test_non_numeric_raises_with_location(tmp_path: Path, ref0007: Path) -> None:
    text = (ref0007 / "S_L_0007.CSV").read_text().splitlines()
    cells = text[3].split(",")
    cells[3] = "abc"
    text[3] = ",".join(cells)
    p = tmp_path / "S_L_0007.CSV"
    p.write_text("\n".join(text) + "\n")
    with pytest.raises(SchemaError, match=r"'abc' in column 'strideTimeS' \(row 2\)"):
        read_strides(p)


def test_empty_file_raises(tmp_path: Path) -> None:
    p = tmp_path / "S_L_0001.CSV"
    p.write_text("")
    with pytest.raises(SchemaError, match="empty"):
        read_strides(p)


@pytest.mark.parametrize(
    ("name", "kind", "role", "session", "ext"),
    [
        ("S_L_0007.CSV", "S", "L", 7, "csv"),
        ("i_r_0123.bin", "I", "R", 123, "bin"),
        ("E_R_9999.csv", "E", "R", 9999, "csv"),
    ],
)
def test_parse_session_filename(name: str, kind: str, role: str, session: int, ext: str) -> None:
    f = parse_session_filename(name)
    assert (f.kind, f.role, f.session, f.ext) == (kind, role, session, ext)


@pytest.mark.parametrize("name", ["S_X_0007.CSV", "S_L_07.CSV", "strides.csv", "Q_L_0007.CSV"])
def test_parse_session_filename_rejects(name: str) -> None:
    with pytest.raises(SchemaError):
        parse_session_filename(name)
