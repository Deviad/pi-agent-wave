#!/bin/sh
# The two authorized Herdr measurements that prove US-007 in both directions.
#
# The finding: a happily settled Herdr worker's tab was never closed before the cleanup absence audit, so
# every such settlement reported a post-settlement failure and left its tab open, while the measurement
# driver reported "0 failures" because it never read `postSettlementFailures`.
#
# One direction proves the driver now surfaces the class; the other proves the fix closes it:
#   phase defect  - the close is reverted in scripts/delegate_core.py, so the defect is present. The run
#                   must report one post-settlement failure per settle and retain no cleanup record.
#   phase fixed   - the close is restored. The run must report none and retain a cleanup record per settle.
#
# The mutation is a temporary edit of one tracked file, so the restore point is a copy taken before the
# first mutation and a trap restores it on every exit path, Ctrl-C included. The copy is verified with
# `cmp` after each restore, because an unrestored file is the one outcome this script must never leave.
#
# Usage:
#   herdr-settle-mutation-proof.sh --check     # rehearse the toggle and the automated case; no provider spend
#   herdr-settle-mutation-proof.sh             # the two live runs; spends provider credit, needs Herdr identity
#
# The live mode must run from inside a Herdr workspace: the driver passes the ambient identity through, so
# HERDR_ENV, HERDR_WORKSPACE_ID and HERDR_TAB_ID must all be set, and the run creates a real tab per worker.

set -eu

package_dir=$(cd "$(dirname "$0")/../.." && pwd)
repo_dir=$(cd "$package_dir/../.." && pwd)
core="$package_dir/scripts/delegate_core.py"
driver="$package_dir/test/support/runtime-measure.ts"
lifecycle_test="$package_dir/test/runtime-lifecycle-python.test.ts"
model=${MODEL:-alibaba/qwen3.8-flash}

mode=${1:-live}
if [ "$mode" != "--check" ] && [ "$mode" != "live" ]; then
	echo "usage: $(basename "$0") [--check]" >&2
	exit 2
fi

restore_point=$(mktemp -d "${TMPDIR:-/tmp}/us-007-restore.XXXXXX")
cp "$core" "$restore_point/delegate_core.py"

restore() {
	cp "$restore_point/delegate_core.py" "$core"
	if ! cmp -s "$restore_point/delegate_core.py" "$core"; then
		echo "FAIL: $core was not restored byte-for-byte from the restore point" >&2
		return 1
	fi
}

cleanup() {
	status=$?
	restore || true
	rm -rf "$restore_point"
	exit "$status"
}
trap cleanup EXIT INT TERM HUP

mutate() {
	python3 - "$core" <<'PY'
import sys
from pathlib import Path

fixed = '''    try:
        close_settled_tab(run_dir, resource)
    except DelegateError as error:
        post_settlement_failures.append(str(error))
'''
mutated = '''    if False:  # US-007 mutation: the close is reverted so the defect is present for this measurement
        close_settled_tab(run_dir, resource)
'''

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
if text.count(fixed) != 1:
    raise SystemExit(f"expected exactly one copy of the close block in {path}, found {text.count(fixed)}")
path.write_text(text.replace(fixed, mutated), encoding="utf-8")
PY
}

verify_fixed() {
	python3 - "$core" <<'PY'
import sys
from pathlib import Path

fixed = '''    try:
        close_settled_tab(run_dir, resource)
    except DelegateError as error:
        post_settlement_failures.append(str(error))
'''
path = Path(sys.argv[1])
if path.read_text(encoding="utf-8").count(fixed) != 1:
    raise SystemExit(f"{path} does not hold the fixed close block; the mutation pair would prove nothing")
PY
}

run_case() {
	node --experimental-strip-types --test "$lifecycle_test" >"$1" 2>&1
}

