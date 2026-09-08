# Settlement convergence gaps: unownable operations and unproven process teardown

**Status:** Implemented (2026-09-08), on branch `issue-settlement-convergence-gaps`. Both user stories are built and verified; each acceptance criterion below names the proof that was run.

Attempts: 1.

## Why these two and not others

Both came out of the same class of problem: a worker attempt that ends without ever becoming a worker. The teardown-convergence slice fixed the *reporting* half (cleanup now converges and writes absence evidence). What is left is (a) a coverage hole that let the old behaviour ship, and (b) a state-machine hole that leaves a permanently unsettled operation in the live database.

## Evidence already collected

**Unownable operation.** A run initialised with `delegate_graph(op="init", story="teardown-convergence-review", graph="research")` and never dispatched left operation `op_f5244b24-7bff-4431-a614-c4e6c15e2a88` in `run_9c42df43-a2de-4e93-b632-31fdaa07fdeb` with no registered worker. Every supported exit was tried and each refused:

- `op=cancel` → `has no registered worker`
- `op=resolve` with `decision=abort` → `run is not awaiting a recovery decision`
- `op=collect` → `has no collectable worker`

The same shape was observed in the field on the job-hunter side: an operation with `status=running`, `classifier_reason=provider-link-churn`, `transient_attempts=1`, `finished_at=null`, whose worker record was already `status=failed` with `acpx_state=alive`. A run in that state is neither retryable nor closeable, and it is counted as active by anything that reads the database.

**Unproven process teardown.** `cleanup_absence_inventory()` counts owned processes by matching command-line substrings, but no test ever gave it a live process to find. Every current case is fed injected `ps` output, including the four cases added in the teardown-convergence slice (`repeat-teardown`, `partial-teardown`, `survivor`, `closure`). `agent-output/teardown-convergence/reviewer-raw.log` carries the same finding from the independent review.

A consequence worth naming: the fixed fixture session token used during development (`dg-audit-probe`) collided with an unrelated host process whose command line contained that string, which made early teardown results wrong in a way that looked like a product failure. A real-process test must use a per-run unique token for the same reason.

## Check before building anything

**Answer, recorded before building:** it does not, so the mechanism stayed in scope. The Air work widened `resolveExhaustion()` to accept a `blocked` run, but the *operation* still has to be `blocked` or `failed`, and an operation that never got a worker is `pending` inside an `active` run — so recovery still refused it, and `op=collect` / `op=cancel` refused it before reaching the store.

`extensions/pi-agent-wave/test/unlaunched-settlement.test.ts` was written first, against the merged code, and reproduced the field shape exactly: four of its five cases failed with `operation … has no collectable worker` (collect, the repeated collect, the no-presentation-adapter case) and `running operation … has no registered worker` (cancel). Only after that was the settlement route added.

## User story 1 — an operation that never got a worker can be settled

As the person operating `/delegate` runs, I want an operation whose worker never started to reach a terminal state, so a run does not sit active forever and so the retry machinery cannot pick it up as a transient failure.

Acceptance criteria:

- [x] A single new settlement route handles "no worker was ever registered" for headless and Herdr alike, keeps the frozen model policy intact, and writes a diagnostic that says the authorized command never started. Acceptance is judged by a test that reaches that route through the `delegate_graph` tool contract (`op=collect` for a never-dispatched operation, plus `op=cancel`), not by calling an internal function, and by a check that a second call to the same route is a no-op rather than an error.
- [x] A run containing such an operation reports a non-active status afterwards, proven by a query against a temporary database asserting the operation is settled with `finished_at` set. No test may write to `~/.cache/delegate-graph/delegate-graph.db`; every rehearsal uses a temporary `PI_CODING_AGENT_DIR` and a temporary database.
- [x] `retry.ts` keeps a never-started command out of the transient classes: a test asserts it does not consume the same-model budget and does not advance to the next model of the frozen chain, while the existing 429, 5xx, quota, timeout, connection-reset and credential-link-change cases stay transient.

## User story 2 — teardown is proven against a process that is really running

As a reviewer, I want cleanup's process-survivor branch exercised by a live process, so that a claim about fail-closed teardown means something.

Acceptance criteria:

- [x] `extensions/pi-agent-wave/test/support/acpx-cleanup-driver.py` gains a mode that starts a real long-lived child process whose command line matches the owned-process probe pattern, and the driver terminates it on every exit path, including failure and timeout.
- [x] `extensions/pi-agent-wave/test/acpx-cleanup.test.ts` gains a case that asserts cleanup fails closed while that process is alive (no `cleanup-*.json` written, session not reported closed), and a second phase that kills the process, re-runs cleanup, and asserts convergence with real absence evidence. Both phases use a per-run unique session token; a run must not depend on the absence of unrelated host processes.
- [x] The new case is verified to bind: removing the process-survivor check from `cleanup_absence_inventory()` makes it fail. The mutation, its output, and the revert are recorded here, following the pattern already used in the teardown-convergence slice.

