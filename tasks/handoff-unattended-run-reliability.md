# Handoff: six defects that force an operator to babysit a run

**Recorded:** 2026-10-03
**Reported by:** the Pi supervisor session that ran a `build` run for `us-000-repair-suite-failures`
(`run_46bfcb33-e951-4bb4-a3fd-08b39c1a71c1`) in `/Users/davidepugliese/projects/job-hunter-public`,
during the post-run audit that also examined `run_ecddd871-956d-453d-b343-ecc006720144` (the same day)
and `run_a6a35211-1958-4a79-88dd-c192326bf434` (2026-09-27, still `active` in the store)
**Affects:** every `build` run on both transports (Herdr and headless), most severely runs whose
supervisor session ends or whose worker dies without tearing its attempt down
**Does not affect:** the `research` graph's read-only roles, single-node runs that fail loudly, or
settlement of a worker that exits cleanly
**Not a PRD.** This file is a work order, not a plan of record. It is written to survive the removal of
the `tasks/prd-*.md` files and should be read with `specification.md` and `product.md`.

## 1. Summary

A run only works unattended when three things hold: it starts in a state that *can* settle, a dead
worker is *noticed*, and a live-but-quiet worker is *bounded*. Today none of the three is guaranteed.

| # | Defect | Consequence | Standing evidence |
| --- | --- | --- | --- |
| 1 | A run bound to a non-Git base directory fails only at settlement | 25+ minutes of worker time discarded; happened twice, six days apart | `run_a6a35211` op `op_f661545a…` (27 Sep), `run_ecddd871` op `op_663faa9d…` (3 Oct) |
| 2 | A dead worker leaves its operation `running` forever | A dead run is indistinguishable from a working one; it stays `active` indefinitely | `run_a6a35211` `active` since 2026-09-27 with three `implement` operations `running` |
| 3 | `op=status` echoes the entire task text | Supervisor context and cost scale with task size, not with progress | the 3 Oct status call returned the full ~4k-token story body |
| 4 | Waits key on pane status instead of the worker's own result file | A healthy worker can appear idle-less for the whole wait bound | `herdr agent wait --until idle --timeout 780000` timed out while the worker was healthy |
| 5 | The `delegate-ledger` wrapper cannot resolve a *relative* package path | A false alarm that reads as "the ledger was lost" | wrapper line 22 discards the relative entry at `~/.pi/agent/settings.json:28` |
| 6 | Orphaned Herdr tabs survive a run that never settles | Tabs accumulate; a six-day-old worker tab is still open | `w1:tC` from `run_a6a35211` |
| 7 | A worker that disappears is classified by transport and timing, not by what happened (added 2026-10-03 evening, §8a) | A Herdr worker that dies, or any worker lost to a reboot, parks the run for the operator; the same death on headless is retried | `run_ab8675e8` `op_6c32d0f7…`, rehearsed on a copy |

Items 1 and 2 are the ones that make unattended operation unsafe. Items 3–6 are the ones that make it
expensive or confusing. Item 7 completes item 2: item 2 made a dead worker visible, item 7 makes it
recoverable without the operator while budget remains.

## 2. How this was found, and where the evidence is

Everything below is read from the store and the source, not reconstructed. The 3 October run is the
control: it completed all five nodes with 8–9 second inter-node gaps and ~77 s of total orchestration
overhead against 45 m 50 s of worker time, so the graph's own loop is not the problem.

| What | Where |
| --- | --- |
| Control run (clean) | `run_46bfcb33-e951-4bb4-a3fd-08b39c1a71c1` — 5 nodes `completed`, terminals `verdict=PASS/GREEN/PASS` |
| Mis-rooted run | `run_ecddd871-956d-453d-b343-ecc006720144` — `cancelled`; failure bundle `~/.local/share/delegate-graph/evidence/run_ecddd871-956d-453d-b343-ecc006720144/failure-op_663faa9d-8256-4832-b512-a6390113206c.json` |
| Stale run | `run_a6a35211-1958-4a79-88dd-c192326bf434` — `runs.status='active'`, `state.updated_at=2026-09-27T13:20:51Z` |
| Stale run attempts | `runtime_attempts`: `op_f661545a` outcome `{"error":"coding settlement requires a Git base revision recorded at dispatch"}`, finished; `op_ca8e1e53` and `op_1d4e4bfa` with `outcome_json`/`finished_at` NULL |
| Stale agents | `agents`: `dg_run-a6a3_implement_67e6d0ce` / `_c4d64021` `status='running'`, `acpx_state='alive'`, `last_activity_at='2026-09-27T13:21:00Z'` |
| Store | `~/.local/share/delegate-graph/delegate-graph.db` (`runs`, `operations`, `agents`, `runtime_attempts`, `state`, `events`, `ledger_*`) |
| Ledger wrapper | `~/.pi/agent/scripts/delegate-ledger` (bash, 1335 bytes, 2026-09-20) |
| Registered package | `~/.pi/agent/settings.json:28` → `"../../projects/pi-agent-wave-new-design/extensions/pi-agent-wave"` |

## 3. Issue 1 — a run bound to a non-Git base directory fails only at settlement

### 3.1 Symptom

`collect` fails with `coding settlement requires a Git base revision recorded at dispatch`, after every
worker in the node has already done its work. Each slice then depends on the whole node, so the run is
effectively lost.

### 3.2 Evidence

- `scripts/delegate_core.py:708` — `cwd = Path.cwd().resolve()`: the worker working directory is the
  **launcher process's** cwd, inherited from the supervisor session.
- `scripts/delegate_core.py:800` — `base_revision = run(["git", "-C", str(cwd), "rev-parse", "HEAD"], check=False).stdout.strip()`;
  `:804` stores `base_dir`, `:805` stores `base_revision or None`.
