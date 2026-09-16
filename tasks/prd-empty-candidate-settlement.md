# Empty candidate settlement: a coding worker that produced nothing must not become a decidable candidate

**Status:** Built and gated (2026-09-16), unmerged on branch `issue-empty-candidate-settlement`. Governs `extensions/pi-agent-wave/scripts/runtime-settle.ts`, `extensions/pi-agent-wave/index.ts` (`decisionBrief`), `extensions/pi-agent-wave/store.ts` (`decideRuntimeCandidate`) and `extensions/pi-agent-wave/scripts/delegate_core.py` (`retain_incomplete_capture`). Subordinate to `tasks/prd-runtime-owned-results.md`, which owns the `runtime-v1` contract; nothing here changes graph topology, joins, retry budgets, evidence gates or model policy.

Attempts: 1.

## Field evidence

Run `run_74d142d5-9773-4bbd-888c-03d9b428e849` (build graph, task "tell me what day is today") reached `implement` and could not leave it. The settlement record at `/private/tmp/delegate-graph-herdr-run-74d142d5-9773-4bbd-888c-03d9b428e849-op-6c12689f-d402-4f87-b015-9f61b338ad1b.0ub27sfa/runtime-settlement-dg-run-74d1-implement-17b9dbf5.json` reads:

```json
"candidate": { "kind": "coding", "answer": null, "artifacts": [ { "sha256": "dac14f96…", "bytes": 431 } ] },
"observation": { "captureStatus": "incomplete", "manifest": { "sha256": "dac14f96…", "bytes": 431 } },
"answer": null, "stagedFiles": 0, "diagnostics": [ "output-outside-prompt" ]
```

The single 431-byte artifact is the staging manifest itself, and its retained content (`~/.cache/delegate-graph/runtime-content/dac14f96e767c24bb5d8e1f2373255b89a4641e2fdd9ea4753ad97a88b5b12f4`) is `{"attemptKey":"…","baseRevision":"0d11731373f1cf0a39950aecbc12fec69f6c6dde","changes":[],"ownedPaths":["agent-output/day-of-today/verify-current-date.md"],"readOnly":false,…}`. So the worker produced no assistant text and changed no file, yet a `coding` candidate exists. The same row is in the live database (`runtime_attempts.candidate_json` for attempt `…:implementer:0:0:mtplx/mtplx-flash-next:pi`).

Every supervisor exit was then refused or wrong:

- `op=integrate` → `integration requires file changes` (`lib/runtime-integration.ts:165`).
- `op=retry` → `an exited runtime attempt with a candidate must be decided, not retried` (`store.ts:1446`).
- `op=decide accepted` → **would have succeeded**, because `store.ts:1362` only requires an applied integration when `manifest.changes.length` is non-zero. The graph would have advanced on an empty result.
- `op=collect`'s brief said `Call op=integrate for this operationId before op=decide accepted` (`index.ts:631`), which is impossible for this candidate.

No `runtime-capture-*.ndjson` exists in that run directory even though capture was `incomplete`, so the reason the reply was dropped cannot be diagnosed.

## Root causes

1. **`scripts/runtime-settle.ts:115` mints a coding candidate from the manifest alone.** The coding branch fires on `config.kind === "coding" && manifest`, and the manifest exists for every owned-write attempt regardless of whether anything changed. The emptiness guard in `lib/runtime-results.ts:224` cannot catch it: it accepts any artifact with `bytes > 0`, and the manifest always has bytes. The operational branch already requires `answer`; the coding branch requires nothing. The correct settlement fact for this attempt is `candidate: null`, which `retry.ts:31` already classifies as the transient `worker-empty-answer` and which `store.ts:1446` already routes to `op=retry`.

2. **`decisionBrief` never reads the manifest it points at.** It emits the integrate-first note for every coding and operational candidate, while the store's acceptance rule branches on the manifest's change count. Supervisor instructions and store behaviour disagree for exactly the zero-change case.

3. **`retain_incomplete_capture` reads a path the prompt-mode worker never writes.** It looks for `attempt_dir/worker.stdout.ndjson` (`scripts/delegate_core.py:1644`), but in prompt mode the stream is written by `RuntimeOutputFiles` into `dirname(resultPath)/runtime-output/worker.stdout.ndjson` (`scripts/acpx-worker.ts:202`, `lib/runtime-process.ts`, `lib/runtime-output.ts:39`). The config's `stdoutPath` under the attempt directory is only written on the `close` mode path (`scripts/acpx-worker.ts:192`). Retention therefore silently returns `None` for every prompt worker, and the attempt directory is removed straight after (`scripts/delegate_core.py:1727`), so the evidence the 2026-09-12 operations smoke 3 fix was written to preserve (`tasks/prd-runtime-owned-results.md:287`) is still being lost.

## Check before building anything

Does an existing mechanism already cover this? No, and each of the three was checked against the merged code rather than assumed:

- `retry.ts` already has `worker-empty-answer`, and `store.ts:1444` already routes a candidate-less exit to it. The gap is only that settlement never produces `candidate: null` for this shape, so the existing recovery is unreachable.
- `store.ts:1362` already distinguishes zero-change acceptance; the gap is that nothing refuses a candidate that is empty in *both* dimensions, and that the brief does not mirror the branch.
- `retain_incomplete_capture` already exists and already has the right trigger condition; only its source path is wrong.

The three tests named below were written first against the merged code and failed in exactly the recorded way before any source change: `'coding' !== null` in the settlement case, three failures in `runtime-results.test.ts` (the acceptance refusal and both brief cases), and `an incomplete capture with no candidate must retain the worker stream` in the Python lifecycle case.

## User story 1 — a worker that produced nothing settles as no candidate

As the supervisor of a `/delegate` run, I want an owned-write worker that wrote no file and whose reply was not captured to settle with no candidate, so the existing `worker-empty-answer` retry can replace it instead of leaving the operation undecidable.

Acceptance criteria:

- [ ] `extensions/pi-agent-wave/scripts/runtime-settle.ts` mints a coding candidate only when the attempt has substance: a retained public answer, or at least one audited change in the staging manifest. A deletion-only change counts (its `after` is `null`, so staged file content is not the test). Proof: a new case in `extensions/pi-agent-wave/test/runtime-settle.test.ts` that runs the real `agentfs` binary against a temporary Git base with **no** owned write and an empty `public-answer.txt`, and asserts `evidence.candidate === null`, `evidence.stagedFiles === 0`, and that the observation still records `captureStatus`.

  Status: met. `evidence.candidate === null`, `evidence.stagedFiles === 0`, `captureStatus` still `incomplete`, proven by `a coding attempt with no owned write and no captured answer settles as candidate null` in `test/runtime-settle.test.ts`, which drives the real `agentfs` binary.

  Amended during implementation (2026-09-16): the criterion first also required the observation to keep its staging manifest. It cannot. `store.ts:1256` refuses an observed manifest that is not an artifact of a retained candidate, so a candidate-less settlement carrying a manifest is rejected at `settleRuntimeAttempt` — observed as `observed manifest must be a retained coding or operational artifact` when the first version of the test ran. That invariant is correct (an observation must not reference content no candidate retains), so settlement observes `manifest: null` when it mints no candidate. The manifest bytes are still retained in the content store; diagnosis of the empty attempt rests on the capture stream from user story 3, not on the observation.
- [x] The same settlement still produces a coding candidate when only one of the two is present. Proof: the same test file gains a case with an owned write and an empty answer (candidate `coding`, `stagedFiles` 1), and the existing "coding settlement stages audited AgentFS changes" case continues to pass unchanged for the answer-plus-write shape.
- [x] A candidate-less coding settlement reaches the existing recovery. Proof: a case that feeds that evidence into `GraphStore.settleRuntimeAttempt` and then asserts `retryRuntimeAttempt` returns classification `worker-empty-answer` with the operation back to `pending`, rather than the `must be decided, not retried` refusal.
- [x] Rows already in a database from before this change cannot be accepted into nothing: `GraphStore.decideRuntimeCandidate` refuses `accepted` for a coding or operational candidate whose answer is absent and whose manifest records no changes, naming rejection plus `op=resolve decision=retry` as the exit. Proof: a case in `extensions/pi-agent-wave/test/runtime-results.test.ts` built on the field shape (null answer, manifest with `changes: []`) asserting the refusal, and asserting that `rejected` still parks the run in `awaiting_user`.

## User story 2 — the decision brief matches what the store will do

As the supervisor, I want `op=collect` to tell me the decision path the store will actually accept, so I do not call `op=integrate` for a candidate that has nothing to integrate.

Acceptance criteria:

- [x] `decisionBrief` reads the observed staging manifest for coding and operational candidates and emits three distinct notes: integrate first when there are changes, decide directly when there are none, and "empty candidate — reject, then resume with a retry" when there is neither an answer nor a change. Proof: three cases in `extensions/pi-agent-wave/test/runtime-results.test.ts` asserting the note text for each shape, with the zero-change case's note consistent with the acceptance that `store.ts:1362` permits.
- [x] A manifest that cannot be read or parsed does not break `op=collect`: the brief falls back to the integrate-first note rather than throwing. Proof: a case that corrupts the retained manifest bytes and asserts the brief still returns.

## User story 3 — an incomplete capture leaves a stream to diagnose

As a reviewer of a capture anomaly, I want the raw worker stream retained whenever capture was not complete or no candidate exists, so a diagnostic claim rests on the stream rather than on inference.

Acceptance criteria:

- [x] `retain_incomplete_capture` resolves the stream from the worker result's own `outputDir` (`runtime-output/worker.stdout.ndjson`), and still accepts the attempt-directory path when that is where the stream is. Proof: a case in `extensions/pi-agent-wave/test/runtime-lifecycle-python.test.ts` that builds a real attempt resource through `core.prepare_acpx_attempt`, writes a prompt-mode `runtime-output/worker.stdout.ndjson` plus an evidence file with `captureStatus: "incomplete"`, calls `core.retain_incomplete_capture`, and asserts `runtime-capture-<agent>.ndjson` exists in the run directory with the stream's bytes and mode 600.
- [x] The retention still does nothing for a clean settlement. Proof: the same case re-runs with `captureStatus: "complete"` and a candidate present, asserting `None` and no file written.
- [x] The new case binds to the path fix: with the source path reverted to the attempt-directory-only form, it fails. The mutation, its output and the revert are recorded in this file.

## Non-goals

- No change to `assertDisjointOwnership` (`store.ts:225`), which forces every build-graph slice to own a writable path and is what pushed a read-only question into writing a file. That is a separate design question and is not fixed here.
- No change to the `output-outside-prompt` classification in `lib/runtime-capture.ts:170`, and no attempt to fix the underlying Pi capture anomaly. This issue makes it diagnosable and recoverable; explaining it needs a retained stream that does not exist yet.
- No change to graph topology, joins, retry budgets, evidence gates, model-policy resolution, the `runtime-v1` result contract, or the schema. No migration.
- No dispatch of a real worker and no provider spend as part of the gate; live proof is only whatever the user separately authorizes.

## Containment

Every test uses a temporary `PI_CODING_AGENT_DIR`, a temporary `DELEGATE_GRAPH_DB` and temporary Git bases. Nothing writes `~/.cache/delegate-graph/delegate-graph.db` or the real Pi installation. The stuck field run is left as it is until the user decides whether to reject-and-resume it.

## What was built

**User story 1 — settlement mints no candidate without substance.** `scripts/runtime-settle.ts` keeps the staging manifest's `changes` from `stageRuntimeAgentFs` and requires `answer || changes.length` before building a coding candidate; the operational branch already required an answer and is unchanged. The candidate is now computed before the observation, because an observation may only reference content a retained candidate carries (`store.ts` `settleRuntimeAttempt`), so an empty attempt observes `manifest: null` while the manifest bytes stay in the content store. `store.ts` `decideRuntimeCandidate` refuses `accepted` for a coding or operational candidate with no answer and a zero-change manifest, naming rejection plus retry as the exit; that guard exists for rows written before this change, since settlement no longer produces the shape.

**User story 2 — the brief matches the store.** `index.ts` gained `stagedChangeCount()`, which reads the observed manifest through `RuntimeContentStore` and `parseRuntimeStagingManifest`. `decisionBrief` uses it to pick one of three notes for owned-write candidates. It is advisory, so an unreadable or malformed manifest returns null and leaves the integrate-first note rather than failing `op=collect`.

**User story 3 — the stream is retained where the prompt worker writes it.** `retain_incomplete_capture` now looks beside the worker result (`runtime-output/worker.stdout.ndjson`, where `RuntimeOutputFiles` writes) before the attempt-directory path, which only a `close` run populates.

**Documentation.** `extensions/pi-agent-wave/README.md`: the `collect` row now says the note is read from the candidate's own staging manifest and lists all four cases; the decisions paragraph records that an empty candidate cannot be accepted; the failure-class paragraph records that an owned-write worker which changed nothing settles as `worker-empty-answer`.

## Verification

- **Failing-first.** Each test was run against merged code before its fix. Settlement: `'coding' !== null`. Store and brief: three failures in `runtime-results.test.ts`. Capture retention: `an incomplete capture with no candidate must retain the worker stream`.
- **Mutation check for user story 3.** `retain_incomplete_capture` was reverted to the attempt-directory-only source path and the Python lifecycle suite re-run: the new case failed with `an incomplete capture with no candidate must retain the worker stream` (3 of 4 passing), so the case binds to the path rather than to the trigger condition. Raw output: `agent-output/empty-candidate-settlement-20260916/mutation-capture-path.log`. `delegate_core.py` was restored from a pre-mutation copy at `/tmp/delegate_core.pristine.py`, `diff` against `HEAD` shows only the intended change, and the suite returned to 4/4.
- **Gate, this run, from the repository root.** `node --experimental-strip-types --test --test-concurrency=1 extensions/pi-agent-wave/test/*.test.ts`: **531 tests, 520 passed, 0 failed, 11 opt-in skips**, logged at `agent-output/empty-candidate-settlement-20260916/node-gate.log`. `npm run typecheck` clean. `git diff --check` clean. Source revision: branch `issue-empty-candidate-settlement` off `61651b8`.
- **Not run here.** No live worker dispatch, no provider spend, no Bun package gates, no `npm pack`/`publish` dry run, no installation rehearsal; none of the three changes touch packaging, and the user authorized no live run. The field run `run_74d142d5-9773-4bbd-888c-03d9b428e849` is still parked at `implement` and was not touched.
