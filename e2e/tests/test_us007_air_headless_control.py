"""Persistent proof checks for the real JetBrains Air headless-control rehearsal."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "agent-output" / "air-headless-orchestration" / "air-e2e.json"


def test_real_air_headless_control_evidence() -> None:
    assert EVIDENCE.exists(), f"real Air evidence missing: {EVIDENCE}"
    data = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    assert data["schemaVersion"] == 1
    assert data["air"]["bundleId"] == "com.jetbrains.air"
    assert re.fullmatch(r"\d+\.\d+\.\d+", data["air"]["version"])
    assert data["piAcp"]["version"] == "0.0.31"
    assert data["runtimes"]["acpx"] == "0.13.2"
    assert data["runtimes"]["agentfs"] == "0.6.4"
    assert data["transport"] == "headless"
    assert data["herdr"]["required"] is False
    assert data["herdr"]["resourcesCreated"] == 0
    assert data["workflow"]["started"] is True
    assert data["workflow"]["progressObserved"] is True
    assert data["workflow"]["statusObserved"] is True
    assert data["workflow"]["cancelled"] is True
    assert data["workflow"]["resumed"] is True
    assert data["workflow"]["reportValidated"] is True
    assert data["cleanup"]["airConfigRestored"] is True
    assert data["cleanup"]["temporaryPiHomeAbsent"] is True
    assert data["cleanup"]["tokenFileAbsent"] is True
    assert data["cleanup"]["leakedProcesses"] == 0
    assert data["secretScanFindings"] == 0
    assert data["airConfigBeforeSha256"] == data["airConfigAfterSha256"]
    transcript = Path(data["transcriptPath"])
    assert transcript.exists()
    text = transcript.read_text(encoding="utf-8")
    for marker in ["run_created", "operation_started", "status", "cancelled", "recovery_resolved", "completed"]:
        assert marker in text
    assert not re.search(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", text)
    assert hashlib.sha256(transcript.read_bytes()).hexdigest() == data["transcriptSha256"]