## What was built

**User story 1 — settlement for an operation whose worker never registered.**

- `index.ts` gained `settleUnlaunchedOperation()`, one route used by both `op=collect` (records `failed`) and `op=cancel` (records `cancelled`). It fires only when the operation has no bound agent at all, so a registered worker keeps its existing collect and cancel behaviour, including the refusal to cancel an `alive` worker whose launcher fails.
- A call against an already settled operation returns `settled: false` with the reason `operation already <status>` instead of an error, so a repeated `op=collect` or `op=cancel` is a no-op.
- Each settlement retains `failure-<operationId>.json` in `failures/<runId>/` beside the graph database, mode 600, through the new `GraphStore.retainRunDiagnostic()`. That location exists without a dispatch, follows `DELEGATE_GRAPH_DB` into temporary databases, and the recorded `last_error` names the file — the same convention as a worker diagnostic.
- `retry.ts` gained a `worker-never-launched` permanent reason, checked *after* the transient scan, so a launch failure whose text carries real transport signals (connection reset, timeout) still falls back across the frozen chain.
- Two extra cases assert the loop closes: after `op=collect` settles, `op=resolve` with `decision: "retry"` reopens the operation as `pending` with the run `active`, and `decision: "abort"` ends the run.

**User story 2 — teardown proof against a real process.**

- The driver's new `live` mode starts `python3 -c 'import time; time.sleep(600)' <token>` — a real child whose command line carries a per-run token `dg-live-<uuid>`, which is the substring the owned-process probe matches — runs the real `scripts/headless_delegate.py cleanup` against it, kills the child, waits for it, confirms `ps` no longer reports it, and runs cleanup again. `child.kill()` and `wait` sit in `finally`, so the child is terminated on every exit path.
- The driver also returns how many real `ps` lines matched before cleanup ran, and the test requires at least one: a probe that cannot see the process fails the case instead of passing it vacuously.

**Corrected while here.** The "cleanup is idempotent for an owned empty run" case resolved `herdr_delegate.py` through `process.cwd()`, so it only worked when the suite was started from the repository root; started from `extensions/pi-agent-wave` it failed with "can't open file". It now resolves the script from `import.meta.url`, which is what that file's own header comment already claimed.

## Verification

- **Mutation check for user story 2.** The `owned_processes` comprehension in `cleanup_absence_inventory()` was replaced with an always-empty list and the cleanup suite re-run. The new case failed with "a live owned process must never produce absence evidence", and the three injected-`ps` inventory cases (`queue-owner`, `agentfs-server`, `report-repair-child`) failed with it, so the mutation was real and the new case binds to the survivor branch rather than to injected text. `delegate_core.py` was restored with `git checkout`, verified byte-identical to the pre-mutation copy held at `/tmp/delegate_core.pristine.py`, and the suite returned to 31/31. Raw output: `agent-output/settlement-convergence/mutation-process-survivor.log`.
- **Real-process behaviour observed.** With the child alive, cleanup exited 1, wrote no `cleanup-*.json`, and reported `cleanup absence audit failed: ownedProcessesAbsent; sessionClosed`. After the kill it exited 0, wrote the evidence file, and reported `sessionClosureEvidence: files-and-processes-absent`. The probe saw the process before phase one and nothing after the kill.
- **Gates.** Full serial Node suite: 446 tests, 435 pass, 0 fail, 11 skipped. Bun package gates: 45 pass, 0 fail. `npm run typecheck` clean, `git diff --check` clean, installation rehearsal 1 pass (no worker dispatched). The cleanup and unlaunched-settlement files were also run from `extensions/pi-agent-wave` to confirm they no longer depend on the starting directory.
- **Containment.** Nothing here touches the live graph database: the settlement tests point `DELEGATE_GRAPH_DB` at a temporary file, and the teardown driver works inside temporary run directories.

## Non-goals

- No change to graph topology, evidence gates, retry counts or model-policy resolution beyond what user story 1 requires.
- No weakening of the fail-closed branch to make a teardown test pass, and no test that fakes the system it could just run (the real `acpx` and `agentfs` binaries are reachable here).
- No change to the parallel-run disclosure in `tasks/prd-package-delegate-graph.md`: the canonical gate stays `--test-concurrency=1`, and the production-audit assertion that counts live AgentFS processes stays intact.
- No package publication and no resumption of the job-hunter US-003 retries from this issue. The live installation check and the commits that carry this work were authorized separately.
