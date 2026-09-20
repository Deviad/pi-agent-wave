# Orphaned wait convergence: a torn-down Herdr attempt must be collectable and cancellable

**Status:** In progress, branch `issue-orphaned-wait-convergence`. Attempts: 1.

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

- [ ] In the `acpx-agentfs` poll loop, when `using_herdr()`, each tick also fails closed if `attempt_dir` no longer exists (`DelegateError("Herdr worker attempt directory removed before result: …")`), and every `HERDR_LIVENESS_INTERVAL_S` (default 5 s) runs `herdr agent get <agent>`; a response whose `error.code` is `agent_not_found` raises `DelegateError("Herdr worker no longer registered before result: …")`. Proof: `test/herdr-worker-liveness.test.ts` drives the production function via `runpy` with a fake `run` and a temporary `attempt_dir`; case A removes the directory after two ticks and asserts the raise within 2 s with `WAIT_TIMEOUT_MS` set to 60 000; case B returns `agent_not_found` and asserts the same bound; case C (headless, `ACTIVE_TRANSPORT = "headless"`) asserts `herdr agent get` is never called.
- [ ] `WAIT_TIMEOUT_MS` unchanged; a live worker that eventually writes `worker-result.json` still settles (existing `approval-block-driver.py` cases unchanged and green).

## User story 2 — retained teardown evidence settles the store without a new wait

As the supervisor, I want `op=collect` on an attempt whose launcher already tore itself down to settle the attempt as `failed` from the retained diagnostics, so the store converges with the disk instead of re-waiting.

Acceptance criteria:

- [ ] `collectRuntimeAttempt` checks, before spawning `wait`, whether `failure-<operationId>.json` exists in the private run directory (via the existing `retainedFailureDiagnostics` scan narrowed to that operation) **and** the agent's attempt directory recorded in `state.json` is absent; when both hold it calls `graphStore.settleRuntimeAttempt({ kind: "failed", exitCode: null, error: "<reason from the bundle>\nretained worker diagnostics: <path>" })`, emits `runtime_attempt_failed`, and returns the same shape the post-wait failure branch returns. Proof: `test/runtime-settle.test.ts` gains "collect settles from retained teardown evidence without waiting": builds a temporary `PI_CODING_AGENT_DIR` database with a registered attempt, writes `state.json` + `failure-<op>.json` and no attempt dir, calls the `delegate_graph` tool `op=collect`, asserts `attempt.outcome.kind === "failed"`, `op=next`-visible status is no longer `running`, and that `scripts/delegate.ts` was never spawned (executor stub records calls).
- [ ] A second `op=collect` on the same operation is a no-op returning the settled attempt (no error). Proof: same test, second call.
- [ ] `op=retry` after that settlement is accepted (`store.ts:1444` guard satisfied). Proof: same test, third call.

## User story 3 — cancel converges after teardown

As the supervisor, I want `op=cancel` on an attempt whose `acpx_cancel_script` no longer exists to treat the attempt as already torn down, so a run can always be closed.

Acceptance criteria:

- [ ] `cancelRegisteredAttempt` gains a first branch: if `acpx_cancel_script` is a non-empty string but the file does not exist, it returns without executing anything (teardown already converged); the existing "script exists but fails" path stays an error. Proof: `test/acpx-focus-cancellation.test.ts` gains "cancel converges when the launcher is already gone" asserting `cancelRegisteredAgent` resolves and the executor was not called, plus "cancel still fails when the launcher exists and exits non-zero" pinning the unchanged path.
- [ ] `op=cancel` on such an attempt records `cancelled` and the run leaves `active`. Proof: `test/runtime-settle.test.ts` gains the tool-level case against the same temporary database as story 2.

## Verification gate

`node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` from the repository root (per `AGENTS.md`); `npm run check` if present. The mutation checks named in each story are recorded under "What was built" when done.

## What was built

(filled in as stories land)