# The run id of a measurement, read from the driver's own `finished` line rather than guessed from the
# evidence, so the tab inventory below is tied to the run that produced it.
run_id_of() {
	python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path

for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if stripped.startswith('{"finished"'):
        print(json.loads(stripped)["finished"]["runId"])
        break
else:
    raise SystemExit(f"no finished line in {sys.argv[1]}; the measurement did not complete")
PY
}

# The visible half of the finding: a settled worker's tab is listed until something closes it. These ask
# the real CLI, so the proof does not rest on the absence audit's own report of itself.
tabs_of_run() {
	python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

tabs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["result"]["tabs"]
run_id = sys.argv[2]
print("\n".join(tab["tab_id"] for tab in tabs if run_id in tab.get("label", "")))
PY
}

close_tabs() {
	for tab in $1; do
		herdr tab close "$tab" >/dev/null
		echo "      closed leftover tab $tab"
	done
}

if [ "$mode" = "--check" ]; then
	verify_fixed
	mutate
	if run_case "$restore_point/mutated.log"; then
		echo "FAIL: the Herdr case passed with the close reverted, so it does not pin the fix" >&2
		exit 1
	fi
	grep -q '^# fail 1$' "$restore_point/mutated.log" || { echo "FAIL: expected exactly one failing case" >&2; exit 1; }
	restore
	run_case "$restore_point/fixed.log"
	grep -q '^# fail 0$' "$restore_point/fixed.log" || { echo "FAIL: the case does not pass with the fix restored" >&2; exit 1; }
	echo "PASS: the automated case fails with the close reverted and passes with it restored"
	echo "      mutated: $(grep -c '^# pass' "$restore_point/mutated.log") log lines, $(grep '^# fail' "$restore_point/mutated.log")"
	echo "      fixed:   $(grep '^# pass' "$restore_point/fixed.log") log lines, $(grep '^# fail' "$restore_point/fixed.log")"
	exit 0
fi

for variable in HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID; do
	if [ -z "$(printenv "$variable" || true)" ]; then
		echo "refusing to start: $variable is not set, and a Herdr measurement needs the workspace identity it runs in" >&2
		exit 1
	fi
done
command -v herdr >/dev/null 2>&1 || { echo "refusing to start: herdr is not on PATH" >&2; exit 1; }

verify_fixed
date_stamp=$(date '+%Y-%m-%d')
phase_runs=$(mktemp -d "${TMPDIR:-/tmp}/us-007-runs.XXXXXX")

measure() {
	phase=$1
	measured_evidence="$package_dir/agent-output/runtime-measure-${date_stamp}-herdr-${phase}"
	run_root="$phase_runs/${phase}"
	mkdir -p "$run_root" "$measured_evidence"
	echo "--- phase ${phase}: measuring into ${measured_evidence}"
	node --experimental-strip-types "$driver" --graph research --execute --repeats 1 \
		--transport herdr --model "$model" --evidence-dir "$measured_evidence" \
		--run-root "$run_root" --keep-run-root 2>&1 | tee "$run_root/driver.log"
	[ -f "$measured_evidence/summary.json" ] || { echo "FAIL: phase ${phase} wrote no summary; see $run_root/driver.log" >&2; exit 1; }
	measured_run_id=$(run_id_of "$run_root/driver.log")
	herdr tab list > "$run_root/tabs-after.json"
	measured_tabs=$(tabs_of_run "$run_root/tabs-after.json" "$measured_run_id")
	# The retained records are the run's own evidence home, which the run root holds and the driver keeps
	# only with --keep-run-root; copying them beside the summary is what makes the proof readable later.
	for run_directory in "$run_root"/pi-wave-measure-runtime-v1-*; do
		[ -d "$run_directory" ] || continue
		for name in evidence failures; do
			[ -d "$run_directory/$name" ] || continue
			mkdir -p "$measured_evidence/retained-$name"
			cp -R "$run_directory/$name/." "$measured_evidence/retained-$name/"
		done
	done
}

