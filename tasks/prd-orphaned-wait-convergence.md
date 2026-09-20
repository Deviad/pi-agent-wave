# Orphaned wait convergence: a torn-down Herdr attempt must be collectable and cancellable

**Status:** Implemented (2026-09-20), branch `issue-orphaned-wait-convergence`, merged as `5002631`; story 4 below repairs a regression that merge shipped, on branch `issue-liveness-probe-target`. Attempts: 2. Every acceptance criterion below names the proof that was run.

## Problem

Observed 2026-09-20 on `run_315dce09-27d2-4bb3-a966-2b7a4d9f5413` (story `issue-2-topics-context`, node `thinker_plan`, Herdr transport), reconstructed from the private run directory `/private/tmp/delegate-graph-herdr-run-315dce09-…5vrorhwh/`:

1. 07:05 `op=dispatch` registered the attempt and created Herdr tab `wR:t2`.
2. 07:05 `op=collect` spawned `scripts/delegate.ts … wait` → `settle_runtime_attempt` → `wait_for_settled_agent`, which polls for `worker-result.json` up to `WAIT_TIMEOUT_MS` (3 600 000 ms, `delegate_core.py:33`). The supervisor's tool call was interrupted; the child kept polling.
3. 08:05 the orphaned child timed out, `settle_runtime_attempt` (`delegate_core.py:1678`) ran `abort_acpx_attempt`: wrote `failure-op_….json` (`"reason": "attempt aborted before cleanup"`), released and closed the tab (`state.json` `closed_tabs: ["wR:t2"]`), removed `attempt_dir` and with it `cancel-acpx.sh`. Nobody consumed the exit, so `graphStore.settleRuntimeAttempt` never ran: disk says aborted, the store says `running`.
4. Afterwards every route is blocked:
   - `op=collect` → `registered.outcome` null, no `runtime-settlement-*.json` → re-runs `wait`, which polls a file that cannot appear for another hour (rehearsed with a 20 s cap: exit 124, no output).
   - `op=retry` → `store.ts:1444` "runtime attempt is still running; collect it before retrying".
   - `op=cancel` → `herdr.ts:67-70` executes the deleted `acpx_cancel_script` → exit 127 → "failed to cancel ACPX attempt"; `index.ts:945` rethrows because `acpx_state !== "no-session"`.

Three defects, each with a story below:

- **D1** `wait_for_settled_agent` under Herdr never checks whether the worker still exists (the liveness branch at `delegate_core.py:1092` is `not using_herdr()` only). `herdr agent get <name>` already answers `agent_not_found` and `attempt_dir` is already gone; both are ignored until the hour elapses.
- **D2** `abort_acpx_attempt` records teardown durably on disk, but `collectRuntimeAttempt` (`index.ts:559-575`) only reads `retainedFailureDiagnostics()` *after* a fresh wait fails. A run directory that already carries `failure-<operationId>.json` and no attempt directory is terminal evidence and must settle the store without waiting.
- **D3** `cancelRegisteredAttempt` (`herdr.ts:67-80`) requires the launcher script to exist and to print a structured cancel record. `abort_acpx_attempt` already states the rule at `delegate_core.py:1497`: "a repeat cleanup after a completed teardown must converge instead of reporting an absent launcher". The TypeScript cancel path does not apply it.

## Non-goals

- Changing `WAIT_TIMEOUT_MS` or making `op=collect` non-blocking (worth its own PRD; noted as the enabling condition for step 2 above).
- Touching headless transport liveness (already checks `worker_pid`).
- Recovering `run_315dce09` by hand-editing the database; once D3 lands, `op=cancel` is the recovery.

## User story 1 — a wait notices a torn-down Herdr worker immediately

As the supervisor collecting a Herdr attempt, I want `wait_for_settled_agent` to fail as soon as the worker is gone, so a dead worker costs seconds, not an hour per collect.

Acceptance criteria:

