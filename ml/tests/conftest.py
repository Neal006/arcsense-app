from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
REF_0007 = REPO_ROOT / "data" / "reference" / "session_0007"


@pytest.fixture(scope="session")
def ref0007() -> Path:
    assert REF_0007.is_dir(), f"reference data missing at {REF_0007}"
    return REF_0007