# The defect phase runs with the close reverted; the restore below happens before the fixed phase starts,
# and the trap still covers an interrupt inside the defect run itself.
mutate
measure defect
defect_evidence=$measured_evidence
defect_run_id=$measured_run_id
defect_tabs=$measured_tabs
restore
measure fixed
fixed_evidence=$measured_evidence
fixed_run_id=$measured_run_id
fixed_tabs=$measured_tabs

# The tab inventory is the finding made visible: the defect phase must leave its workers' tabs listed and
# the fixed phase must leave none. Both are asserted through the real CLI, and the defect phase's
# leftovers are closed afterwards so this proof does not litter the workspace that ran it.
left_open=$(printf '%s' "$defect_tabs" | tr '\n' ' ')
echo "--- tabs still open after the defect phase: ${left_open:-none}"
if [ -z "$defect_tabs" ]; then
	echo "FAIL: the defect phase left no tab open, so it did not reproduce the finding" >&2
	exit 1
fi
close_tabs "$defect_tabs"
herdr tab list > "$phase_runs/tabs-after-close.json"
remaining=$(tabs_of_run "$phase_runs/tabs-after-close.json" "$defect_run_id")
if [ -n "$remaining" ]; then
	echo "FAIL: closing the defect phase's tabs left $remaining" >&2
	exit 1
fi
left_open=$(printf '%s' "$fixed_tabs" | tr '\n' ' ')
echo "--- tabs still open after the fixed phase: ${left_open:-none}"
if [ -n "$fixed_tabs" ]; then
	echo "FAIL: the fixed phase left tabs open: $left_open" >&2
	close_tabs "$fixed_tabs"
	exit 1
fi
rm -rf "$phase_runs"

python3 - "$defect_evidence" "$fixed_evidence" <<'PY'
import json
import sys
from pathlib import Path

def read(evidence):
    summary = json.loads((Path(evidence) / "summary.json").read_text(encoding="utf-8"))
    run = summary["runs"][0]
    settlements = len(list(Path(evidence).glob("retained-evidence/*/runtime-settlement-*.json")))
    cleanups = len(list(Path(evidence).glob("retained-evidence/*/cleanup-*.json")))
    return {
        "terminal": run["terminal"],
        "status": run["finalStatus"],
        "settlements": settlements,
        "cleanups": cleanups,
        "postSettlementFailures": run["postSettlementFailures"],
    }

defect = read(sys.argv[1])
fixed = read(sys.argv[2])
print(f"defect phase: terminal={defect['terminal']} status={defect['status']} settlements={defect['settlements']} "
      f"cleanups={defect['cleanups']} postSettlementFailures={len(defect['postSettlementFailures'])}")
if defect["postSettlementFailures"]:
    print(f"  first: {defect['postSettlementFailures'][0].splitlines()[0]}")
print(f"fixed phase:  terminal={fixed['terminal']} status={fixed['status']} settlements={fixed['settlements']} "
      f"cleanups={fixed['cleanups']} postSettlementFailures={len(fixed['postSettlementFailures'])}")

failures = []
if not defect["postSettlementFailures"]:
    failures.append("the defect phase reported no post-settlement failure, so the driver's recording is unproven")
if defect["cleanups"]:
    failures.append(f"the defect phase retained {defect['cleanups']} cleanup records while the tab was left open")
if defect["settlements"] == 0:
    failures.append("the defect phase settled nothing, so it proves nothing")
if fixed["postSettlementFailures"]:
    failures.append(f"the fixed phase still reported {len(fixed['postSettlementFailures'])} post-settlement failures")
if fixed["cleanups"] != fixed["settlements"] or fixed["settlements"] == 0:
    failures.append(f"the fixed phase retained {fixed['cleanups']} cleanup records for {fixed['settlements']} settlements")
if not fixed["terminal"]:
    failures.append("the fixed phase did not reach a terminal state")

for line in failures:
    print(f"FAIL: {line}")
sys.exit(1 if failures else 0)
PY

echo "PASS: US-007 is proven in both directions; evidence in"
echo "      ${defect_evidence#$repo_dir/}"
echo "      ${fixed_evidence#$repo_dir/}"