- `scripts/delegate_core.py:1815-1816` — `if kind == "coding" and not resource.get("base_revision"):`
  raises, with `baseRevision` reported as `"none"` at `:1825`. Nothing compares the two before launch.
- Occurred on 2026-09-27 (`run_a6a35211`, slice `cli-overlay-write`, started 13:21:00, failed 13:23:32)
  and again on 2026-10-03 (`run_ecddd871`, slice `us000-precondition-repair`), from a supervisor session
  whose cwd was `~/.job-hunter`, which is not a Git repository.
- A `git init` in the wrong directory does **not** fix it: `:437` resolves owned paths relative to
  `base_dir` and `:830` sets `"sandbox_base": str(cwd)`, so the repository under edit stays outside the
  sandbox and the worker still cannot write to it.

### 3.3 Why this matters

It is the most expensive failure mode observed: correct work is produced and then discarded, and the
operator only learns at the end. It is also fully predictable before a single worker is launched.

### 3.4 Fix options

- **(a) Preflight refusal at plan time, recommended.** In the dispatch block, when the operation can
  yield a coding candidate and `base_revision` is empty, refuse before writing any attempt files or
  spawning a launcher, with an error naming the requirement, the resolved `base_dir`, and the remedy
  ("start the run from the repository being edited, or pass a Git working directory"). Surface it on the
  operation as a parked/failed state, not a `running` one.
- **(b) Warn only.** Cheaper, but leaves the discovery at settlement.
- **(c) Fall back to the nearest ancestor Git root.** Rejected: it silently edits a different tree than
  the caller asked for.

### 3.5 Acceptance criteria

Decision on §12 question 1: a parked operation, reached through the existing launch-failure path. The
dispatch branch in `index.ts` runs `git -C <realpath(cwd)> rev-parse --verify HEAD` for `implement`
before `init`; on failure it calls `retryRuntimeAttempt` with a `[dispatch_precondition] …` error that
`retry.ts:classifyFailure` classifies as permanent `dispatch-precondition`. The operation becomes
`failed`, the run `awaiting_user`, and `resolve retry`/`abort` apply unchanged.

- [x] Dispatch of a coding-capable operation in a non-Git `cwd` is refused **before** any worker is
  launched: no `agents` row, no `runtime_attempts` row, no attempt directory. Proof: a focused test in
  `extensions/pi-agent-wave/test/` that plans a dispatch with a temporary non-repo `cwd` and asserts a
  typed refusal plus an unchanged store; the error text names `base_dir` and the remedy.
  Evidence: `test/dispatch-git-precondition.test.ts` case "a non-Git working directory is refused
  …" asserts `blocked: "precondition"`, the realpath base dir and remedy in the reason, 0 agents, no
  runtime attempt, no new `/tmp/delegate-graph-herdr-*` directory and no `init`/`start` invocation.
  Red before the change (`actual: 'preflight'`), green after.
- [x] The refusal is visible without reading logs: the operation ends non-`running` and `op=status`
  reports it as a blocker. Proof: test assertion on the returned status payload, plus a recorded
  `op=status` on a deliberately mis-rooted throwaway run.
  Evidence: `dispatch-git-precondition.test.ts` asserts `status=awaiting_user` and
  `<op> | implement | failed | blocker=[dispatch_precondition]…`; recorded in
  `agent-output/unattended-run-reliability-20261003/throwaway-runs.json` (`issue1_status`, 915 bytes).
- [x] A run started from a Git working directory still dispatches exactly as today. Proof: the existing
  suite stays green (see §9) with no change to the control run's operation shape.
  Evidence (2026-10-03, after the fix below): `node --experimental-strip-types --test
  extensions/pi-agent-wave/test/*.test.ts` → 607 tests, 596 pass, 0 fail, 11 opt-in skips; typecheck and
  `git diff --check` clean; Bun package checks 49 pass, 0 fail. `dispatch-git-precondition.test.ts` "a Git
  working directory passes the check…" shows a Git directory reaching the launcher unchanged.
  The one earlier failure, `package-artifact.test.ts`, also failed at clean `HEAD` 67ea969: npm 11.19.0
  answers `publish --dry-run --json` as `{ "<package name>": report }`. `artifactFiles` now reads that
  shape keyed by the manifest's own name and throws on any other shape.

## 4. Issue 2 — a dead worker leaves its operation `running` forever

### 4.1 Symptom

A worker process disappears (session ended, tab closed, machine slept). The operation stays `running`,
the agent stays `status='running'`, `acpx_state` still says `alive`, and the run stays `active`. Nothing
in `next`, `status`, `watch` or `prune` ever contradicts that.

### 4.2 Evidence

- `run_a6a35211` is `active` with `state.updated_at = 2026-09-27T13:20:51Z` — six days before this
  audit. Its two unsettled `implement` operations have `finished_at` NULL and `outcome_json` NULL.
- `agents.last_activity_at` for the same workers is frozen at `2026-09-27T13:21:00Z`, while
  `agents.acpx_state` still reads `alive`. **`acpx_state` is therefore stale and must not be used as a
  liveness signal.**
- `operations` has no heartbeat column at all (columns: `id, run_id, node, slice_id, agent_id, status,
  read_only, owned_paths_json, round, fix_iteration, transient_attempts, command_json, task, verdict,
  classifier_reason, last_error, retry_not_before, created_at, started_at, finished_at, model_attempt,
  selected_model, retry_reason, fallback_reason`).
- No `acpx`, `agentfs`, `delegate_core` or `headless_supervisor` process is alive for that run, and the
  worker's Herdr tab `w1:tC` is still open.
- `watch` cannot help by construction: `product.md` documents it as read-only and *"Consulted by no
  gate."*

### 4.3 Why this matters