- [x] In the `acpx-agentfs` poll loop, when `using_herdr()`, each tick also fails closed if `attempt_dir` no longer exists (`DelegateError("Herdr worker attempt directory removed before result: …")`), and every `HERDR_LIVENESS_INTERVAL_S` (default 5 s) runs `herdr agent get <agent>`; a response whose `error.code` is `agent_not_found` raises `DelegateError("Herdr worker no longer registered before result: …")`. Proof: `test/herdr-worker-liveness.test.ts` drives the production function via `runpy` with a fake `run` and a temporary `attempt_dir`; case A removes the directory after two ticks and asserts the raise within 2 s with `WAIT_TIMEOUT_MS` set to 60 000; case B returns `agent_not_found` and asserts the same bound; case C (headless, `ACTIVE_TRANSPORT = "headless"`) asserts `herdr agent get` is never called.
- [x] `WAIT_TIMEOUT_MS` unchanged; a live worker that eventually writes `worker-result.json` still settles (existing `approval-block-driver.py` cases unchanged and green).

## User story 2 — retained teardown evidence settles the store without a new wait

As the supervisor, I want `op=collect` on an attempt whose launcher already tore itself down to settle the attempt as `failed` from the retained diagnostics, so the store converges with the disk instead of re-waiting.

Acceptance criteria:

- [x] `collectRuntimeAttempt` checks, before spawning `wait`, whether `failure-<operationId>.json` exists in the private run directory (via the existing `retainedFailureDiagnostics` scan narrowed to that operation) **and** the agent's attempt directory recorded in `state.json` is absent; when both hold it calls `graphStore.settleRuntimeAttempt({ kind: "failed", exitCode: null, error: "<reason from the bundle>\nretained worker diagnostics: <path>" })`, emits `runtime_attempt_failed`, and returns the same shape the post-wait failure branch returns. Proof: `test/acpx-collect-convergence.test.ts` (the existing tool-level harness that registers a real attempt in a temporary `DELEGATE_GRAPH_DB`, chosen over `runtime-settle.test.ts` because that file drives the settle script, not the tool) gains "collect settles from retained teardown evidence without waiting": writes `failure-<op>.json` with `reason: "attempt aborted before cleanup"`, removes the attempt dir, calls `op=collect`, asserts `attempt.processState === "failed"`, `reason` equals the bundle reason, `diagnosticsPath` names the bundle, and no `delegate.ts` invocation was recorded by the executor stub. The attempt-dir check is the launcher parent (`dirname(acpx_cancel_script)`) recorded in the store; `state.json` is not consulted because the store already carries that path.
- [x] A second `op=collect` on the same operation is a no-op returning the settled attempt (no error). Proof: same test, second call.
- [x] `op=retry` after that settlement is accepted (`store.ts:1444` guard satisfied). Proof: same test, third call.

## User story 3 — cancel converges after teardown

As the supervisor, I want `op=cancel` on an attempt whose `acpx_cancel_script` no longer exists to treat the attempt as already torn down, so a run can always be closed.

Acceptance criteria:

- [x] `cancelRegisteredAttempt` gains a first branch: if `acpx_cancel_script` is a non-empty string but the file does not exist, it returns without executing anything (teardown already converged); the existing "script exists but fails" path stays an error. Presence is checked on the filesystem (`existsSync`, injectable for tests), not inferred from an exit code: rehearsed `spawn` of a missing path with `shell:false` (what `pi.exec` uses) emits ENOENT and `execCommand` resolves `code: 1`, not 127. Proof: `test/acpx-focus-cancellation.test.ts` gains "cancel converges when the launcher is already gone" asserting `cancelRegisteredAgent` resolves and the executor was not called, plus "cancel still fails when the launcher exists and exits non-zero" pinning the unchanged path.
- [x] `op=cancel` on such an attempt records `cancelled` and the run leaves `active`. Proof: `test/acpx-collect-convergence.test.ts` "cancel converges on a torn-down attempt and closes the run" (`operation.status === "cancelled"`, `state.status === "cancelled"`).

## User story 4 — the liveness probe must ask a question Herdr can answer

As the supervisor, I want the Herdr liveness probe to target the worker's pane, so a healthy worker is not torn down five seconds after dispatch.

Story 1 shipped `herdr agent get <agent_name>`. That query never resolves: captured 2026-09-20 against a running Herdr,

```
herdr agent get wR:p3                        -> result.agent = {agent: "dg_run-e5b0_thinker_8d06cc93", agent_status: "working", pane_id: "wR:p3"}
herdr agent get dg_run-e5b0_thinker_8d06cc93 -> {"error":{"code":"agent_not_found"}}     # the same worker, alive
herdr agent get wR:t3                        -> {"error":{"code":"agent_not_found"}}     # tab refs do not resolve either
```

