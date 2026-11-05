"""Command-line entry points (installed as arcsense-qa / arcsense-align / arcsense-bin2csv)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from .align import align_phone_to_device, map_labels_to_device
from .app_export import read_app_export
from .bin_reader import read_bin
from .qa import bin_to_frame, discover, qa_session


def qa_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Quality report for one recorded session folder.")
    ap.add_argument("folder", type=Path, help="folder with I_*.BIN, S_*.CSV and the app export")
    ap.add_argument("--out", type=Path, help="write the Markdown report here")
    args = ap.parse_args(argv)
    report = qa_session(discover(args.folder))
    md = report.to_markdown(f"Session QA: {args.folder.name}")
    if args.out:
        args.out.write_text(md, encoding="utf-8")
    sys.stdout.write(md)
    return {"pass": 0, "info": 0, "warn": 1, "fail": 2}[report.status]


def bin2csv_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Decode an ARC1 BIN to CSV (valid records only).")
    ap.add_argument("bin", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    rec = read_bin(args.bin)
    bin_to_frame(rec).to_csv(args.out, index=False, float_format="%.6f")
    i = rec.integrity
    sys.stdout.write(
        f"{args.bin.name}: {i.valid_records} samples written; end={i.end_reason}, "
        f"torn={i.torn_records}, label channel={i.label_marker_mode}\n"
    )
    return 0


def align_main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Map app labels onto each ankle's IMU samples.")
    ap.add_argument("folder", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="CSV of labels with sample indices")
    args = ap.parse_args(argv)
    inputs = discover(args.folder)
    if inputs.export is None or not inputs.bins:
        sys.stderr.write("need an app export and at least one I_*.BIN\n")
        return 2
    exp = read_app_export(inputs.export)
    frames = []
    for side, path in sorted(inputs.bins.items()):
        rec = read_bin(path)
        a = align_phone_to_device(exp, rec, side)  # type: ignore[arg-type]
        lab = map_labels_to_device(exp, a, rec).assign(side=side)
        frames.append(lab)
        sys.stdout.write(
            f"{side}: {len(a.clock.tokens_used)} tokens, drift {a.clock.drift_ppm:+.1f} ppm, "
            f"max residual {a.clock.max_abs_residual_us / 1000:.1f} ms\n"
        )
    pd.concat(frames, ignore_index=True).to_csv(args.out, index=False)
    return 0