This is the defect that makes unattended operation unsafe rather than merely slow. A run that hangs is
indistinguishable from a run that is thinking, so the operator must poll to find out — which is the
babysitting this work order exists to remove.

### 4.4 Fix options

- **(a) Reaper at read time, recommended.** On `next`, `status` and `watch`, compute liveness for every
  operation in `running`: worker process alive (headless), attempt directory present (Herdr), Herdr pane
  still hosts an agent, and `agents.last_activity_at` within a stall bound. When the first three are
  false, or the last exceeds the bound, report the operation as `orphaned` with a reason, and expose the
  existing `resolve` verbs (`retry`, `defer`, `abort`) for it.
- **(b) Heartbeat column.** Add `operations.heartbeat_at` written by the launcher. Correct, but a schema
  migration for data the `agents` table already carries; prefer (a) until (a) proves insufficient.
- **(c) Reap only on `prune`.** Rejected: it leaves the misleading `running` state for the whole
  retention window.

### 4.4a Chosen design (2026-10-03, recorded before implementation)

Option (a), read-time and report-only. `next`, `status` and `watch` stay read-only (the `watch`
invariant in `AGENTS.md`); they report, and recovery uses verbs that already converge.

- A `running` operation whose attempt is unsettled is classified by `lib/liveness.ts` from facts on
  disk and in the process table, in this order: the worker's `worker-result.json` exists →
  `awaiting-collect`; the attempt directory (`dirname(agents.acpx_cancel_script)`) is gone →
  `orphaned`, reason `attempt-directory-missing`; no process carries the attempt's
  `agentfs run --session <agents.agentfs_session_id>` argv and the attempt began more than a 60 s grace
  ago (`agents.last_activity_at`, which `beginRuntimeAttempt` stamps) → `orphaned`, reason
  `worker-process-gone`; a process table that cannot be read → `unknown`, never `orphaned`; else
  `alive`. `acpx_state` is not read.
- `op=next` and `op=status` report such an operation's status as `orphaned` with the reason and the
  recovery hint; the stored status stays `running`. `watch` shows `orphaned (<reason>)` as its process state.
- Recovery is `op=collect` (records the attempt `failed`, as it already does when the run directory is
  gone), then `op=retry`, then `op=resolve retry|abort` once the run parks.
- **Deviation, stall bound (§12 question 2):** no stall-based reaping. `agents.last_activity_at` is
  written only at registration and settlement, never while a worker streams, so any bound on it would
  reap every healthy node longer than the bound (the control run had 17-minute nodes). A live process
  is never reaped; the timestamp is used only as the 60 s launch grace.
- **Proof correction, §4.5 last criterion:** `resolve` writes an `events` row (`resume` or `abort`), not a
  `runtime_decisions` row, which only `decideRuntimeCandidate` writes. The proof cites the events row.

### 4.5 Acceptance criteria

- [x] `op=next` and `op=status` report an operation whose worker is gone as `orphaned` (or an equivalent
  non-`running`, non-`completed` state) with a machine-readable reason, instead of `running`. Proof: a
  focused test that fabricates a stale operation plus agent row in a temporary store and asserts the
  reported state and reason.
  Evidence: `test/worker-liveness-reaper.test.ts` "status and watch report a dead worker as orphaned…"
  and "op=next reports the orphan…" (`status: "orphaned"`, `storedStatus: "running"`,
  `orphanReason: "attempt-directory-missing"`); both red before wiring, green after.
- [x] The stale state is detectable from existing data only: the same test asserts liveness is decided
  from `agents.last_activity_at` and process/pane/attempt-directory facts, and that `acpx_state='alive'`
  does **not** by itself keep an operation alive.
  Evidence: "acpx_state='alive' does not keep a worker alive…" (agent row `acpx_state='alive'` →
  `worker-process-gone` with an empty process table; inside the 60 s grace → `alive`; unreadable table →
  `unknown`; result file → `awaiting-collect`; directory gone → `attempt-directory-missing`), and "a real
  process carrying the attempt's session…" against the real `ps` table. Pane facts are not used (see
  §4.4a): a pane can outlive its worker, the process table cannot.
- [x] Reproduced against the real store: `op=status` for `run_a6a35211` now reports the two long-unsettled
  operations as orphaned rather than `running`. Proof: recorded command output (read-only).
  Evidence: `agent-output/unattended-run-reliability-20261003/status-run_a6a35211.txt`, rendered from a
  `sqlite3 -readonly … .backup` snapshot (opening `GraphStore` on the live file would run migrations):
  `op_ca8e1e53` and `op_1d4e4bfa` → `orphaned (attempt-directory-missing)`, `orphaned workers: 2`.
  `op_f661545a` stays `running`: its attempt is already settled `failed` and waits for `op=retry`.
- [x] An orphaned operation can be recovered with the documented verbs without inventing a new one.
  Proof: recorded `op=resolve` (`retry` or `abort`) on a throwaway run, plus its `events` row (corrected
  from `runtime_decisions`, see §4.4a).
  Evidence: `agent-output/unattended-run-reliability-20261003/throwaway-runs.json` (collect → `failed`
  `worker orphaned: private run directory … no longer exists`; retry → `awaiting_user`; `resolve retry`
  → `active`/`pending`; events end `operation_failed, runtime_attempt_superseded, resume`); the reaper
  test does the same with `resolve abort` and asserts the `abort` events row.
  Finding fixed on the way: with the whole private run directory gone (the real `run_a6a35211` state)
  `collect` threw `ENOENT … scandir` and could never settle; it now settles the attempt `failed` without
  invoking the launcher.

## 5. Issue 3 — `op=status` echoes the entire task text

### 5.1 Symptom

A status call returns the full task body for the current operation. For a story-shaped task that is
several kilobytes per call, and an unattended supervisor polls repeatedly.