so every Herdr worker was reported missing at the first probe and aborted. Observed on `run_daaa5712` (node `thinker_plan`): dispatched 07:51:25, settled `failed` 07:51:41 with "Herdr worker no longer registered before result", empty `stderrTail`, empty `recentEvents`, `workerResult {}` — the worker never produced anything.

Why story 1's tests passed anyway: every case fed a fake `run` whose answer was written to match the branch under test, and no case asserted *which target* the probe passes. The rule this broke is the one in `AGENTS.md` about proving against the real thing when it is installed and runnable: `herdr` was running the whole time and one command would have shown it.

Acceptance criteria:

- [x] `herdr_agent_registered` takes the pane id and queries `herdr agent get <pane>`; the caller passes `resource["pane"]` and skips the probe when no pane is recorded. An unreadable answer still keeps the wait going, and the reported agent name is deliberately not compared, because Herdr's own screen detection may relabel a live pane. Proof: `test/herdr-worker-liveness.test.ts` case 2 asserts the exact argv `["herdr","agent","get","wZ:p9"]`, and new case 5 ("a live pane keeps the wait going even though the agent name would not resolve") feeds the real pair of shapes above and asserts no teardown.
- [x] Mutation bind: restoring `herdr_agent_registered(agent_name)` fails cases 2 and 5 (`# pass 3 # fail 2`); reverted.
- [x] Whole suite green after the fix: 546 tests, 535 pass, 0 fail, 11 skipped; `npx tsc -p tsconfig.json` exit 0.
- [ ] Proven against the live run: `op=retry` on `run_daaa5712` `op_0e4981c3` produces a worker that survives past the probe interval and returns an answer. (Checked off once observed.)

## Verification gate

`node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` from the repository root (per `AGENTS.md`); `npm run check` if present. The mutation checks named in each story are recorded under "What was built" when done.

## What was built

- `scripts/delegate_core.py`: `HERDR_LIVENESS_INTERVAL_S` (env `PI_DELEGATE_HERDR_LIVENESS_INTERVAL_S`, default 5), `herdr_agent_registered()`, and the Herdr branch in `wait_for_settled_agent` (attempt-dir check every tick, `herdr agent get` on the interval; a malformed probe answer keeps waiting).
- `index.ts`: `retainedTeardown()` and the pre-wait settlement in `collectRuntimeAttempt`; progress event `runtime_attempt_failed` carries `via: "retained-teardown"`.
- `herdr.ts`: `cancelRegisteredAttempt` / `cancelRegisteredAgent` / `focusRegisteredAgent` take an injectable `launcherExists` (default `existsSync`); existing focus tests inject `() => true` because their fixture launcher `/tmp/cancel-worker.sh` never existed on disk.
- Tests: `test/herdr-worker-liveness.test.ts` (4 cases), `test/acpx-focus-cancellation.test.ts` (+3), `test/acpx-collect-convergence.test.ts` (+3), `test/acpx-herdr-presentation.test.ts` (fixture injection only).
- Docs: `extensions/pi-agent-wave/README.md` env table + settlement paragraph; `CHANGELOG.md` Unreleased.

Evidence (2026-09-20):

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` from the repository root: 545 tests, 534 pass, 0 fail, 11 skipped (pre-existing opt-in live matrix).
- `npx tsc -p tsconfig.json` in `extensions/pi-agent-wave`: exit 0.
- Mutation, story 1: replacing `if using_herdr():` in the poll loop with `if False:` fails liveness cases 1-3 (case 4, headless, still passes as it must); reverted.
- Mutation, story 2: replacing the `retainedTeardown(...)` call with `undefined` fails "collect settles from retained teardown evidence without waiting" (the two sibling cases still pass); reverted.
- Mutation, story 3: replacing `if (!launcherExists(...)) return;` with `if (false) return;` fails "cancel converges when the launcher is already gone", "production default consults the filesystem for the launcher", and the tool-level "cancel converges on a torn-down attempt"; reverted.
- Field recovery not yet exercised: the wedged `run_315dce09` still sits in the operator database; `op=cancel` against it is the first real-world proof once this extension build is loaded into a Pi session.
