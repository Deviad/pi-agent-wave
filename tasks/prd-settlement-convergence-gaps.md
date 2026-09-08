# Settlement convergence gaps: unownable operations and unproven process teardown

**Status:** Planned. This issue records two defects found while verifying `tasks/prd-package-delegate-graph.md` (teardown-convergence slice, commit `100dfec`) and proposes how to prove each one. **No implementation is authorized by this file.** Acceptance criteria below name the proof that must exist before any of this is called done.

Attempts: 0.

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

`extensions/pi-agent-wave/store.ts` and `index.ts` currently carry uncommitted work from the Air-controlled orchestration slice: `resolveExhaustion()` was widened to accept `blocked` state runs and now rejects operations that belong to a different run or are stale for the current graph state, and dispatch gained `--access-mode`. That work touches the same code path as the first user story. Re-read it first and state, in this file, whether it already opens the abandon route; if it does, this issue shrinks to a test-and-document job instead of a new mechanism.

## User story 1 — an operation that never got a worker can be settled

As the person operating `/delegate` runs, I want an operation whose worker never started to reach a terminal state, so a run does not sit active forever and so the retry machinery cannot pick it up as a transient failure.

Acceptance criteria:

- [ ] A single new settlement route handles "no worker was ever registered" for headless and Herdr alike, keeps the frozen model policy intact, and writes a diagnostic that says the authorized command never started. Acceptance is judged by a test that reaches that route through the `delegate_graph` tool contract (`op=collect` for a never-dispatched operation, plus `op=cancel`), not by calling an internal function, and by a check that a second call to the same route is a no-op rather than an error.
- [ ] A run containing such an operation reports a non-active status afterwards, proven by a query against a temporary database asserting the operation is settled with `finished_at` set. No test may write to `~/.cache/delegate-graph/delegate-graph.db`; every rehearsal uses a temporary `PI_CODING_AGENT_DIR` and a temporary database.
- [ ] `retry.ts` keeps a never-started command out of the transient classes: a test asserts it does not consume the same-model budget and does not advance to the next model of the frozen chain, while the existing 429, 5xx, quota, timeout, connection-reset and credential-link-change cases stay transient.

## User story 2 — teardown is proven against a process that is really running

As a reviewer, I want cleanup's process-survivor branch exercised by a live process, so that a claim about fail-closed teardown means something.

Acceptance criteria:

- [ ] `extensions/pi-agent-wave/test/support/acpx-cleanup-driver.py` gains a mode that starts a real long-lived child process whose command line matches the owned-process probe pattern, and the driver terminates it on every exit path, including failure and timeout.
- [ ] `extensions/pi-agent-wave/test/acpx-cleanup.test.ts` gains a case that asserts cleanup fails closed while that process is alive (no `cleanup-*.json` written, session not reported closed), and a second phase that kills the process, re-runs cleanup, and asserts convergence with real absence evidence. Both phases use a per-run unique session token; a run must not depend on the absence of unrelated host processes.
- [ ] The new case is verified to bind: removing the process-survivor check from `cleanup_absence_inventory()` makes it fail. The mutation, its output, and the revert are recorded here, following the pattern already used in the teardown-convergence slice.

## Non-goals

- No change to graph topology, evidence gates, retry counts or model-policy resolution beyond what user story 1 requires.
- No weakening of the fail-closed branch to make a teardown test pass, and no test that fakes the system it could just run (the real `acpx` and `agentfs` binaries are reachable here).
- No change to the parallel-run disclosure in `tasks/prd-package-delegate-graph.md`: the canonical gate stays `--test-concurrency=1`, and the production-audit assertion that counts live AgentFS processes stays intact.
- No live installation, no commit or push, no package publication, and no resumption of the job-hunter US-003 retries from this issue.
