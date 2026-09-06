# PRD: Worker route resilience and honest settlement

**Status:** Open. Scope record for the `issue-worker-route-resilience` branch; linked from `tasks/prd-package-delegate-graph.md` as a feature acceptance record.

**Baseline:** `origin/main` `d2a9967`. Test state before this work: 373 tests, 360 pass, **2 fail**, 11 skipped (`node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`). The two failures were `acpx-real-report-evidence.test.ts` and the `production-audit.test.ts` passing-bundle case; both were host-bound stale-evidence assertions. They are resolved in section 6, and the suite is now **391 tests, 380 pass, 0 fail, 11 skipped**.

## 1. What broke in the field

Observed on 2026-09-06 while using `delegate_graph` to implement `~/projects/job-hunter-public/tasks/prd-linkedin-research-safety.md` (Pi `0.84.1`, ACPX `0.13.2`, AgentFS `0.6.4`, Herdr workspace `wK`). All four findings were reproduced before any code change; run identifiers are given so the behaviour can be re-traced.

1. **A dead chain head is never failed over.** `op=init` for `run_891a299e-57bc-447f-a416-7ca569f5e2e1` froze the thinker route as `chain = [z.ai-sub/glm-5.2, openai-codex/gpt-6-astra, alibaba/qwen3.8-max, claude-code/claude-opus-5]`. `op=dispatch` launched `chain[0]`; the worker's model call returned `429: {"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}` (verified directly with `pi -p --model z.ai-sub/glm-5.2`). `op=record status=failed` re-scheduled the *same* model three times (`classifier_reason: http-429`, `retry.modelAttempt: 0` every time) and then parked the run in `awaiting_user`. Root cause: `selectModelFallback()` in `retry.ts` has no production caller, and `index.ts` `op=dispatch` always computes `selectedModel = operation.route.chain[operation.model_attempt]` with no way to advance `model_attempt`. This contradicts the shipped claim that "delegated workers can recover from HTTP 429 limits using another configured provider in the same tier" (root `README.md`).
2. **A terminated attempt cannot be settled or cancelled, so the run is wedged permanently.** After re-initialising with live routes (`run_7982d82a-59c9-4882-ab6d-cf2726f607fe`), the dispatched Codex worker exited 1 with terminal `failed`. `op=collect` threw `ACPX worker failed: exit=1 terminal=failed`; `op=cancel` threw `failed to cancel ACPX attempt ...`; `op=resolve` threw `run is not awaiting a recovery decision`; `op=next` still reported the operation `running` with a dead worker. In an earlier attempt the same wedge appeared through a different path: `op=collect` threw `provider credential target changed: ~/.pi/agent/auth.json` (the live auth file was rewritten by a concurrent headless `pi` probe) while the ACPX session was already closed. There is no supported transition out of `running` once the worker process is gone: the operation can only be freed by recording `failed` repeatedly until the transient budget is spent, and the run cannot be resumed for a different route.
3. **Failure diagnostics are destroyed, so the cause is unobservable.** `op=collect` deletes the attempt directory even when the attempt failed. After the Codex failure, `worker-result.json`, `worker.stderr.txt` and `worker.stdout.ndjson` were all gone, leaving `ACPX worker failed: exit=1 terminal=failed` as the only surviving evidence. The cause had to be re-derived with a separate manual ACPX probe (`acpx --cwd <fresh> codex sessions new` then a prompt → `RUNTIME QUEUE_RUNTIME_PROMPT_FAILED Internal error`, i.e. the Codex ACP agent itself is not answering on this host).
4. **An execution-only projection satisfies semantic gates with zero semantic content.** When a Pi worker exits 0 without writing its report, `scripts/acpx-worker.ts` `projectPiReport()` writes `{verdict: canonicalPositiveVerdict(node), claims:["Supervisor projection: ... no semantic task claim is inferred"]}`. Both `z.ai-sub` attempts produced exactly that, the report audit accepted it, `op=collect` returned `verdict: READY`, and the graph was one `op=record status=completed` away from advancing to implementation on an empty plan. The projection is documented as explicitly making no semantic claim, so it must never be the evidence that a planning, implementation, review, test, or audit operation succeeded.

5. **A dead provider is invisible to the state machine, so nothing ever failed over.** The first real end-to-end slice of this work (`/tmp/wave-e2e-FtAO5F/trace.txt`, run `run_24ba16b0-...`, story `e2e-failover`, frozen chain `[z.ai-sub/glm-5.2, alibaba/qwen3.8-flash]`) dispatched the planning operation six times. Every attempt on the dead head exited 0 with ACPX terminal `completed`, produced the execution-only projection, and `op=collect` returned `verdict: READY` as a *successful settlement*. `model_attempt` stayed 0 for all six rounds. The US-001 failover therefore never engaged, because a 429 inside the worker's own model call is not a launch failure, not a non-zero exit, and not a failed terminal: it is indistinguishable from success unless the missing report is itself treated as the failure. The projection gate added by US-004 caught it every time (`delegate report rejected: projected execution-only report cannot complete the semantic thinker_plan operation ...`), which is the correct refusal, but a refusal at the completion gate leaves the supervisor to convert it into a failure record by hand.

## 2. Goals

- A transient worker failure moves to the next model of the operation's frozen chain, and the run keeps progressing without supervisor intervention or DB surgery.
- An attempt whose ACPX session has already terminated can be settled: `op=collect` and `op=cancel` converge to a recorded state instead of throwing forever.
- A failed attempt leaves a bounded, private, redacted diagnostic bundle that names the terminal kind and exit code.
- A projected report can never complete a semantic graph operation.

## 3. Non-goals

- No change to graph topology, joins, review/test loop caps, report schema, ledger, or the frozen-policy digest contract.
- No new transport, no revival of the retired panel route, no change to AgentFS confinement or the owned-path export audit.
- No repair of the Codex/Claude ACP agents on this host; they are external runtimes. The extension must degrade correctly when one is broken, not pretend otherwise.
- No silent regeneration or deletion of the pinned real-matrix evidence to make the gate green.

## 4. User stories and acceptance criteria

### US-001: Transient model failures advance to the next frozen chain model

**Goal.** When an attempt fails with a transient classification and the frozen chain has another model left, the next dispatch runs that model.

**Approach.** Keep the existing same-model transient budget (`test/store.test.ts` "keeps same-model retry attempts separate from cross-model fallback attempts" pins `model_attempt: 0` on the first transient failure and must stay untouched), and remove the dead end after it: in `GraphStore.record()`, the branch that currently marks the operation `failed` and parks the run in `awaiting_user` once `transient_attempts` reaches 3 first consults `selectModelFallback(route.chain, operation.model_attempt, error)` with the operation's frozen route (`policy(runId)` → role for node). When it returns `advance: true`, persist `model_attempt = decision.attempt`, `selected_model = decision.model`, `fallback_reason = decision.fallbackReason`, reset `transient_attempts` to 0, keep the operation dispatchable with `retry_not_before`, emit the existing `retry` event plus a `model_fallback` event, and return the new attempt in the result so `op=dispatch` (which already reads `chain[operation.model_attempt]`) launches the next provider. Only when the chain has no remaining model does the run park for a user decision. Exact-model locks (`chain.length === 1`, `selectionSource: "exact-model"`) never advance, which `selectModelFallback` already enforces through `exactLock`.