### 5.2 Evidence

- A single `op=status` during the 3 October run returned the whole `US-000` story text, decision
  summaries and constraints — the same body stored in `operations.task` — plus the same text again under
  `current operations`.
- `operations.task` is where it comes from, and it is not truncated on the status path.
- The 3 October driver session grew to roughly 33k tokens of output and $5.36 while polling; the task
  echo is a material part of that.

### 5.3 Why this matters

Cost and context are the binding constraint on long unattended runs. A status read should be O(progress),
not O(task size) — and the task text is already available to the supervisor that submitted it.

### 5.4 Fix options

- **(a) Bound the task field on the status path, recommended.** Replace the echoed `task` with a stable
  digest plus a short preview (the answer preview precedent already exists: `index.ts:681`
  `ANSWER_PREVIEW_BYTES`), and keep the full text available behind an explicit opt-in.
- **(b) Drop `task` from status entirely.** Simplest; risks losing the only cue about what a node is
  doing.
- **(c) Leave it and document "use `watch`".** Insufficient: the supervisor still needs `status` for
  blockers and pending work.

### 5.5 Acceptance criteria

- [x] `op=status` for a run whose `operations.task` is large (≥ 8 KB, matching the tasks in the evidence)
  returns a payload below a fixed bound, and includes a task digest that matches the stored text. Proof:
  a focused test that seeds a large task in a temporary store and asserts the returned byte size and the
  digest.
  Evidence: `commands.test.ts` "status bounds a large task to a digest and preview…" seeds a ≥ 8 KB task,
  asserts status < 4096 bytes, `task sha256=<digest of stored text> bytes=<n>`, and no full-text echo.
  Red before the change (21430 bytes), green after.
- [x] The full task remains retrievable on an explicit request, and `product.md` / both READMEs document
  which call returns which shape. Proof: test plus a doc-consistency check in the existing suite.
  Evidence: `op=status` with `operationId` appends the full task (asserted in the same `commands.test.ts`
  case); package README `status` row, root README "Run from Air" paragraph and `product.md` `status`
  entry describe both shapes; `package-docs.test.ts` "documents which status call…" pins all three.
- [x] `watch` output is unchanged in shape (one line per running worker). Proof: existing `watch` test
  remains green.
  Evidence: `runtime-watch.test.ts` passes unchanged in the 2026-10-03 run; `watchRun` only replaces
  the process-state text of an orphaned worker.

## 6. Issue 4 — waits key on pane status instead of the worker's own result file

### 6.1 Symptom

An operator waiting on a worker's *pane status* waits for a condition that does not occur: a worker's
status stays `working` for the whole turn and does not become `idle`. The wrong signal makes a healthy
worker look stuck, and invites manual intervention.

### 6.2 Evidence

- `herdr agent wait w2:p2 --until idle --timeout 780000` returned `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}`
  while the worker was healthy and completed normally; `herdr agent get` reported `agent_status:
  "working"` both before and after.
- The correct signal is documented and already implemented: `watch` reads
  *"process exited[ `<code>`], awaiting collect"* **from the worker's own result file** (README,
  `watch` row; `delegate_graph` `watch` description).
- `scripts/delegate_core.py:1129` already waits on `result_path.exists()` rather than pane status
  (`:1148`, `:1232` repeat the same condition); `:1180` still issues
  `herdr agent wait … --timeout WAIT_TIMEOUT_MS`, and `:1111` documents that an
  unreadable answer "is not evidence of absence and keeps the wait going".

### 6.3 Why this matters

`watch` is the operator's window into a run. If the natural wait primitive disagrees with it, every
operator invents their own poll — as the 3 October session did — and unattended monitoring becomes
manual.

### 6.4 Fix options

- **(a) Make the result file the single settle signal, recommended.** `herdr agent wait` is used only as
  an advisory liveness probe, never as the settle condition; document the wait contract in one place and
  have `watch`, `collect` and the CLI's wait agree on it.
- **(b) Keep both and document the difference.** Leaves the trap in place.

### 6.5 Acceptance criteria

Finding while implementing: the `herdr agent wait` branch at the old `:1180` was reachable only for a
resource without `execution == "acpx-agentfs"`, and `prepare_acpx_attempt` is the only producer of
resources, so the branch was legacy-v1 residue. It is replaced by a refusal; the legacy test that pinned
it (`herdr-state-concurrency.test.ts`, "lets a blocked agent proceed…") now asserts that refusal.

- [x] No wait path uses pane/agent status as its settle condition. Proof: a focused test or a static
  assertion over `scripts/delegate_core.py` that the settle loop keys on the worker result path.
  Evidence: `herdr-worker-liveness.test.ts` case "no wait path uses pane or agent status as its settle
  condition" (no `"agent", "wait"` argv, no `agent_status`, settle loop on `result_path.exists()`); the
  HEAD source has 3 matches for those patterns, so the case fails there.
- [x] A worker that has written its result is reported settled even while its pane still reads `working`.
  Proof: recorded `op=watch` output on a run in that state (the 3 October run passed through it).
  Evidence (authorized live run, 2026-10-03 07:42 EEST): one real Herdr worker
  (`run_6ed41ab6-7ec7-4aeb-b143-bb32f5be3a68`, research `thinker_split`, `alibaba/qwen3.8-flash`), not
  collected until its turn ended. At 04:42:37Z `op=watch` read `process exited, awaiting collect` while
  `herdr agent get <pane>` answered `agent_status: "working"` and the stored attempt was still `running`;
  `collect` then settled it `exited` with a research candidate, 0 post-settlement failures, and its tab
  was closed. Record: `agent-output/unattended-run-reliability-20261003/live-watch-awaiting-collect.json`;
  scratch root removed, no tab or process of the run left. The driven test "a live pane keeps the wait
  going…" covers the same state.
