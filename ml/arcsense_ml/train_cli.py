"""arcsense-train: evaluate, fit and export the stride classifier."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .dataset import xy
from .export import export_model
from .synth import synth_dataset
from .train import TrainConfig, evaluate, train_final


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dataset", type=Path, help="CSV from dataset.build_dataset()")
    src.add_argument("--synthetic", action="store_true", help="pipeline test on synthetic data")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--epochs", type=int, default=TrainConfig.epochs)
    args = ap.parse_args(argv)

    df = synth_dataset() if args.synthetic else pd.read_csv(args.dataset)
    cfg = TrainConfig(epochs=args.epochs)
    report = evaluate(df, cfg)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "evaluation.json").write_text(json.dumps(report.to_dict(), indent=1) + "\n")
    for note in report.notes:
        sys.stdout.write(f"NOTE: {note}\n")
    sys.stdout.write(
        f"{report.scheme}: accuracy {report.accuracy:.3f} on {report.n_strides} strides\n"
    )
    model = train_final(df, cfg)
    X, _ = xy(df)
    res = export_model(
        model,
        X,
        X[:: max(1, len(X) // 32)],
        args.out,
        version=args.version,
        trained_on={
            "provenance": report.provenance,
            "subjects": report.subjects,
            "synthetic": report.synthetic,
        },
    )
    sys.stdout.write(
        f"exported int8 {res.int8_bytes} B, ops {res.ops}, agreement {res.int8_agreement:.3f}\n"
    )
    return 0
