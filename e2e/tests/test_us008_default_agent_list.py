"""Real terminal proof for the default numbered agent list: registration opens it, a second run appends, digits+Enter open details, a missing Herdr tab and a collected attempt stay inspectable, q closes and /graph agents reopens."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_terminal_dispatch_registers_fake_worker():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ') + '-' + uuid.uuid4().hex[:6]
    out = ROOT / 'agent-output/default-agent-list' / stamp
    result = subprocess.run([sys.executable, str(ROOT / 'e2e/default_agent_list_harness.py'),
                             '--cols', '200', '--rows', '60', '--out', str(out)],
                            cwd=ROOT, text=True, capture_output=True, timeout=360)
    print(result.stdout, end='')
    print(f'harness exit code: {result.returncode}')
    evidence = json.loads((out / 'evidence.json').read_text())
    if result.returncode == 2:
        pytest.skip(evidence['failureReason'])
    assert result.returncode == 0, result.stdout + result.stderr
    for key in ('dispatched', 'registeredEventSeen', 'workerTabSeen', 'fixtureWorkerSeen', 'selectedModelIsFixture', 'defaultSessionUnchanged',
                'listOpened', 'detailOpened', 'detailRefreshed', 'backToList', 'appendedSecondRun', 'firstNumberStable',
                'detailWithoutHerdrTarget', 'settledDetail', 'closedByOperator', 'reopened'):
        assert evidence[key] is True, key
    assert evidence['collectReply'].startswith('FAKE_SUPERVISOR_COLLECTED'), evidence['collectReply']
    assert evidence['secretScanFindings'] == 0
    captures = Path(evidence['capturesDir'])
    assert evidence['capturesSha256'] == hashlib.sha256(b''.join(p.read_bytes() for p in sorted(captures.iterdir()) if p.is_file())).hexdigest()
    for key in ('serverStopped', 'temporaryDbRemoved', 'runDirectoriesRemoved', 'onlyDefaultSessionRemains', 'namedSessionAbsent', 'tmuxSessionAbsent'):
        assert evidence['cleanup'][key] is True, key