- [x] The wait contract is stated once in the package README and matches `watch`'s wording. Proof: doc
  check in the existing suite.
  Evidence: README "Wait contract" paragraph; `package-docs.test.ts` case "states the wait contract
  once, in watch's own wording" passes.

## 7. Issue 5 — the `delegate-ledger` wrapper cannot resolve a relative package path

### 7.1 Symptom

The wrapper prints
`delegate-ledger: no loaded package provides scripts/story-ledger.mjs (set PI_AGENT_WAVE_ROOT)` and does
not run, even though the package is registered and the script exists. Because the ledger itself is
written by the runtime, the warning reads as "the ledger was lost" while rows are in fact present.

### 7.2 Evidence

- `~/.pi/agent/scripts/delegate-ledger:22` builds its candidate roots with
  `grep -o '"[^"]*"' "$agent_dir/settings.json" | tr -d '"' | grep '^/'` — it keeps only **absolute**
  quoted paths.
- `~/.pi/agent/settings.json:28` registers the package as **relative**:
  `"../../projects/pi-agent-wave-new-design/extensions/pi-agent-wave"`. `grep '^/'` discards it, so the
  loop finds no root and falls through to the warning at line 31.
- The script is otherwise present and correct: `:26-27` execs
  `node --experimental-strip-types "$root/scripts/story-ledger.mjs"`.
- The ledger is not lost: a `ledger_entries` row set exists for `us-000-repair-suite-failures`
  (`run_46bfcb33-e951-4bb4-a3fd-08b39c1a71c1`) alongside `ledger_claims` and `ledger_aggregates` — the
  wrapper's own header states the ledger "is the graph store, not a file", and the runtime writes it.
- The JSON `packages` array is parsed by regex rather than as JSON, so any future formatting change
  (arrays on one line, comments, trailing commas) changes the candidate set silently.

### 7.3 Why this matters

The warning is emitted into the supervisor's stream during exactly the long unattended runs where the
ledger matters, and it is indistinguishable from a real failure to record evidence. An operator acting on
it will attempt manual ledger recovery that is not needed.

### 7.4 Fix options

- **(a) Resolve roots correctly and warn only when the ledger is genuinely missing, recommended.**
  Resolve each candidate against `$agent_dir` before testing for the script (and prefer parsing the
  `packages` array as JSON). When no root carries the script, keep the warning; when a run's ledger rows
  already exist, do not warn.
- **(b) Set `PI_AGENT_WAVE_ROOT` in the environment instead.** A workaround, not a fix; it makes every
  operator responsible for the wrapper's bug.
- **(c) Have the runtime stop printing the wrapper's message.** Hides the resolution failure.

### 7.5 Acceptance criteria

- [x] `delegate-ledger read us-000-repair-suite-failures` exits 0 on this machine and prints no
  resolution warning, with `settings.json` unchanged. Proof: recorded command and exit code.
  Evidence (2026-10-03): run from `/tmp`, `exit=0`, stderr empty, 7704 bytes of `ledger_read` JSON for
  `run_46bfcb33…`; `settings.json` not edited (its pre-existing uncommitted diff is not from this work).
- [x] A focused test drives the wrapper against a temporary `settings.json` whose `packages` entry is
  relative and asserts it execs the discovered `story-ledger.mjs`; and against one with no matching
  entry and asserts the warning is still printed. Proof: test file output.
  Evidence: `~/.pi/agent/tests/delegate-ledger-wrapper.test.ts`, `npx -y bun@1 test` → 2 pass, 0 fail;
  against the pre-fix wrapper the relative case fails (1 pass, 1 fail). Bun is not installed on this
  host, so the run used `npx bun@1`.
- [x] The wrapper's root discovery is documented in the package README as "absolute or relative to the
  agent directory". Proof: doc check in the existing suite.
  Evidence: README "Story ledger" section; `package-docs.test.ts` case "documents how a ledger wrapper
  discovers the story-ledger script" passes (9/9 in that file).

Decision on §12 question 3: the wrapper stays in the Pi agent scaffold (`~/.pi/agent`, its own Git
repository), fixed in place; it parses `packages` as JSON and resolves each local entry against the
agent directory. **Superseded 2026-10-03 by the operator:** the wrapper lives in pi-agent-wave with an
install step (§7.6).

### 7.6 Follow-up: the wrapper moves into the package (2026-10-03)

The package ships the wrapper and installs a launcher for it, so nothing has to discover the package
from `settings.json`.

- `scripts/delegate-ledger` (shipped; added to `files`): a POSIX `sh` script that runs
  `node --experimental-strip-types <its own directory>/story-ledger.mjs "$@"`.