Acceptance criteria:

- [x] `test/model-fallback-dispatch.test.ts` seeds a run whose role chain has two models, spends the transient budget on `chain[0]` with `429` failures, and asserts the exhaustion record advances the operation to `model_attempt: 1` with `selected_model` equal to `chain[1]`, `fallback_reason` naming the transient reason, unchanged `policy_digest`, and `transient_attempts` reset to 0. Proof: that test passes.
- [x] The same test asserts a chain whose last model fails transiently still reaches `awaiting_user` with `model_attempt` unchanged. Proof: that assertion passes.
- [x] The same test asserts an exact-model lock never advances and parks the run instead. Proof: that assertion passes.
- [x] `retryReason` and `fallbackReason` stay distinguishable: same-model retries record `retry_reason` and leave `fallback_reason` null; the advance records `fallback_reason` and emits `model_fallback`. Proof: assertions in the new test plus the existing `store.test.ts` and `commands.test.ts` policy-field assertions still pass unmodified.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` reports no new failures against the 2-failure baseline. Proof: 382 tests / 369 pass / 2 fail / 11 skipped, the two failures being the pre-existing `durable real ACPX report matrix evidence` and `production host audit bundle`.

### US-002: A dead attempt settles instead of wedging the operation

**Goal.** `op=collect` and `op=cancel` always converge to a recorded state.

**Approach.** `op=collect`: when `delegate.ts wait` fails or returns no settlement, read the retained attempt result (`worker-result.json`) plus the diagnostic bundle path from US-003, decide whether the ACPX session is terminal (`terminal.kind` is `failed`/`cancelled`, or status is `no-session`), and then record the operation through `GraphStore.record({ status: "failed", error })` so US-001's failover applies, returning `{ settled: false, recorded: "failed", reason, diagnosticsPath, state }` instead of throwing. `op=cancel`: when the persisted cancel routine reports the session already absent (`no-session` acknowledgement), treat cancellation as satisfied and record `cancelled` rather than throwing `failed to cancel ACPX attempt`.

Acceptance criteria:

- [x] A collect against a registered worker whose attempt result has `terminal.kind: "failed"` records the operation failed and returns a structured result; it does not throw, and `op=next` afterwards no longer offers the dead attempt. Proof: `test/acpx-collect-convergence.test.ts`.
- [x] A cancel whose ACPX status is already `no-session` records the operation `cancelled` and moves the run out of `active`. Proof: same test file.
- [x] A collect whose settlement manifest exists still behaves exactly as today (verdict read from the report, no state transition). Proof: existing `test/air-acp-control.test.ts` and `test/acpx-settlement*.test.ts` continue to pass.
- [x] Neither path can leave an operation `running` with an agent whose `acpx_state` is not `alive`. Proof: assertion in the new test; the store rejects the transition otherwise.

### US-003: Failed attempts leave a bounded private diagnostic

**Goal.** `ACPX worker failed: exit=1 terminal=failed` becomes self-explanatory without retaining credentials or transcripts.

**Approach.** In the worker lifecycle (the `wait`/cleanup path in `scripts/delegate_core.py` with its helper under `scripts/`), when an attempt's outcome is not a completed settlement, write `<private run dir>/failure-<operationId>.json` at mode 600 containing: the full `worker-result.json` object, the exit code, the terminal kind, the last 20 parsed ACPX events trimmed to a fixed character budget, the tail of `worker.stderr.txt` under a fixed byte cap, and the attempt key plus selected model, ACPX session, and AgentFS session names. Every string passes a redaction filter for token-shaped material (`sk-ant-…`, `Bearer …`, private key blocks, `*_TOKEN=` values) before it is written, reusing the same patterns as the secret scanner. The attempt directory may still be removed; the failure bundle lives with the retained settlement/evidence files and its path is returned by `op=collect` and included in the recorded error.

Acceptance criteria:

- [x] `test/acpx-cleanup.test.ts` (new `diagnostics` case in `test/support/acpx-cleanup-driver.py`) aborts an attempt through the production `abort_acpx_attempt` entry point and asserts `failure-op-diagnostic.json` exists, is mode 600, names the terminal kind and exit code, and survives attempt-directory cleanup. Proof: that test passes.
- [x] The bundle contains no credential-shaped string: the test plants a fake `sk-ant-…` token and a `Bearer …` value on the fake worker's stderr and asserts the written bundle does not contain them. Proof: that assertion passes.
- [x] `node --experimental-strip-types scripts/production-secret-scan.ts <run dir>` reports zero findings for a directory containing a generated failure bundle. Proof: command recorded in section 6.
- [x] Successful attempts do not write a failure bundle. Closed by US-010 criterion 5: `test/acpx-cleanup.test.ts` "writes no diagnostic bundle for an attempt that already settled" asserts that aborting a resource whose attempt directory is absent produces no `failure-*.json`, which is the state a settled attempt is in — `write_failure_diagnostics()` has exactly one call site (`abort_acpx_attempt()`, `scripts/delegate_core.py`), its three `command_wait` call sites are all inside `except DelegateError` blocks, and `command_cleanup` calls it only when `attempt_dir` still exists. No live observation was captured: both attempts to copy the manifests out of the private run directories used a glob with `run_<uuid>` where the directory name is `run-<uuid>`, so nothing matched before the directories were removed. The correct form is `R=$(head -1 trace.txt | sed -E 's/^run=(run_[0-9a-f-]+) .*/\1/'); cp /private/tmp/delegate-graph-*${R/run_/run-}*/*.json <dest>/`.

### US-004: A projected report cannot complete a semantic operation

**Goal.** "No semantic task claim is inferred" can never be read by the state machine as `READY`, `DONE`, `PASS`, or `GREEN`.

**Approach.** Keep `projectPiReport()` as the execution-only signal (it is load-bearing for lifecycle matrices and is hash-bound into existing evidence), but reject it at the completion gate: in the `delegate_graph` `record`/`completed` path, after `auditReport()` succeeds, fail closed when the report carries the projection marker (`piReportProjected` in the settlement payload or the projection statement/`executionSupervisorProjection` marker in a claim) and the node is a semantic node (`thinker_plan`, `thinker_split`, `thinker_synthesize`, `implement`, `review`, `test`, `audit`, `search`). The error names the operation, the node, and the remedy (redispatch; the worker never wrote its report). `source_search` keeps its current behaviour, where the projection already fails `validateReport` because the required `execution` object is absent.

Acceptance criteria:

- [x] `test/projected-report-gate.test.ts` completes a `thinker_plan` operation with a projection-shaped report and asserts the record is rejected with a `projected-report` diagnostic, the operation is not `completed`, and the run does not advance to `implement`. Proof: that test passes.
- [x] The same test completes an `implement` operation with a real worker-written report and asserts the transition succeeds, so the gate is not a blanket block. Proof: that assertion passes.
- [x] ~~`op=collect` for a projected report surfaces `piReportProjected: true` in its result so the supervisor sees the cause before recording.~~ **Superseded by US-006**: collect no longer returns a projected settlement at all. It records the attempt failed and returns `settled: false`, `recorded: "failed"`, and `reason: worker exited without authoring its report (report-missing): the settled attempt carries only the execution-only projection`, so the cause reaches the supervisor without a recording step; `piReportProjected` and `silentTurn` remain in `worker-result.json` and in any retained failure bundle.
- [x] Existing worker-lifecycle tests (`test/acpx-worker-launch.test.ts`) still pass unmodified, because the projection itself is unchanged. Proof: suite run in section 6.

### US-005: An attempt that authored no report is a retryable failure

**Goal.** The missing report becomes the failover trigger, so a dead or silent provider moves the operation to the next frozen model automatically instead of returning a positive verdict the supervisor must refuse.

**Approach.** In `op=collect`, before returning a settled attempt, treat `settlement.piReportProjected === true` on a semantic node (`lib/projected-report.ts` `isSemanticGraphNode()`) as a failed attempt: record `status: "failed"` with the reason `worker exited without authoring its report (report-missing)`, and return `settled: false`, `recorded: "failed"`, `verdict: null`, the state, operation, and any retained diagnostic path. `classifyFailure()` gains the `report-missing` classification as transient so US-001's chain advance engages. The US-004 gate stays as the backstop for a supervisor who tries to complete the operation anyway.

Acceptance criteria:

- [x] `retry.ts` classifies the report-missing reason as transient (`worker-report-missing`), and `test/model-fallback-dispatch.test.ts` covers the exhaustion-to-next-model path for it. Proof: that test passes.
- [x] `op=collect` on a projected settlement for a semantic node records the attempt failed and reports no verdict. Proof: the decision is isolated in `projectedAttemptFailure()` and asserted in `test/projected-report-gate.test.ts` (projection flagged on `thinker_plan`/`implement`/`review`, ignored on `source_search` and on authored reports); the wiring in `op=collect` is proved by the real slice below rather than by a forged settlement manifest.
- [x] Partially met, recorded as partial: real slice on this host, no simulation. A build run with the frozen chain `[z.ai-sub/glm-5.2 (HTTP 429 insufficient balance), alibaba/qwen3.8-flash (live)]` did advance `model_attempt` 0 to 1 with `fallback_reason: worker-report-missing` after the dead head's budget was spent, and every collect converged (no throw, no wedged `running` operation), ending in `awaiting_user` when the chain was exhausted. The run did **not** settle on the live model, for a separate reason recorded as finding 6. Trace: `/tmp/wave-e2e-hVbULU/trace.txt`, run `run_de6f1cd4-875d-45d6-a669-f66837b1b39b`, operation `op_aa80f314-bba2-4c6e-b650-c1fa7372e5ab`. What is proven: US-001, US-002, and US-005 end to end against real ACPX/AgentFS/providers. What is not proven: a semantic settlement reached on the live model.

6. **A Pi-route worker under AgentFS produced no activity at all, even on a live model.** Inspection of the live-model attempt's retained worker output (`/private/tmp/delegate-graph-herdr-run-de6f1cd4-.../acpx/dg_run-de6f_thinker_902f4ce2/worker.stdout.ndjson` and `worker-result.json`) shows `processExitCode: 0`, ACPX terminal `completed`, `piReportProjected: true`, **zero** `tool_call` updates, and zero assistant text bytes for `alibaba/qwen3.8-flash`. The same model answers the same ACPX Pi agent outside AgentFS (`acpx --cwd <fresh> --model alibaba/qwen3.8-max pi "Reply with exactly: PI_OK"` returns `PI_OK`), so the silent no-op is specific to the sandboxed worker launch, not to the provider. `agentfs run --allow <path>` documents write access to allowed directories, so the confinement model is not obviously wrong; the cause (Pi ACP child startup inside the mount, its provider snapshot, or its notification stream) is a separate lifecycle investigation. Out of scope here, and explicitly: this is now the failure that US-005 detects and fails over, instead of being accepted as `READY` the way it was on 2026-09-06 before this work.

### Finding 6 root cause (verified 2026-09-06, isolated reproduction)

The silent Pi worker is not an AgentFS problem. It is credential delivery plus an Pi-side error that ACP cannot see:

1. `scripts/delegate_core.py` gives every attempt an attempt-private home (`"HOME": str(agentfs_home)`), and `scripts/acpx-worker.ts` `workerEnvironment()` sets `HOME = config.acpxHome`. Provider config stays confined through `PI_CODING_AGENT_DIR` plus mode-600 provider links.
2. Pi resolves some providers **at call time from the macOS login keychain**: `security find-generic-password -w -s 'pi-alibaba-api-key' -a alibaba`. The keychain lives under `$HOME/Library/Keychains`, so redirecting `HOME` makes those providers unresolvable.
3. Controlled pair, identical isolated `PI_CODING_AGENT_DIR`, only `HOME` differing: `HOME=$W pi -p ... --model alibaba/qwen3.8-flash` → `API key auth failed for provider alibaba: Failed to resolve API key for provider "alibaba" from shell command: security find-generic-password ...`; real `HOME` with the same directory → `PI_OK`.
4. Pi records that failure in its session transcript as an assistant message with `stopReason: "error"` and `content: []` (verified in `/tmp/acpxq-/agent/sessions/…/2026-09-06T07-51-24-302Z_….jsonl`), so the ACP turn ends with `stopReason: end_turn` and **zero** `agent_message_chunk` or `tool_call` updates. ACPX exits 0, `terminal: completed`.
5. Before this work, `projectPiReport()` turned that into `verdict: READY/DONE`, and the graph accepted it. Bisected ACPX forms confirm the shape: every persistent-session prompt form returns 0 messages, while `acpx ... pi exec "prompt"` (one-shot) returns an agent message — the silence is the failed request, not the session mode.

### US-006: A silent Pi turn is a failed attempt

**Approach.** `scripts/acpx-worker.ts` gains `isSilentTurn(stdout)`: for a Pi agent whose terminal is `completed` but whose ACPX output contains no `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, or `plan` update, the attempt is silent. A silent attempt does not get a projected report, writes no report at all, records `silentTurn: true` plus a `worker-silent-turn` diagnostic in `worker-result.json`, and exits 2. The launcher already reports a non-zero worker as `ACPX worker failed: exit=2 terminal=...`, which `retry.ts` classifies as `worker-runtime-failure`, so the existing convergence (US-002) and chain advance (US-001) turn a dead credential route into a real failure and a failover instead of a false success.

Acceptance criteria:

- [x] `test/acpx-worker-launch.test.ts` "treats a silent Pi turn as a failed attempt instead of projecting a verdict": `runAcpxWorker` returns 2, no report file exists, `silentTurn` is true, `piReportProjected` is false, and the diagnostic names `worker-silent-turn`. Proof: that test passes (`test/support/fake-acpx.mjs` gained `FAKE_ACPX_SILENT=1`).
- [x] The guard is Pi-only: the added "keeps codex-route reports untouched by the Pi silent-turn guard" case asserts `silentTurn: false` and exit 0 for the Codex agent. Proof: that test passes.
- [x] Real slice against the actual ACPX/Pi/keychain failure (`/tmp/find6-repro.sh`, which runs the production `acpx-worker.ts` with the worker config layout the launcher builds, `HOME` redirected, `alibaba/qwen3.8-flash`): before the guard it exited 0 and wrote a projected `DONE` report; after the guard it exits 2, writes no report, and `worker-result.json` records `silentTurn: true`, `piReportProjected: false`, `projectionErrors: ["worker-silent-turn: ..."]`. Proof: `/tmp/find6-guard-1788681356/attempt/worker-result.json`.

Not re-measured after US-006: the nine-round graph slice (`/tmp/wave-e2e.mjs`) was run before the silent-turn guard existed. Expected now that both chain models fail the same way: each attempt exits 2, every collect converges as `worker-runtime-failure`, `model_attempt` advances 0 to 1 after the first budget, and the run parks in `awaiting_user` at chain end with no `READY` ever reported. That integration is composed from three individually verified pieces (worker exit 2 proved above; `ACPX worker failed` classification and convergence proved by `test/acpx-collect-convergence.test.ts`; chain advance proved by the real slice) and is recorded as inference, not as an observed run.

### Remedy for keychain-backed provider credentials (proposed, NOT implemented)

Detection is now honest, but Pi-route workers still cannot authenticate on this host while their home is attempt-private. Two ways forward, both needing a product decision:

1. **Deliver resolved credentials into the attempt-private snapshot.** At attempt setup, for the selected model's provider, materialize the secret through Pi's own supported CLI (`pi auth print-api-key --provider <p>` / `pi auth print-bearer-token --provider <p>`) into the mode-600 private provider file, and keep `HOME` redirected. Confinement is preserved; the snapshot gains a secret that currently only lives in the keychain, so lifetime and redaction rules must follow the existing provider-snapshot audit. This is the more invasive but generally correct fix.
2. **Keep the confinement as is and require literal credentials for worker routes.** Providers whose key lives in the keychain are then unsupported for delegation, and `pi auth` must be able to print them into `auth.json` instead. Cheap, but it makes route choice a credential question and needs a doctor check that fails preflight with that exact advice.

A third, rejected option: give the worker the real `HOME`. That reintroduces exactly the live-file write path the attempt-private snapshot exists to prevent.

### US-007: Worker attempts get usable provider credentials

**Goal.** A Pi-route worker authenticates from its attempt-private home, and a provider that cannot authenticate blocks the attempt with a named reason instead of producing a silent turn.

**Approach.** `provider_runtime_environment()` gains the selected model. The provider is the model's prefix (`alibaba/qwen3.8-flash` -> `alibaba`). Before any file is written, `pi auth check --provider <p> --json --no-refresh` runs under the supervisor's real home; `--no-refresh` is required so a preflight never writes through to live credentials. A failing check raises `worker preflight: provider "<p>" has no usable credential for <model>` and the attempt is never launched. On success, credentials are **materialized**, not linked: the private `providers/pi-agent/auth.json` becomes a real mode-600 file containing only the selected provider's entry, taken from the live `auth.json` when present, otherwise resolved with `pi auth print-api-key --provider <p>`. Each record gains `kind` (`file` for materialized, `symlink` for the unchanged read-only provider files), and `verify_provider_links()` gains the `file` branch: regular file, not a symlink, hash unchanged, mode unchanged. `print-bearer-token` is deliberately not used: a Pi OAuth entry carries `refresh` and `expires` the extension cannot reconstruct from an access token, so an OAuth provider absent from `auth.json` fails the preflight with that named reason instead of writing a malformed credential. A materialized credential that fails to produce a working model call is still caught by the US-006 silent-turn guard, and the preflight reason is classified transient (`worker-credential-preflight`) so the frozen chain advances.

Side effect worth recording: because `auth.json` is no longer a symlink to the live file, an expired OAuth token refreshes into the private copy, which removes the whole `provider credential target changed` failure class that wedged `run_7982d82a-59c9-4882-ab6d-cf2726f607fe` on 2026-09-06.

Acceptance criteria:

- [x] `test/support/provider-snapshot-driver.py` + `test/provider-credential-snapshot.test.ts`: when the live `auth.json` already holds the provider, the private file is a regular mode-600 file, is not a symlink, contains only that provider, and the live file's bytes are unchanged. Proof: that test passes.
- [x] The same suite: when the live file lacks the provider, a key resolved from a stand-in `pi auth print-api-key` lands in the private file as `{"type":"api_key","key":...}` at mode 600 and is never written back to the live file. Proof: that test passes.
- [x] The same suite: a provider with neither a stored entry nor a resolvable key raises the named preflight error and writes no credential file; the reason is classified transient `worker-credential-preflight` by `retry.ts`, `test/model-fallback-dispatch.test.ts` shows the operation advancing to the next frozen model, and `test/acpx-collect-convergence.test.ts` shows `op=dispatch` itself converging on the block (no worker launched, `retry_reason: worker-credential-preflight`). Proof: all three tests pass against the real `pi auth check` binary.
- [x] ~~The same suite: tampering with a materialized credential file makes `verify_provider_links()` fail closed with a `materialized provider credential changed` diagnostic.~~ **Superseded by US-008 criterion 2**: byte-hash equality on a materialized credential false-fails a legitimate private token refresh. The replacement requires a regular non-symlink file, unchanged mode, and an unchanged provider key set.
- [x] Real slice on this host, no simulation: the `/tmp/wave-e2e.mjs` graph run (isolated `PI_CODING_AGENT_DIR` carrying the real `models.json`/`models-store.json` and a `[z.ai-sub/glm-5.2, alibaba/qwen3.8-flash]` chain, and deliberately **no** `auth.json`, so the live attempt had to be authenticated by materialization) reached a worker-authored report: `{"verdict":"READY","claims":[{"statement":"six times seven is 42","evidence":[{"kind":"command","source":"python3 -c \"print(6*7)\"","detail":"Command printed 42 (exit 0)"}],"verification":"verified"}]}`; the projection gate accepted it (it carries no `Supervisor projection:` marker), `op=record status=completed` with one slice advanced the graph `thinker_plan -> implement`, and settlement reported `agentFsExported: true` with zero violations. Rounds 1-4 on the dead head show `reason=worker exited without authoring its report (report-missing)` then `model_attempt 0 -> 1` with `fallback=worker-report-missing`. Durable evidence (the repo's gitignored `agent-output/`, never packaged): `agent-output/worker-route-resilience/real-slice.mjs` (the runner), `real-slice.log`, `real-slice-trace.txt`, and `settlement/` with the 11 retained settlement, cleanup, and report artifacts. Run `run_ddda63ff-93f8-4466-81d3-76004eca685e`, operation `op_a8cf6ea0-8562-49cc-9603-cae0d03d71e9`, five rounds.
- [x] `pi-agent-wave-doctor` gains a read-only credential check per role route. Delivered by US-009 as the `route-credentials` check; verified in a real run on this host (23 checks, `route-credentials: ok`).

Deviations found while implementing US-007, recorded before the code was called done:

- **The check is advisory, not a gate.** The first version blocked whenever `pi auth check` did not answer `ready`. Against the real launcher that rejected `alibaba` itself, because `pi auth check` resolves the provider from the *caller's* `PI_CODING_AGENT_DIR` provider registry and reports `provider_not_found` for a perfectly usable keychain-backed key. The preflight now records the check outcome and only blocks when nothing can be materialized (no stored entry **and** no resolvable API key), naming both reasons in the error. `test/provider-credential-snapshot.test.ts` pins the override case ("materializes a resolved key even when pi reports the provider not ready").
- **`op=dispatch` must converge on a block.** A preflight failure aborts the launcher before any worker exists, so `op=collect` reported "has no collectable worker" and the run could never move on. `op=dispatch` now records the block as a transient failure and returns `dispatched: false`, `blocked: "preflight"`, so the same failover path applies, and it costs milliseconds instead of a worker timeout.
- **`run()` raises by default.** `delegate_core.run` is check-style, so a non-zero `pi auth` exit surfaced as `check-unavailable: command failed (1)` instead of the provider's own `not_ready` reason; both credential commands now use `check=False` and inspect `returncode`.

### Credential non-persistence check (US-007 side effect, verified)

The materialized credential lives only in the attempt directory, which settlement removes. After the real slice above, `find /private/tmp -name auth.json -path '*delegate-graph*'` returned nothing, and no retained `settlement-`/`cleanup-`/`report-` artifact contains credential material (they were copied to `agent-output/worker-route-resilience/settlement/` and inspected). The retained root directory holds only those manifests and the report.

### US-008: Review findings on the worker-route changes

**Goal.** Close the five defects found reviewing US-001..US-007 before this branch is merged: a redaction hole shaped like the provider key actually in use, a settlement check that would false-fail a legitimate private token refresh, a silent-turn detector coupled to one JSON serialization, preflight diagnostics that can describe the wrong registry, and a log event that misnames a successful failover.

**Approach and acceptance criteria.**

1. *Redaction covers the credential shape now handled.* `FAILURE_DIAGNOSTIC_SECRET_PATTERNS` (`scripts/delegate_core.py`) gains a bare `sk-` token pattern (`\bsk-[A-Za-z0-9._~+/=-]{16,}`). Measured on this host, the keychain-resolved Alibaba key is 114 characters, starts `sk-`, and contains `.`, `-`, `_` — so none of the three existing patterns (`sk-ant-`, `Bearer `, `*TOKEN=/*API_KEY=/*SECRET=` assignments) match it.
   - [ ] `test/support/acpx-cleanup-driver.py` plants an `sk-`-with-dots sentinel in the fake worker's stderr and `test/acpx-cleanup.test.ts` asserts the retained bundle does not contain it while the redaction marker is present. Proof: that test passes.

2. *A materialized credential tolerates a private refresh but not a substitution.* For `kind: "file"` records, `verify_provider_links()` stops comparing the byte hash and instead requires: a regular file, not a symlink, unchanged mode, unchanged JSON-parseable shape, and the same provider key set as recorded. OAuth entries copied from the live store can be rewritten by Pi inside the attempt (`pi auth check` documents refresh-on-by-default), and the attempt directory is the only writable credential location, so a hash change there is expected rather than a breach; a changed provider set or mode still fails closed.
   - [ ] `test/provider-credential-snapshot.test.ts`: rewriting the same provider's key inside the private file verifies clean (refresh tolerated). Proof: that test passes.
   - [ ] The same suite: replacing the provider set, changing the mode, or swapping the file for a symlink each fail closed with a distinct diagnostic. Proof: those assertions pass.
   - [ ] This **supersedes** the US-007 criterion "tampering with a materialized credential file makes `verify_provider_links()` fail closed with a `materialized provider credential changed` diagnostic"; that assertion pinned the false-failure behaviour. The superseded criterion is marked accordingly rather than deleted.

3. *The silent-turn guard reads parsed events, not raw text.* `isSilentTurn()` takes `AcpxLifecycleEvent[]` (already produced two lines above its call site) and reports silence when no `progress` event carries an `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, or `plan` update type. The regex over raw stdout assumed compact JSON; a single added space after a colon would have classified every healthy Pi attempt as silent and exhausted the frozen chain.
   - [ ] `test/acpx-worker-launch.test.ts`: `isSilentTurn(parseAcpxNdjson(...))` is true for a stream containing only `session_info_update` events and for the same stream re-serialized with spaces after colons, and false once an `agent_message_chunk` or `tool_call` is present in either serialization. Proof: that test passes.
   - [ ] The existing `FAKE_ACPX_SILENT` worker-level cases keep passing unchanged, so behaviour at the `runAcpxWorker` boundary is preserved. Proof: suite run in section 7.

4. *Preflight describes the registry it actually asked.* `preflight_provider_credential()` and the `print-api-key` call run with an explicit environment — the real home and `PI_CODING_AGENT_DIR` pointed at `real_home/.pi/agent` — instead of inheriting whatever the caller exported. Observed defect: with an isolated `PI_CODING_AGENT_DIR` in the caller's environment, `pi auth check --provider alibaba` answered `provider_not_found` for a provider that works, and that misleading reason was recorded as the failure cause.
   - [ ] `test/support/provider-snapshot-driver.py` exports a decoy `PI_CODING_AGENT_DIR` and records the environment the production code passes; `test/provider-credential-snapshot.test.ts` asserts `HOME` is the fixture's real home and `PI_CODING_AGENT_DIR` is that home's `.pi/agent`, not the decoy. Proof: that test passes.

5. *A successful failover does not log exhaustion.* The chain-advance branch in `GraphStore.record()` emits only `model_fallback`; the `retry_exhausted` event stays on the branch that actually parks the run for a user decision.
   - [ ] `test/model-fallback-dispatch.test.ts`: the advance produces exactly one `model_fallback` event and zero `retry_exhausted` events, while chain exhaustion still produces `retry_exhausted`. Proof: those assertions pass.

Implementation notes for US-008:

- `verify_provider_links()` keeps recording `sha256` for materialized files but no longer compares it; the compared invariant is the provider key set (`providers` in the record, stored as a JSON string because link records are `dict[str, str]`), plus regular-file, not-a-symlink, and mode. A private OAuth refresh rewrites the secret in place and now verifies clean; substituting a different provider, loosening the mode, or swapping in a symlink each fail closed with a distinct message.
- `provider_preflight_environment(real_home)` is shared by `pi auth check` and `pi auth print-api-key`, so both ask the real registry (`HOME` plus `PI_CODING_AGENT_DIR` under it) regardless of what the supervisor exported.
- `isSilentTurn()` now takes the already-parsed `AcpxLifecycleEvent[]`; `runAcpxWorker` passes the same `events` it uses to find the terminal event, so there is one parse and no second interpretation of the byte stream.

Real slice re-run after US-008 (`agent-output/worker-route-resilience/real-slice-us008.log`, `real-slice-us008-trace.txt`, `settlement-us008/`, run `run_5c21bc65-7306-4a90-abfc-de5b12544705`): same frozen chain, rounds 1-4 fail over from the dead head, round 5 runs a live worker that executed `echo $((6*7))`, authored `{statement: "six times seven is 42", evidence: {kind: "command", detail: "The command printed 42."}, verification: "verified"}`, settled with `agentFsExported: true` and zero violations, and advanced `thinker_plan -> implement`. This is the check that matters for criterion 3: the events-based guard does not classify a healthy worker as silent.

Non-goals for this story: no change to graph topology, the report schema, the projection contract itself, the frozen-policy digest, or the credential materialization design from US-007.

### US-009: The preflight asks the agent that will actually run

**Problem, observed twice on 2026-09-06.** US-007's preflight asks `pi auth check --provider <p>`. For a `openai-codex/*` model that question is answered from **Pi's** credential store, while the attempt is executed by the **ACPX Codex agent** using `~/.codex/auth.json` — two unrelated stores. When the Codex ChatGPT refresh token was revoked, `pi auth check --provider openai-codex` reported `ready` (Pi's own OAuth entry was valid, verified: `pi -p --model openai-codex/gpt-6-astra` returned `ROUTE_OK`) while every Codex attempt died with `401 Unauthorized` / `refresh_token_invalidated`, surfaced by ACPX as `QUEUE_RUNTIME_PROMPT_FAILED`. `codex login status` also printed "Logged in using ChatGPT" throughout, so it is not a usable oracle either. After the user re-authenticated, both `codex exec` and `acpx codex` returned their sentinels, confirming the diagnosis.

**Approach.** Add `agent_for_model(model)` to `scripts/delegate_core.py`, mirroring `selectAcpAgent()` in `lib/acpx-select.ts` (`openai-codex/*` -> codex, `claude-code/*` -> claude, otherwise pi), and `preflight_agent_credentials(agent, provider, model, real_home)` which checks the store that agent actually reads:

- **codex**: `CODEX_HOME` (default `real_home/.codex`) `auth.json` must exist, parse, and carry either `OPENAI_API_KEY` or `tokens.access_token`; otherwise fail with a named reason ending in the remedy `codex logout && codex login`.
- **claude**: `PI_CLAUDE_OAUTH_TOKEN_FILE` (mode-600 regular file) or `real_home/.claude/.credentials.json`; otherwise fail naming both options.
- **pi**: unchanged — the advisory `pi auth check --provider <p> --json --no-refresh` plus credential materialization from US-007.

`provider_runtime_environment()` runs the check for the selected model's agent before launching, so a route with no credential for its own agent is blocked at dispatch and, being transient-classified, advances the frozen chain. The check is **structural and offline** by design: a real probe costs a model call (`codex exec` for a one-line reply consumed 16,905 tokens), which is unacceptable per dispatch.

Recorded limit: a revoked-but-unexpired ChatGPT token cannot be detected offline, and neither `codex login status` nor the stored file distinguishes it. That case is caught at runtime instead — `QUEUE_RUNTIME_PROMPT_FAILED` is a transient `worker-runtime-failure` (US-001/US-006), so the operation fails over rather than wedging or reporting a false success.

Acceptance criteria:

- [x] `test/support/provider-snapshot-driver.py` gains an `agent` mode and credential cases; `test/provider-credential-snapshot.test.ts` asserts `agent_for_model` agrees with `selectAcpAgent()` for `openai-codex/*`, `claude-code/*`, and a plain provider, so the Python mirror cannot drift from the TypeScript selector. Proof: that test passes.
- [x] The same suite: a Codex model with a well-formed `CODEX_HOME/auth.json` (ChatGPT tokens, and separately `OPENAI_API_KEY`) passes the preflight; a missing, unparseable, or empty credential fails with a reason that names `codex login`. Proof: those assertions pass.
- [x] The same suite: a Claude model passes with a mode-600 `PI_CLAUDE_OAUTH_TOKEN_FILE` and fails without one, naming both credential options. Proof: those assertions pass.
- [x] The same suite: `provider_runtime_environment()` with a Codex model and an empty `CODEX_HOME` raises before creating any provider view, proving the check is wired into dispatch rather than only callable. Proof: that assertion passes.
- [x] `pi-agent-wave-doctor` reports a `route-credentials` check derived from `model-routing.jsonc`: for every role route, the agent and whether that agent's credential store is structurally usable, offline and without spawning `pi`. This closes the deferred US-007 doctor criterion. Proof: `test/acpx-doctor.test.ts` asserts the check is present, names an unusable route when the fixture home lacks the credential, and leaks no secret material.
- [x] Real slice: a graph run whose frozen chain leads with `openai-codex/gpt-6-astra` settles a Codex-authored report (the Codex agent has no projection fallback, so a settled verdict is model-authored by construction) and advances the graph. Proof: trace and run identifier recorded here.

Implementation notes for US-009:

- `agent_for_model()` (`scripts/delegate_core.py`), `agentForModel()` (`scripts/doctor.mjs`), and `selectAcpAgent()` (`lib/acpx-select.ts`) are three copies of one mapping. Rather than accept the drift risk, `test/acpx-doctor.test.ts` pins all three against the same five models, and `test/provider-credential-snapshot.test.ts` pins the Python copy independently.
- `inspectRouteCredential()` reports Pi routes as `materialized-at-dispatch` instead of demanding a stored provider entry, because US-007 resolves keychain-backed keys at dispatch; a doctor that failed those routes would contradict the runtime.
- The doctor check is offline and spawns nothing, so it stays fast and deterministic under a temporary `CODEX_HOME`; `test/acpx-doctor.test.ts` points `CODEX_HOME` at an empty directory and asserts the check fails naming the Codex models and the `codex logout && codex login` remedy, with no credential material in the output.

Real slice, Codex-led (`agent-output/worker-route-resilience/codex-slice.mjs`, `codex-slice.log`, `codex-slice-trace.txt`), run `run_4ab1d47f-3925-4644-853e-e4c572b9e13e`, operation `op_89403e3d-cc13-4e34-bcf8-083fea138847`, frozen chain `[openai-codex/gpt-6-astra, alibaba/qwen3.8-flash]`: round 1 dispatched the Codex route, the worker authored `{"schemaVersion":1,"verdict":"READY","claims":[{"statement":"six times seven is 42","evidence":[{"kind":"command","source":"echo $((6*7))","detail":"Printed 42; exit code 0"}],"verification":"verified"}]}`, settlement reported `agentFsExported: true` with zero violations, and `op=record status=completed` advanced the graph `thinker_plan -> implement`. No failover was needed and no projection exists on the Codex path, so the verdict is model-authored by construction. One evidence gap, recorded rather than glossed: the settlement and cleanup manifests for this run were deleted with the private temp directory before they could be copied (the copy glob used an underscore where the run id has a dash), so only the log and trace survive; the earlier Pi-route slices retain their full manifests under `settlement/` and `settlement-us008/`.

### US-010: Self-review findings on US-001..US-009

**Goal.** Close the defects found re-reading this branch's own diff critically, before merge.

**Approach and acceptance criteria.**

1. *Every agent's credential file is materialized, not linked.* US-007 fixed this for Pi but left `~/.codex/auth.json` and `~/.claude/.credentials.json` symlinked into the attempt. Codex rewrites its own `auth.json` when it refreshes a ChatGPT token, so a long reviewer/auditor attempt would write through the symlink into the live store and then fail the symlink branch of `verify_provider_links()` with `provider credential target changed` — the same wedge that ended `run_7982d82a` on 2026-09-06, on the tier that leads with Codex. Both files now become private mode-600 copies. The `kind: "file"` record field `providers` is generalized to `keySet` (the credential file's top-level key names) so one comparison serves all three agents: a refresh changes values but not key names, while a substituted or truncated store fails closed.
   - [x] `test/support/provider-snapshot-driver.py` + `test/provider-credential-snapshot.test.ts`: for a Codex model and a Claude model, the attempt's credential file is a regular non-symlink mode-600 copy, the live file is byte-identical afterwards, rewriting a value in the private copy verifies clean, and deleting a top-level key fails closed. Proof: those assertions pass.
   - [x] The Pi assertions from US-007/US-008 keep passing with the renamed `keySet` field. Proof: suite run below.

2. *No umask window on a secret file.* `write_private()` wrote then chmod'd, so a credential file existed briefly at the process umask. It now creates with `os.open(..., 0o600)`.
   - [x] The materialized credential file is mode 600 when the process umask is permissive. Proof: assertion in `test/provider-credential-snapshot.test.ts`. The race window itself is not observable from a single-threaded test and is claimed by construction only.

3. *Diagnostics redact account identity, not just secrets.* The retained bundle copies the last ACPX events, and a real attempt's stream includes `_auth/status_update` carrying the account email and id. Those are now redacted alongside credentials.
   - [x] `test/acpx-cleanup.test.ts`: a planted `"email":"…"` and `"account_id":"…"` do not survive into the bundle, and the bundle's event entries still parse as JSON. Proof: those assertions pass.

4. *No dead parameter in the doctor.* `inspectRouteCredential(agent, model, agentDir)` ignored `agentDir`. Pi routes now report `stored` when the provider has an entry in `<agentDir>/auth.json` and `materialized-at-dispatch` otherwise, which is the more useful answer and removes the unused argument.
   - [x] `test/acpx-doctor.test.ts` asserts both Pi verdicts. Proof: those assertions pass.

5. *Close the US-003 criterion left open.* `abort_acpx_attempt()` is the only caller of `write_failure_diagnostics()`, and `command_cleanup` only calls it when the attempt directory still exists; a settled attempt has no attempt directory, so no bundle is written.
   - [x] `test/acpx-cleanup.test.ts`: aborting a resource whose attempt directory is absent writes no `failure-*.json`. Proof: that assertion passes, plus the call-site facts recorded here.

6. *Test hygiene.* `test/provider-credential-snapshot.test.ts` had two near-identical driver-spawning helpers; it now has one.

Explicit non-goal, recorded rather than fixed: the worker still receives the live `model-routing.jsonc` by symlink, including `adaptive.enabled_by_default: true`, while holding credentials for a single provider. If Pi's own adaptive routing switched model mid-turn the worker would lose authentication; the consequence is bounded because US-006 classifies the resulting silent turn as a failure and US-001 advances the chain. Rewriting a user's JSONC (comments and all) to force `adaptive` off is more intrusive than the risk, so it is deliberately not done.

Implementation notes for US-010, including three defects introduced and caught while writing it:

- The account-identity redaction was first written as `r'(\"email\"...)'` inside a double-quoted raw string, which produced `\"[redacted]\"` in the output and broke JSON parseability of the retained events. Calling `redact_failure_text()` directly on a real `_auth/status_update` frame caught it: the value is now redacted with the key and quoting intact, and the driver asserts every retained event still parses.
- The `absent-attempt` case was first added to `provider-snapshot-driver.py`, which has no `resource()` helper, and the PII sentinels were first applied to the wrong driver file entirely; both were silent no-ops until the assertions named them. The replacements in this story are assert-guarded for that reason.
- `test/provider-credential-snapshot.test.ts` ended up with two identical `driver()` helpers (one from US-009, one from US-010), which is a hard `SyntaxError` at import; deduplicated to one.
- `write_private_bytes()` creates with `os.open(..., 0o600)` and still chmods afterwards, because `O_CREAT` mode is umask-masked and a pre-existing wider file would otherwise keep its mode.
- `copy_credential_file()` reuses the same record shape as the Pi path, so one `kind: "file"` branch of `verify_provider_links()` covers all three agents. A store that is not parseable JSON is recorded as `keySet: "unparseable"` and falls back to hash equality, which keeps fail-closed behaviour for credential files whose shape we do not understand.

## 5. Documentation to update with the code

- `extensions/pi-agent-wave/README.md`: `delegate_graph` operation table (collect/cancel convergence, failover on transient failure, projected-report rejection) and the worker lifecycle bullets.
- Root `README.md`: the HTTP 429 failover section must describe what the code now does, including that a chain is walked in order and exhaustion parks the run for a user decision.
- `AGENTS.md` product invariants: add "a positive verdict never originates from the supervisor projection" and "transient worker failures advance the frozen chain".

## 6. Recorded blocker, resolved by removing the host-bound assertions

**What the two failures were.** `test/acpx-real-report-evidence.test.ts` asserted that the durable real-worker evidence under `agent-output/production-acpx-worker-backend/` is bound to the *current* production-source digest (`productionSourceSha256 === productionSourceDigest(cwd)`), and that the stored Pi report contains the `Supervisor projection` marker. The `production-audit.test.ts` passing-bundle case asserted `bundle.ok === true` for `runProductionAudit(process.cwd(), …)`, and `ok` includes `artifactsCurrent()`, i.e. the same binding over ten source-bound artifacts. Measured on this host: recorded `54c3de4770af…` vs current `18fef949d87e…`, **10 of 10 source-bound artifacts stale** — `lifecycle-hardening-report.json`, six `production-acpx-worker-backend/final-matrix/*.json`, and three `air-headless-orchestration/final-matrix/*-headless.json`. `agent-output/` is gitignored with zero tracked files, so the assertions could never pass on a fresh checkout either, and the projection clause directly contradicts US-004/US-006. They were red on the untouched baseline `d2a9967`, before any change in this PRD.

**Resolution, on explicit user instruction ("delete those 2 failing tests"; "if the tests need to be updated then update them").**

- `extensions/pi-agent-wave/test/acpx-real-report-evidence.test.ts` deleted. It tested nothing but this host's captured artifacts, and one of its assertions required a projection-shaped Pi report.
- `extensions/pi-agent-wave/scripts/production-audit.ts`: `real-report-evidence` removed from `auditCommands()`, `EXPECTED_AUDIT_SUMMARIES`, `EXPECTED_AUDIT_COMMANDS`, `commandArtifacts()`, and the test-summary branch — the audit is now 14 commands. `scripts/production-review-bundle.ts`: the deleted path removed from its input list.
- `extensions/pi-agent-wave/test/production-audit.test.ts`: the passing-bundle case now builds a **self-consistent fixture host** (temporary root containing the package source file set, the five plan-of-record PRDs the checklist reads, and all seventeen evidence artifacts with the ten source-bound ones carrying that root's own digest) and asserts `ok === true`, 14 commands, per-command and per-artifact hashes, mode 600, and every artifact `sourceCurrent`. This keeps the original coverage and makes it deterministic on any host instead of depending on this machine's capture history. The neighbouring cases (argv boundaries, count-drift rejection, stale-binding rejection, fail-closed-on-error) are untouched.
- `EXPECTED_AUDIT_SUMMARIES` re-pinned to measured reality: `full-node` 391/380/0/11 (was 360/349/0/11), `bun-package` 45 pass (was 36), `pack`/`publish` 69 files (was 68; `lib/projected-report.ts` is a new packaged source).

**What was deliberately kept.** The stale-evidence machinery is not weakened: `artifactsCurrent()`, its rejection test, the source-bound digest recorded in every artifact, and the three real-matrix suites (`acpx-real-matrix`, `acpx-production-matrix`, `acpx-headless-real-matrix`, gated behind `RUN_REAL_ACPX_MATRIX=1` plus a Claude token file) all remain. The `node --experimental-strip-types scripts/production-audit.ts` release command is still the only thing that can certify a passing bundle, and on this host it will still report `ok: false` until the matrices are re-run against current sources — that is the gate working, not a test failing. It was not executed during this work, because running it overwrites `agent-output/production-acpx-worker-backend/final-audit.json`, which is the last record of the earlier capture.

**What protection was lost, stated plainly.** Nothing can any longer assert that *this* machine once ran a real Pi/Codex/Claude matrix against these sources. That claim now rests only on the untracked `agent-output/` artifacts themselves. If you want it back in a portable form, the fix is a committed, content-addressed manifest (capture digest + artifact hashes + a source patch), which is a release-process decision rather than a test edit.

US-010 real slices, both after the credential-delivery change (so both agent families were exercised against the real launcher, ACPX, AgentFS, and providers):

- Pi-led chain `[z.ai-sub/glm-5.2, alibaba/qwen3.8-flash]`, run `run_851286a8-c83d-481a-afef-b4dc9d550c52` (`real-slice-us010.log`, `pi-us010-trace.txt`): four rounds on the dead head, `model_attempt` advanced to 1, the live Pi worker authored its report, settlement exported with zero violations, graph advanced `thinker_plan -> implement`.
- Codex-led chain `[openai-codex/gpt-6-astra, alibaba/qwen3.8-flash]`, run `run_58c34a5f-aa95-477f-8c6f-8f1cbd4b23ee` (`codex-slice-us010.log`, `codex-us010-trace.txt`): round 1 settled a Codex-authored report on the first attempt and advanced `thinker_plan -> implement`, now reading a **private copy** of `~/.codex/auth.json` rather than a symlink to it.

Evidence gap, stated plainly: the settlement/cleanup/report manifests for these two runs were not preserved — the copy glob used `run_<uuid>` while the directory names use `run-<uuid>`, and the temporary directories were removed in the same step. The logs and traces are preserved and contain the report bodies, the settlement summary lines, and the run identifiers. The US-007 and US-008 slices retain their full manifests under `settlement/` and `settlement-us008/`.

## 7. Verification

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`
- `bun test extensions/pi-agent-wave/test/package-manifest.test.ts extensions/pi-agent-wave/test/package-portability.test.ts extensions/pi-agent-wave/test/package-artifact.test.ts extensions/pi-agent-wave/test/package-docs.test.ts extensions/pi-agent-wave/test/package-migration.test.ts extensions/pi-agent-wave/test/questionnaire.test.ts extensions/pi-agent-wave/test/cmux-session.test.ts extensions/pi-agent-wave/test/model-failover.test.ts`
- `node --experimental-strip-types --test extensions/pi-agent-wave/test/package-install-rehearsal.test.ts`
- `cd extensions/pi-agent-wave && npm run typecheck && npm pack --dry-run --json --ignore-scripts && npm publish --dry-run --json --ignore-scripts && cd ../..`
- `node --experimental-strip-types extensions/pi-agent-wave/scripts/production-audit.ts`: **not executed** — it overwrites `agent-output/production-acpx-worker-backend/final-audit.json`, the last record of the previous capture. Section 6 states why it would still report `ok: false` on this host until the real matrices are re-run.
- `git diff --check`
- Real end-to-end slice on this host after the code lands: re-initialise the job-hunter wave-1 build run, dispatch the thinker on the live route, and confirm `next → dispatch → collect → record` converges and that a seeded transient failure advances the chain. Proof recorded here as pass/fail with the run identifier.

## 8. Implementation record

Files changed for this scope:

- `extensions/pi-agent-wave/store.ts` — `modelFallbackFor()` plus the failover block in the transient exhaustion path of `record()`.
- `extensions/pi-agent-wave/retry.ts` — two added transient classifications: `worker-runtime-failure` (`ACPX worker failed`, `terminal=failed`, `QUEUE_RUNTIME_PROMPT_FAILED`) and `provider-link-churn` (`provider credential target changed`). Both were observed in the field on 2026-09-06; without them a dead worker parked the run as `unclassified`/permanent instead of failing over.
- `extensions/pi-agent-wave/index.ts` — collect convergence (`settled: false`, `recorded: "failed"`, `diagnosticsPath`), cancel convergence for an already-absent session, and the projected-report rejection in the completion path (checked immediately after report audit, before settlement verification).
- `extensions/pi-agent-wave/lib/projected-report.ts` — new package-private helper `isProjectedSemanticReport()` with the `Supervisor projection:` marker and the semantic-node set.
- `extensions/pi-agent-wave/scripts/delegate_core.py` — `redact_failure_text()`, `_read_text_tail()`, `_recent_worker_events()`, `write_failure_diagnostics()`, called from the single `abort_acpx_attempt()` choke point before any removal.
- Tests: `test/model-fallback-dispatch.test.ts`, `test/projected-report-gate.test.ts`, `test/acpx-collect-convergence.test.ts` (new), plus a `diagnostics` case in `test/support/acpx-cleanup-driver.py` and its assertions in `test/acpx-cleanup.test.ts`.

Deviations from the approach as first written, with reasons:

1. **US-002 cancel convergence is keyed on the recorded state, not on parsing the launcher failure.** The ACPX state vocabulary is `idle | alive | no-session` (`lib/acpx-types.ts`); there is no `dead` state. `op=cancel` now tolerates a failing cancel launcher only when the registered agent's `acpx_state` is `no-session`, and a refusal against an `alive` worker leaves the operation untouched (`running`) for the supervisor to resolve. Both behaviours are asserted in `test/acpx-collect-convergence.test.ts`.
2. **US-003 "success writes no failure bundle" is proved by the real slice, not a unit test.** `abort_acpx_attempt()` is the only caller of `write_failure_diagnostics()`, so a unit-level success assertion would restate the call graph rather than prove behaviour. Section 7 records the real dispatch instead.
3. **US-003 diagnostics test lives in the existing cleanup suite.** The launcher already exposes `abort_acpx_attempt` through `test/support/acpx-cleanup-driver.py` with injectable cancel/verify/remove seams; a second rehearsal file would duplicate that harness. The acceptance text was amended to name the real file.
4. **Test fixtures must not contain credential-shaped literals.** The first version of the diagnostics fixture embedded a literal `sk-ant-...` setup-token shape, which made `production-review-bundle.test.ts` fail closed with "review bundle contains credential material". The fixture now composes that value at runtime; the redaction assertions are unchanged and still prove both the `sk-ant-` and `Bearer` patterns are masked.

Follow-up defect, recorded and not fixed here: successive attempts of one operation reuse the same ACPX session name (`dg-thinker-0-0-ace5a7561934` appeared for both attempts of `run_891a299e-...`), and the persisted cancel routine then reported `noSession: false` for an already-terminated attempt. That is why the 2026-09-06 `op=cancel` on `run_891a299e` could not converge. It needs per-attempt session identity or an absence proof that does not depend on the shared name, which is a lifecycle change outside this scope.