- `scripts/install-ledger.mjs` (bin `pi-agent-wave-install-ledger`): installs
  `<agent dir>/scripts/delegate-ledger`, a mode-755 launcher that `exec`s the package's wrapper by its
  single-quoted absolute path. Agent dir from `--agent-dir`, `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.
  `dry-run` is the default and writes nothing; `apply` creates the launcher, is a no-op when the bytes
  already match, and refuses a differing file unless `--force`; every write first records a backup
  through `lib/safe-write.mjs` (a created file as `existed: false`), and `rollback --manifest` restores
  the previous bytes and mode or removes a created launcher. It is separate from `pi-agent-wave-init`
  because that command's `--force` would also overwrite `model-routing.jsonc`.
- Applied to the real `~/.pi/agent` on 2026-10-03 with the operator's explicit authorization:
  `install-ledger.mjs apply --force` replaced `main`'s committed wrapper (SHA-256 `ec1485e10776…`, mode
  755), backed up in `migration-backups/pi-agent-wave-init/2026-10-03T04-55-16-970Z/manifest.json`
  (status `applied`, same SHA-256). After it, `delegate-ledger read us-000-repair-suite-failures`
  exits 0 with 6 entries and empty stderr, `audit` exits 0, and a second `apply` reports `no-change`.
  Output: `agent-output/unattended-run-reliability-20261003/install-ledger-apply-real-agent.json`.
- The `~/.pi/agent` copy is retired: its `delegate-ledger-relative-roots` branch (commit `6c85ec3`,
  the relative-root fix and `tests/delegate-ledger-wrapper.test.ts`) was deleted and that repository
  returned to `main`.

Acceptance criteria:

- [x] A focused test in a temporary agent directory: `dry-run` writes nothing; `apply` creates an
  executable launcher that runs the package's `story-ledger.mjs` against a temporary
  `DELEGATE_GRAPH_DB` (`read` exits 0 with the store's JSON); a second `apply` reports no change; a
  differing file is refused without `--force`, replaced with `--force`, and `rollback` restores its exact
  bytes and mode; `rollback` of a fresh install removes the launcher.
  Evidence: `test/ledger-install.test.ts`, 3/3 pass; all three failed before the installer existed.
  The first apply also exposed that `lib/safe-write.mjs` refused to back up any path outside
  `model-routing.jsonc` and `fzf.json`; `scripts/delegate-ledger` was added to that restore allowlist.
- [x] The packed artifact contains `scripts/delegate-ledger` and `scripts/install-ledger.mjs`, and the
  manifest declares the new bin. Proof: `package-artifact.test.ts` and `package-manifest.test.ts`.
  Evidence: both pass; `npm pack --dry-run` lists 84 entries with `scripts/delegate-ledger`,
  `scripts/install-ledger.mjs` and `scripts/story-ledger.mjs` at mode 755.
- [x] The package README documents the install step and replaces the `settings.json` discovery text.
  Proof: `package-docs.test.ts`.
  Evidence: "documents the ledger command and its install step" passes and asserts
  `PI_AGENT_WAVE_ROOT` no longer appears.
- [x] A dry run against the real `~/.pi/agent` shows the planned replacement without writing. Proof:
  recorded output, and the file's hash unchanged.
  Evidence: `agent-output/unattended-run-reliability-20261003/install-ledger-dry-run-real-agent.json`
  (`action: "replace"`, `ok: true`); SHA-256 `8f892067…1f59706` before and after; no backup created.
  Gate on this tree: 610 Node tests, 599 pass, 0 fail, 11 skips; typecheck, `git diff --check` clean;
  Bun package checks 49/49.

## 8. Issue 6 — orphaned Herdr tabs survive a run that never settles

### 8.1 Symptom

A worker tab stays open after its run stops making progress and after the run is abandoned. During the
audit, `herdr tab list` still showed `w1:tC`, labelled
`run_a6a35211-1958-4a79-88dd-c192326bf434-op_1d4e4bfa-…: implementer [auto] @ deepseek-v4.1-flash`, for a
run idle since 2026-09-27.

### 8.2 Evidence

- Tab closing is implemented: `scripts/delegate_core.py:238` runs `["herdr", "tab", "close", tab_id]`,
  and `:1578` `abort_acpx_attempt(..., tab_closer=close_created_tab, ...)` wires it into abort.
- It runs only on a path that settles an attempt. For `run_a6a35211` the two unsettled `implement`
  operations never reached abort or collect, so their tabs were never closed — the same events that
  leave the operation `running` (Issue 2).
- A clean run does close its tabs: the 3 October run created `w2:t5`–`w2:t9` for its five workers and
  none of them remain in `herdr tab list`.
- `product.md` and the README already define the cleanup sweep and its evidence inventory
  (`cleanup_absence_inventory`, `scripts/delegate_core.py:1651`), so the inventory exists but is never
  consulted for a run nothing settles.

### 8.3 Why this matters

Tabs accumulate into an unreadable workspace, and each orphan is a live reminder of a run whose state no
longer matches reality. It also obscures the operator's own tabs, which is how the audit found it.

### 8.4 Fix options

- **(a) Close tabs as part of reaping, recommended.** When Issue 2's reaper marks an operation orphaned,
  or a run reaches `cancelled`/`terminal`, close the worker tabs recorded in `agents.tab_id` for that
  run and report the result the way `cleanup_absence_inventory` already does. Depends on Issue 2.
- **(b) Close tabs on `prune` only.** Cheap but leaves the workspace wrong for the retention window.
- **(c) Add a manual `herdr tab close` step to the docs.** Not acceptable: it re-introduces babysitting.

### 8.5 Acceptance criteria

Decision on §12 question 4: reaping closes the tab. Reaping is read-only (§4.4a), so the close happens
where the orphan is settled: `collect`'s orphan path. The run-end sweep runs after `decide`, `resolve`,
`cancel` and the agent list's cancel-all. Ownership is checked twice: the id must be in this run's
`agents.tab_id`, and the listed label must still start with `<runId>-`, because Herdr reuses tab ids.

- [x] After a run is cancelled or reaches `terminal`, no `agents.tab_id` for that run still appears in
  `herdr tab list`. Proof: recorded `herdr tab list` before and after on a throwaway run, plus a focused
  test that asserts the closer is invoked for every recorded tab.
  Evidence: `agent-output/unattended-run-reliability-20261003/herdr-live-tab-cleanup.json`: real Herdr,
  two throwaway tabs `w3:t2`, `w3:t3` labelled with the run id; 2 listed during, 1 after `collect`,
  0 after `resolve abort` (run `cancelled`), operator tabs identical before and after; an independent
  `herdr tab list` afterwards shows only `w3:t1` in that workspace. Test: `run-tab-cleanup.test.ts`
  "closes every recorded tab…" asserts a close call for each recorded tab of the run.
- [x] Reaping an orphaned operation closes its tab and reports the outcome in cleanup evidence. Proof:
  test output plus the cleanup evidence path for that operation.
  Evidence: `run-tab-cleanup.test.ts` "collecting an orphan closes its tab…" asserts
  `tabCleanup: [w1:tB closed]` and an existing `cleanupEvidencePath`
  (`evidence/<runId>/tab-cleanup-<operationId>.json`) whose record says `closed`; removing the sweep from
  `resolve` fails it. The live record above carries the same path for `w3:t2`.
- [x] A tab that the run did not create is never closed. Proof: a test that records a pre-existing tab id
  and asserts it is untouched (the cleaner must act only on rows it created).
  Evidence: the same unit test keeps `w1:t1` (never recorded) and `w1:tD` (recorded id, now another
  run's label → `not-owned`) open; the tool test keeps the operator's `w1:t1`.

## 8a. Issue 7 — a worker that disappears is classified by transport and timing

### 8a.1 Symptom

The same event — a worker gone before writing its result — is transient on one path and permanent on
the others, so whether `op=retry` replaces the worker or parks the run for the operator depends on the
transport and on when the death is noticed, not on what happened.

### 8a.2 Evidence

`retry.ts:classifyFailure` run on the four messages the code produces for that event (2026-10-03):

| Where the death is noticed | Message source | Classification |
| --- | --- | --- |
| headless, during the wait | `scripts/delegate_core.py:wait_for_settled_agent` `headless worker exited before result` | `transient` / `worker-exited-before-result` |
| Herdr, attempt directory gone during the wait | same function, `Herdr worker attempt directory removed before result` | `permanent` / `unclassified` |
| Herdr, agent gone during the wait | same function, `Herdr worker no longer registered before result` | `permanent` / `unclassified` |
| any transport, at `collect` (reboot, `/tmp` sweep) | `index.ts:collectRuntimeAttempt` `worker orphaned: private run directory … no longer exists` | `permanent` / `unclassified` |

The last row is what `run_ab8675e8` produced when rehearsed on a copy of the store
(`agent-output/durable-worker-record-20261003/zombie-rehearsal-*.json`): `retry` → `awaiting_user`,
classification `unclassified`. A permanent failure goes straight to `awaiting_user`
(`store.ts:retryRuntimeAttempt`); no budget is spent and the frozen chain is never consulted.

### 8a.3 Why this matters

The asymmetry has no rationale in the code: none of the three Herdr/collect messages was deliberately
made permanent, they simply match no pattern and fall through to `unclassified`. Its effect is that a
reboot, a closed tab or a crashed Herdr server always needs the operator, while the identical headless
death does not. `AGENTS.md` already treats "exit without a candidate" and connection loss as transient;
a worker that vanished entirely is the same class of infrastructure failure.

### 8a.4 Fix options

- **(a) Classify every "worker gone before its result" message as transient, recommended.** One
  pattern, reason `worker-gone`; the headless message keeps its existing reason so nothing pinned to it
  moves. A worker that kills itself deterministically is bounded by the budget that already bounds the
  headless case: three same-model attempts, then the frozen chain, then `retry_exhausted` →
  `awaiting_user`.
- **(b) Make all four permanent.** Consistent, but turns every headless worker crash into an operator
  decision, which is the babysitting this work order exists to remove.
- **(c) A dedicated budget for orphans.** Rejected: a second counter for a failure class the existing
  budget already bounds.

### 8a.5 Chosen design (2026-10-03, recorded before implementation)

Option (a). `retry.ts:TRANSIENT_PATTERNS` gains `worker-gone`, matching
`attempt directory removed before result`, `no longer registered before result` and a message that
starts `worker orphaned:`. No message text changes, no new verb, no schema change.

What this does and does not buy, stated so it is not over-read: `op=retry` is still the only path that
applies the classification, so a worker lost to a reboot is replaced only when a supervisor calls
`collect` and `retry`. The change removes the *operator* from that loop while budget remains; it does
not make anything run while no supervisor session exists. A worker that is deliberately stopped by
closing its tab is now retried rather than parked; the documented way to stop a worker remains
`op=cancel` (or the agent list's Escape), which is not a retry path.

Two existing tests used the orphan as a shortcut to a parked run (`worker-liveness-reaper.test.ts`,
`run-tab-cleanup.test.ts`). They keep their `resolve abort` coverage by seeding the operation with its
transient budget already spent (`transient_attempts = 3`, a one-model chain), so `retry` parks the run
by exhaustion — the state in which the operator legitimately decides.

### 8a.6 Acceptance criteria

- [x] All three Herdr/collect messages classify `transient` / `worker-gone`, and the headless message
  keeps `worker-exited-before-result`. Proof: `test/retry.test.ts`, red before the pattern is added.
  Evidence: "a worker gone before its result is transient whichever transport noticed it, and
  whenever" failed before the `retry.ts` pattern (1 fail of 24) and passes after (24 of 24).
- [x] A first orphan's `retry` replaces the worker instead of parking the run: operation `pending`,
  run `active`, classification `worker-gone`, `retry_not_before` set. Proof:
  `test/worker-liveness-reaper.test.ts`, red before the change.
  Evidence: "op=next reports the orphan, collect settles it failed, and retry replaces the worker
  without parking the run" failed before with `actual: 'unclassified', expected: 'worker-gone'` and
  passes after; it also asserts `transient_attempts: 1`.
- [x] An orphan whose transient budget is spent still parks the run (`retry_exhausted` →
  `awaiting_user`) and `resolve abort` still records its `events` row. Proof: the same file, seeded
  with `transient_attempts = 3`.
  Evidence: "an orphan whose transient budget is spent parks the run, and resolve aborts it with an
  events row" failed before on the `retry_exhausted` assertion (the park was recorded as
  `operation_failed`) and passes after with both the `retry_exhausted` and `abort` rows.
- [x] `run-tab-cleanup.test.ts` still proves the tab sweep on `resolve abort`, reached by exhaustion.
  Evidence: 3 of 3 pass, seeded at `transient_attempts = 3`. This test keeps the sweep covered; it
  does not distinguish the classification change (with the seed it parks either way), which the two
  reaper tests above do.
- [x] `AGENTS.md`, `product.md`, `specification.md` §4.1 and `extensions/pi-agent-wave/README.md` list
  the new transient reason.
  Evidence: each names "a worker gone before its result"; the spec names `worker-gone` and its three
  message forms.
- [x] Full Node suite, `npm run typecheck` and `git diff --check` green.
  Evidence (2026-10-03, uncommitted tree on `c096e4a`): `node --experimental-strip-types --test
  extensions/pi-agent-wave/test/*.test.ts` exit 0, 619 tests, 608 pass, 0 fail, 11 skipped (opt-in);
  `npm run typecheck` exit 0; `git diff --check` clean. Logs:
  `agent-output/durable-worker-record-20261003/gate-node-suite.log`, `gate-typecheck.log`. The Bun
  package checks named in `AGENTS.md` were **not run**: Bun is not installed on this host (not on
  `PATH`, no `~/.bun`, not found by Spotlight). `package-docs.test.ts` passes under Node through the
  `test-api.mjs` shim (11 of 11), which is not a substitute for the Bun run.

## 9. Sequencing, ownership and verification

Do them in this order; each is independently reviewable.

1. **Issue 5** — smallest, no behavioural risk, and it removes a false alarm from every future run.
2. **Issue 1** — a refusal added before launch; no new state.
3. **Issue 4** — align the wait contract on the signal that already exists.
4. **Issue 3** — a bounded status payload; touches the supervisor's read path.
5. **Issue 2** — the reaper; this is the load-bearing change and the one to review hardest.
6. **Issue 6** — depends on 2 for the reap path; the cancel/terminal path stands alone.

**Source ownership.** `extensions/pi-agent-wave/scripts/delegate_core.py` and
`extensions/pi-agent-wave/scripts/herdr_delegate.py` own the dispatch, wait and cleanup changes (Issues
1, 2, 4, 6). `extensions/pi-agent-wave/index.ts` owns the status payload and the reaper's reporting
surface (Issues 2, 3). `~/.pi/agent/scripts/delegate-ledger` is outside this repository — Issue 5 needs
either a tracked copy here plus an install step, or a decision to keep it out of scope (see §12). One
writer per file; the six issues touch overlapping files, so they are sequential slices, not parallel
ones.

**Verification.** The repository has no root `package.json`; run from the repository root:

- `npm run typecheck --prefix extensions/pi-agent-wave`
- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` (the suite named in
  `AGENTS.md`)
- `npm run test:acpx --prefix extensions/pi-agent-wave` where the change touches the worker matrix

Every claim in a completion report must cite the command and its decisive output. A store evidence
query is a legitimate proof for the store-facing criteria; a screenshot of a tab is not.

## 10. Non-goals

- Replacing `runtime-v1`, its acceptance model, or the graph topology.
- Changing model policy, route selection, retry budgets or the fix/round caps.
- Adding a new operator verb where `resolve` (`retry`, `defer`, `abort`, `escalate`) or `cancel` already
  covers the case.
- Pruning or migrating existing runs; `run_a6a35211` stays in the store as evidence.
- The verdict-format and default-timeout findings in §11.

## 11. Related findings deliberately not in this work order

Surfaced by the same audit, and **not** covered by Issues 1–6 above:

- **Verdicts are parsed from answer text.** `extensions/pi-agent-wave/index.ts:681-712` extracts the
  verdict with `/^\s*VERDICT:\s*([A-Z_]+)\s*$/gm` (`:708`) from the last 4 KB of the retained answer
  (`:682`, `:702`), and
  `graph-core.ts:97-140` gates every edge on it (`review`: `PASS|FAIL`, `test`: `GREEN|NOT_OK`, `audit`:
  `PASS`, `source_search`: `DONE|BLOCKED`); anything else parks the run as
  `unsupported … verdict <x>`. `decisionBrief` then hands the supervisor a repair placeholder when the
  line is missing. This is the documented subject of `tasks/intake-runtime-owned-results.json` —
  *"report formatting cannot discard work or spend another model turn"*, and `design-autonomous-swarms.md:132`
  records that the guarded foundation is implemented while the wiring and acceptance remain pending.
  It belongs to that intake, not here.
- **The settle bound defaults to one hour.** `scripts/delegate_core.py:40`
  (`PI_DELEGATE_WAIT_TIMEOUT_MS`, default `3600000`, documented at README:180) with no stall trip for a
  worker that stays registered and present while producing nothing; `:1111` states the position. Issue 2's
  reaper is a prerequisite for a short stall bound, so decide the bound there rather than twice.

## 12. Open questions

1. For Issue 1, should the refusal be a hard error at `op=next`/dispatch, or a parked operation the
   operator can `resolve`? A hard refusal is clearer; a park preserves the ability to inspect what would
   have been launched.
2. For Issue 2, what stall bound? The reaper's accuracy depends on it, and the 3 October control run had
   nodes running 5–17 minutes, so a bound below the longest legitimate node would reap healthy work.
3. For Issue 5, does `~/.pi/agent/scripts/delegate-ledger` belong in this repository (with an install
   step) or in the Pi agent scaffold? Its bug is real in either case, but the fix lands in different
   places.
4. For Issue 6, should reaping close tabs at all, or leave them for a human to inspect? The 3 October
   control run's tabs were closed on settle, so closing on reap is consistent; but a reaped worker may be
   the only evidence of what it was doing.