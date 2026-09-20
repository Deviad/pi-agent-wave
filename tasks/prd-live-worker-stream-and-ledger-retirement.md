# PRD: Live worker stream visibility and ledger retirement

**Status:** open — plan of record
**Recorded:** 2026-09-20
**Carries forward:** the still-open criteria of `tasks/prd-delegated-write-slice-settlement.md` — the US-001
case for an owned empty directory, the US-003 `agentFsMountAbsent` case, the US-004 concurrent-writer
sequence case, and US-004 slice 3 (the `delegate-ledger` retirement). They are restated here as US-004 and
US-005 and are tracked in this document from now on. That document keeps the work it completed; this one
owns what remains.

## 1. Overview

Three things are wrong with how a running worker is observed and recorded, and one old task is unfinished.

**The live view reads a file.** Both readers of a worker's stream open
`<attempt_dir>/runtime-output/worker.stdout.ndjson`: `agent-list.ts` (through `streamPathFor`, which
returns the path only when `existsSync` holds) and `index.ts:366` for the watch path. That file is an
indirection around a source that already exists — `scripts/acpx-worker.ts:138-141` spawns ACPX with a pipe
and tees its stdout to the worker's own stdout, then renders it for a TTY at line 204, and the launcher
execs with no redirection. The pane therefore already carries the stream directly from the agent.

**The failure path keeps an unbounded copy of it.** `retain_incomplete_capture` copies the whole raw
stream (capped only by the 16 MB `RuntimeOutputFiles` stdout limit) whenever an attempt had an incomplete
capture or produced no candidate. Nothing automated reads the result: it surfaces as
`captureRetainedPath`, and `runtime-measure.ts` logs it as a note. It exists because the 2026-09-12
operations smoke 3 lost a candidate-less synthesis attempt with nothing to diagnose it from.

**Headless has no live view at all, and Windows has no path.** A planned worker with no pane cannot be
watched except through that file.

**The old task.** `~/.pi/agent/scripts/delegate-ledger` resolves `scripts/ledger.ts` from the package
`settings.json` loads, and that file does not exist — it was deleted with the `legacy-v1` report contract
it validated. The store now holds the record instead: schema v12's `ledger_entries`, `ledger_claims` and
`ledger_aggregates`, readable through `recordLedgerEntry`, `storyLedger` and `auditStoryLedger`.

## 2. Goals

- A retained capture is a bounded diagnostic tail, not a copy of a stream.
- No display path reads a stream file; Herdr renders from the pane.
- Headless has a live stream channel whose mechanism is portable to Windows by construction.
- The `delegate-ledger` workflow writes through the store, and no file ledger is produced.
- Every carried criterion is closed or explicitly retired.

## 3. User Stories

### US-001: A retained capture is a bounded tail, not a stream copy

**Description:** As an operator, I want a failed attempt's stream kept as a diagnostic window, so that a
stream is not copied wholesale into durable storage.

**Acceptance Criteria:**

- [x] `retain_incomplete_capture` (`delegate_core.py:1703`) retains a bounded tail using the windows
      already in that file — `FAILURE_DIAGNOSTIC_EVENT_LIMIT` events and `FAILURE_DIAGNOSTIC_STDERR_BYTES`
      of stderr — instead of copying the source bytes. Proof: a test in
      `test/runtime-lifecycle-python.test.ts` asserting the retained file's size is bounded and that it
      carries the final events of the source.
      Evidence: `_stream_tail` retains the last `FAILURE_DIAGNOSTIC_EVENT_LIMIT` lines, each capped at
      `FAILURE_DIAGNOSTIC_EVENT_CHARS` and redacted; the test "an incomplete capture retains a bounded tail
      of the worker's stream" writes five windows' worth of events and asserts the retained file has exactly
      one window of lines, is smaller than the source, and spans the source's final events.
- [x] A complete capture with a candidate still retains nothing. Proof: the existing clean-case branch of
      `test/runtime-lifecycle-python.test.ts:174` continues to assert `retain_incomplete_capture` returns
      `None`.
      Evidence: the same test's `cleanRetained` assertion is unchanged and passes.
- [x] A clean settle with no candidate produces a failure bundle, so the tail is never the only artifact.
      Proof: a test asserting a `failure-<operationId>.json` exists under the store's run diagnostics for
      an attempt that settles without a candidate.
      Evidence: `settle_runtime_attempt` calls `write_failure_diagnostics(resource, "attempt settled without
      a candidate")` whenever the settlement evidence carries no candidate, and reports it as
      `diagnosticsPath`, which `finalizeRunDirectory` already retains under `evidence/<runId>/`. The test
      "a clean settlement that retains no candidate still writes a failure bundle" asserts
      `failure-op-candidate-less.json`, mode 600, its reason, and that it carries the worker stderr the
      bounded tail does not.
- [x] The reported name and the reaper are unchanged: `captureRetainedPath` still names a file removed by
      `finalizeRunDirectory`/`prune`. Proof: `test/run-directory-finalization.test.ts` still passes with
      its byte-exact capture assertion adjusted to the bounded shape.
      Evidence: the retained name is still `runtime-capture-<agent>.ndjson` in the run directory;
      `test/run-directory-finalization.test.ts` passes unchanged (11/11 with `acpx-collect-convergence`),
      so its byte-exact assertion needed no adjustment.

### US-002: The live view reads the agent's terminal, not a stream file

**Description:** As an operator watching a run, I want the view to show the worker's live output, so that
what I read is the agent rather than a file it happens to write.

**Acceptance Criteria:**

- [x] `streamPathFor` (`agent-list.ts:150`) and the watch reader (`index.ts:366`) read the pane when
      `agents.herdr_pane_id` is set, using `herdr pane read <pane_id> --source recent --lines N`
      (`herdr.ts:122` already shells out to `herdr pane get`, so this adds no new dependency). Proof: a
      test that deletes the stream file and asserts the details view and the watch view still render
      content from a stubbed pane read.
      Evidence: both readers were replaced by `paneLines()` over the one reader in `lib/pane-read.ts`,
      which runs `herdr pane read <pane_id> --source recent --lines N --format text`. In
      `test/runtime-watch.test.ts`, "op=watch renders what each running worker is doing from its own
      terminal" deletes the stream file and asserts the watch view still reports the pane's last line,
      and "number selection shows attempt-bound live and retained details" does the same for the detail
      view. Both also write decoy text into the stream file and assert it never appears.
- [x] No display path opens `<attempt_dir>/runtime-output/worker.stdout.ndjson`. Proof: the same test,
      plus a grep-shaped assertion that `agent-list.ts` and `index.ts` contain no reader of that path.
      Evidence: "no display path contains a reader of the worker's stream file" asserts neither file
      names `worker.stdout.ndjson` nor carries a `readTail`, and that both call `paneLines(`.
- [x] A worker with no pane does not fall back to the stream file. Proof: a test asserting no display
      path reads the file with `herdr_pane_id` null.
      Evidence: "a worker with no terminal never reads the worker's stream file" registers a headless
      worker, writes a renderable stream file, and asserts the detail view shows none of the file's text
      and performs no pane read at all.
      **Amended by US-006 (2026-09-20):** this criterion originally required an explicit "no terminal"
      note for the no-pane case. The live research run of section 3c then showed the cost of stopping
      there - on the default transport the live view showed nothing at all (6 `op=watch` samples, 0
      carrying any activity, against 30/30 and 12/12 in earlier headless runs) while the US-003 endpoint
      was publishing a working stream. A headless worker's view now reads its published stream per US-006,
      so no "no terminal" note exists: the only note for such a worker is that it publishes no stream.
- [x] The wording stops describing the live sink as retained: `agent-list.ts` currently says
      `"(no stream retained for attempt)"`. Proof: the same null-pane test pins the replacement text.
      Evidence: `NO_TERMINAL_NOTE` is "(this worker's transport has no terminal; there is no live view
      for it)", pinned by the same test; the list row says `(no terminal)` rather than `(no stream)`.

**Also removed here:** `summarizeAcpxStream` in `lib/acpx-render.ts` had no caller once both display paths
stopped parsing the capture file, so it and its test case were deleted. `AcpxRenderer` stays: it is what
renders into the pane the views now read.

### US-003: Headless publishes a live stream on a portable endpoint

**Description:** As an operator running a headless worker, I want its stream available without reading a
file, on a mechanism that can support Windows later.

**Acceptance Criteria:**

- [x] One resolver decides the endpoint, with a per-platform default, mirroring the precedent
      `AGENTS.md` sets for `agent_for_model()`, `agentForModel()` and `selectAcpAgent()` agreeing with a
      test pinning them. Proof: a test asserting the resolver's output for each supported platform.
      Evidence: `resolve_stream_backend()` in `scripts/stream_endpoint.py` is the only chooser, used by
      both the supervisor and the preflight. `test/stream-endpoint.test.ts` pins it for Darwin, Linux and
      Windows (all `loopback-tcp`) and asserts an unsupported platform raises by name.
- [x] The default backend is a loopback TCP listener bound on `127.0.0.1` with an ephemeral port, carrying
      a per-attempt bearer token written mode 600 into the attempt directory. Proof: a test asserting a
      connection without the token is refused and one with it receives the stream lines already emitted.
      Evidence: the same test asserts host `127.0.0.1`, a non-zero assigned port, token mode `0o600`, that
      a connection presenting the wrong token receives `unauthorized` and no worker output, and that a
      connection presenting the token receives the line emitted before it connected (`first line`) and
      then the line emitted while connected (`second line`). The driver uses a real supervisor process, a
      real listener and a real socket.
- [x] The listener is owned by `headless_supervisor.py`, which is the outermost host-side process and
      already drains the worker's stdout for the attempt's lifetime (`delegate_core.py:836`,
      `"headless_stdout"` at `:920`). Proof: a test asserting the endpoint exists while the supervisor
      runs and is gone after it exits.
      Evidence: `StreamPublisher` is constructed and closed inside `headless_supervisor.py:main`; the test
      asserts the endpoint is connectable mid-run and that after the supervisor exits the connection is
      refused and both the token and endpoint descriptor are removed.
      **Defect found and fixed here:** the supervisor drained with `stream.read(8192)`, which blocks until
      the buffer fills or the worker exits, so neither the capture file nor the live channel advanced while
      the worker ran. Draining is now line-oriented.
- [x] Binding is probed before dispatch and failure is a named blocker, mirroring `assertUsableRunRoot`.
      Proof: a test asserting the blocker text on a bind failure.
      Evidence: `launch_headless_worker` calls `probe_stream_endpoint()` before `Popen`. The test forces
      `socket.bind` to raise EPERM — the error the restricted host actually returns — and asserts the text
      `live worker stream unavailable: cannot bind a loopback listener on 127.0.0.1 (EPERM)`, that dispatch
      fails with that same text, and that no worker process is started.
- [x] Nothing is retained by this channel: it is a live stream with no replay and no artifact. Proof: a
      test asserting no file is created for the endpoint beyond the token.
      Evidence: the test asserts the run directory after exit holds only the launcher, the fixture gate,
      and the capture path's `status.json`, `stderr` and `stdout`; the token and endpoint descriptor are
      gone. A late subscriber gets a bounded in-memory window (`STREAM_BACKLOG_LINES`), never a replay file.
- [x] The three Windows gates are recorded as gates, not solved here. Proof: this PRD's §5 and §6, plus a
      note in the package README that Windows is unsupported until they are addressed.
      Evidence: the "Watching a worker" section of `extensions/pi-agent-wave/README.md` names all three
      (`script` absent on Windows, `doctor.mjs` accepting only `darwin`/`linux`, AgentFS needing FUSE and
      Linux mount namespaces) and states Windows is unsupported until they are addressed.

### US-004: The delegate-ledger writes through the store and the file ledger retires

**Description:** As a user of the evidence-ledger workflow, I want one writer for a story's execution
record, so that the rule I follow cannot reference a script that does not exist.

**Acceptance Criteria:**

- [x] The supervisor's ledger write goes through the store's `recordLedgerEntry` and produces
      `ledger_entries` rows. Proof: a test asserting the rows appear for a story and that no
      `agent-output/<story>/delegate-ledger/*.json` is created.
      Evidence: `scripts/story-ledger.mjs` is the command surface and writes only through the store. The
      test "the command surface writes through the store and audits from it, creating no ledger file"
      runs the command, reads the entry, claim and aggregate back through `storyLedger`, and asserts no
      `delegate-ledger` directory and no ledger JSON file exist beside the store.
- [x] `audit` reads the store and recomputes the aggregate from its components, reporting
      `AGGREGATE_MISMATCH`. Proof: `test/story-ledger.test.ts`'s existing aggregate case, exercised
      through the CLI surface rather than the store API directly.
      Evidence: the same test writes `criteria met::9::10::100` through the command and asserts `audit`
      exits 2 with one `AGGREGATE_MISMATCH` reading "recorded 100, computed 90" - the exact defect the
      supervisor rules name.
- [x] `~/.pi/agent/scripts/delegate-ledger` no longer resolves a package script that does not exist.
      Proof: running it against a story exits zero, its output names the store, and the file contains no
      `scripts/ledger.ts` lookup. The wrapper is the user's own file; this PRD records the change because
      the user owns it.
      Evidence: before the change the wrapper printed "no loaded package provides scripts/ledger.ts" - it
      resolved nothing, because no `ledger.ts` exists in the loaded package or anywhere else. It now
      resolves `scripts/story-ledger.mjs`; run against a real story it wrote sequence 1 and audited clean
      at exit 0, naming the store path in both outputs. `grep -c "ledger.ts"` on the wrapper is 0.
- [x] The evidence-ledger rule in `~/.pi/agent/AGENTS.md` names the store instead of the wrapper's script
      resolution. Proof: the rule text, currently reading "the wrapper resolves `scripts/ledger.ts` from
      whichever package `settings.json` loads", is updated in the same change.
      Evidence: the rule now gives the command's real argument shape, states the record lives in
      `ledger_entries`/`ledger_claims`/`ledger_aggregates` and that no file ledger is produced, and names
      `scripts/story-ledger.mjs`. A second stale reference in the rules-maintenance rule was corrected
      too; `grep -c "ledger.ts"` on that file is 0.
- [x] No file-ledger machinery is reintroduced into the package: no `ledger.ts`, no `report-audit.ts`, no
      `legacy-v1` report validation. Proof: `test/package-artifact.test.ts`'s required-file list is
      unchanged and `git status` shows no such file added.
      Evidence: neither file exists; the only `legacy-v1` references left are the refusal in
      `lib/runtime-results.ts` and the v10 migration guard in `store.ts`, both of which reject it. The
      required-file list in `test/package-artifact.test.ts` is untouched by this change.

### US-005: The carried residuals are closed or explicitly retired

**Description:** As a reviewer, I want the criteria that were left unchecked to be resolved one way or the
other, so that the record does not carry silent gaps.

**Acceptance Criteria:**

- [x] An owned directory with no owned file beneath it produces no staged change. Proof: a test in
      `test/runtime-staging.test.ts` asserting `stagedFiles` is 0 for that input - carried from
      `prd-delegated-write-slice-settlement.md` US-001, previously unchecked.
      Evidence: "an owned directory the worker created but left empty stages no change" runs a real
      mounted AgentFS worker that does `mkdir -p app/topics` and nothing else, then asserts
      `staged.files` is empty, `staged.changes` is empty, and the host tree is untouched.
- [x] `agentFsMountAbsent` is true after a settled attempt. Proof: a test asserting the field on a
      resource whose mount the release path removed - carried from US-003, previously proven only
      indirectly.
      Evidence: the mount-leak case in `test/acpx-cleanup.test.ts` now asserts the field directly on both
      sides of the release: `false` while the killed worker's real mount is still present, `true` after
      `release_agentfs_session`. The case ran against a real mount (1.6 s, not skipped).
- [x] `sequence` is contiguous under two writers that overlap. Proof: a test racing two connections on one
      store - carried from US-004 slice 2, which previously exercised two connections sequentially.
      Evidence: "two writers racing on one store take contiguous sequences, never the same one" starts two
      processes that spin until a shared start time, each writing 25 entries to one story, and asserts the
      50 sequences taken are exactly 1..50 with no gap and no duplicate. A manual run of the same shape
      confirmed the writers genuinely interleave (one took 9-33 while the other took 1-8 and 34-50), so
      the test is not passing by accidental serialization.
- [x] The intermittently failing `herdr-worker-liveness.test.ts` case is diagnosed or recorded as
      accepted. Proof: either a fix with a test, or a recorded residual naming the observation (expected
      `null`, actual `invalid ACPX worker result: Expecting value: line 1 column 1 (char 0)`; passes 5/5
      alone; inferred writer-truncation race, unproven).
      Evidence: **diagnosed and fixed.** The inferred truncation race was real and in the product, not the
      test: `scripts/acpx-worker.ts` created the result file with `openSync(resultPath, "wx")` and wrote
      it afterwards, while `wait_for_settled_agent` polls `result_path.exists()` and then parses - so a
      poll landing between create and write read an empty file and produced exactly that message. The
      worker now writes a sibling temporary file, fsyncs it, and publishes by `renameSync`. The new case
      "the worker publishes its result atomically" pins the rename, pins the absence of the old
      create-then-write, and drives the real waiter against a writer using the same publish sequence.
- [x] The two Low findings from the 2026-09-20 review are closed or accepted: one logical record name
      resolving under both `failures/<runId>/` and `evidence/<runId>/`, and a repeated `collect` response
      omitting `diagnosticsPath`.
      Evidence: the never-dispatched record is now `unlaunched-<operationId>.json`, so it no longer shares
      a name with a worker's `failure-<operationId>.json` bundle; the cancel test asserts the new name,
      its `failures/` home, and that the old name is not taken. A repeated `collect` settles nothing and
      so learns no path, but now reads the retained bundle back out of the settled outcome's error text;
      `test/acpx-collect-convergence.test.ts` asserts the second response names the same existing bundle
      as the first. Both READMEs record the rename.

### US-006: The live view consumes a headless worker's published stream

**Description:** As an operator running a headless worker, I want the live view I already have to show
that worker's output, so that US-003's endpoint is something I actually see rather than something that
merely exists.

**Acceptance Criteria:**

- [x] A headless worker's detail and watch views show the lines its supervisor publishes, read from the
      attempt's `*.stream-endpoint.json` and `*.stream-token`, with no display path reading the capture
      file. Proof: a test that starts a real supervisor and a real worker, registers the worker, and
      asserts the rendered view contains a line the worker emitted.
      Evidence: `lib/live-stream.ts` is the reader; `attemptDetail` and `watchRun` fall back to it for a
      worker with no pane. "a running headless worker's view shows the lines its supervisor publishes" in
      `test/live-view.test.ts` runs `test/support/live-view-driver.py` - the shipped supervisor, a real
      worker process, the real endpoint - and asserts the rendered detail carries `LIVE VIEW LINE ONE`.
- [x] The endpoint is located from what the registration already carries, and the location is pinned: the
      endpoint and token live in the run directory, which is three levels above the agent's
      `acpx_cancel_script`, and the reader finds them by searching its ancestors for the descriptor
      rather than trusting the arithmetic. Proof: a test pinning the discovered directory against a real
      run directory layout.
      Evidence: `streamRunDirectory` walks up from the cancel script and returns the first ancestor
      holding a descriptor. The test asserts the real layout (`dirname` three times equals the driver's
      run directory), that the search returns it from both the cancel script and the attempt directory,
      and that a path with no descriptor above it yields null.
- [x] Reading the live stream never blocks the view: the read is asynchronous, deadline-bounded, and
      cached, so the redraw and the detail render stay synchronous and cannot hang on a worker, a
      socket, or a `herdr` process. Proof: a test asserting the view renders while the read is
      outstanding, and that an unreachable endpoint yields a note instead of a stall.
      Evidence: "reading the stream never blocks the view, and an unreachable endpoint is a note" renders
      a detail in under 250 ms with a pending note while nothing has been read, then reads a descriptor
      pointing at a dead port and gets `LIVE_VIEW_UNAVAILABLE` inside the budget. The agent list and the
      follow view refresh on their existing timers; the two one-shot watch paths await one refresh.
- [x] A worker that publishes no stream still says so, and never falls back to the capture file. Proof:
      a test asserting the fallback note for a headless worker whose run directory carries no endpoint
      descriptor.
      Evidence: "a run directory with no descriptor is a note, and a capture file beside it is never
      shown" writes a renderable capture file exactly where the old display path read it and asserts the
      note plus the absence of its text from the whole detail record. `NO_TERMINAL_NOTE` was removed with
      the note it carried: every registered worker has a cancel script, so the no-pane case is always the
      published-stream case.
- [x] The escape sequences the stream carries are not rendered into the view. Proof: a test asserting a
      line received with ANSI colouring appears without it.
      Evidence: the first test's worker emits a coloured line; the assertion finds `COLOURED LIVE LINE`
      and asserts no escape byte reaches the view. `stripAnsi` handles CSI and OSC sequences.
- [x] The live research measurement shows activity for headless workers again. Proof: a fresh
      measurement run whose `watchSamples` carry a non-null `lastActivity`, the way the earlier headless
      runs did (30/30 and 12/12) and the way the section 3c run did not.
      Evidence: section 3e - 10 of 10 agent rows carry activity, against 0 of 6 in the run that opened
      this finding.

## 3b. Review findings fixed after implementation (2026-09-20)

An adversarial self-review of the implemented change found three defects, each proven against a real
worker or a real hanging executable before and after the fix. No Astra reviewer was configured or
reachable on this host, so this was a single-reviewer pass.

- **Critical - a stalled subscriber wedged the worker.** `StreamPublisher.publish` used a blocking
  `sendall` while holding its lock, on the same thread that drains the worker's stdout. A subscriber that
  authenticated and then stopped reading filled the socket buffer, held the drain thread, backpressured
  the PTY and stalled the run: measured with a real worker, the capture file froze at 556,629 bytes and
  had not advanced 36 s later. Publishing is now non-blocking and a subscriber that cannot keep up is
  dropped. The same worker now finishes in under a second with a stalled subscriber attached.
  Guard: "a subscriber that stops reading loses its view rather than stalling the worker", verified as a
  real regression test by reintroducing the blocking socket (worker wedged for the full 60 s budget)
  and removing it again (0.5 s).
- **Critical - a hung `herdr` froze the Pi terminal.** `readPane` ran `spawnSync` with no timeout on the
  UI thread, once per worker per redraw (default 2 s). Against a stub `herdr` that sleeps, the call never
  returned in 45 s. It now carries a 1 s timeout and reports an unreadable pane as absent, returning in
  1001 ms. Guard: "a hung pane read gives up instead of freezing the view it runs on".
- **High - worker output could steer the reported diagnostic path.** `retainedDiagnosticFromOutcome`
  matched `retained worker diagnostics:` anywhere in the settled error, whose leading portion is the
  worker's own stderr. A worker printing that prefix won the match ahead of the supervisor's line
  (demonstrated: the parse returned `/etc/hosts`). It now reads only the final line and only accepts a
  path inside the store's evidence home. Guard: "a worker's own output cannot steer the diagnostic path
  a repeated collect reports", covering the leading-decoy, outside-home and traversal cases.

Checked and found sound: the ledger command rejects unsupported outcomes and claim statuses, and a
non-numeric aggregate fails the insert with no partial entry left behind.

## 3c. Live measurement evidence (2026-09-20)

Authorized live run at `e0d9575`, research graph, 1 repeat, model `alibaba/qwen3.8-flash` (Pi adapter),
dispatched through the production tool headless. Exit 0, terminal, 156,150 ms, 4 dispatches,
4 completions, 0 retries, 0 model fallbacks, 0 failures; operations `thinker_split` READY,
`search` DONE, `search` DONE, `thinker_synthesize` DONE. Evidence:
`agent-output/runtime-measure-2026-09-20/` (`summary.md`, `summary.json`, `run-runtime-v1-1.json`,
`ledger-runtime-v1-1.json`); run root kept deliberately at `/tmp/pi-wave-measure-runtime-v1-Zm2a74`
with `evidence/run_7d35cc20-.../` holding 4 settlement and 4 cleanup records.

Two things this run proves that no fixture could:

- **The US-003 endpoint works on a real dispatch.** Attached as an operator to the live attempt
  directory's endpoint while a thinker was running: the per-attempt token was mode 600, a connection
  presenting the wrong token received `unauthorized` and no worker output, and a connection presenting
  the token received the worker's own rendered stream (assistant text plus the dimmed-thought and
  prompt-rule rendering). This is US-003 verified end to end rather than against a fixture.
- **Cleanup and the US-001 bound both held.** All 4 operation run directories were removed after
  settlement, the 8 evidence records survived, and no `failures/` directory, no retained capture and no
  failure bundle were produced, because every attempt settled with a candidate. The new candidate-less
  branch therefore did not misfire on a healthy run.

## 3d. Review findings after the live run (2026-09-20)

- **High - the headless live stream had no consumer. RESOLVED by US-006.** The measurement driver always
  dispatches `transport: "headless"` (`test/support/runtime-measure.ts:222`), so its `op=watch` samples
  measure exactly this. The run that opened the finding: 6 samples, 6 agent rows, **0 carrying any
  `lastActivity`**; earlier headless runs had recorded 30/30 and 12/12 from the capture file the display
  paths then read. On the default transport the live view therefore showed nothing. It now reads the
  published stream: section 3e records 10 of 10 rows carrying activity in a fresh headless run.
- **High - a Herdr settlement leaves its tab open and reports a post-settlement failure. OPEN, and
  pre-existing rather than a regression.** Observed in the Herdr run of section 3e: all 4 operations
  settled with `postSettlementFailures: 1`, no cleanup evidence was retained (the headless run of the
  same shape retained four), and tabs `wT:t2`-`wT:t5` were still open after the run ended. Reproduced
  directly against real Herdr state, with no provider turn: `verify_cleanup_absence` for a resource whose
  tab is genuinely open raises `cleanup absence audit failed: tabAbsent; paneAbsent; queueOwnerAbsent;
  agentFsServerAbsent; ownedProcessesAbsent; sessionClosed`. The mechanism is visible in the code:
  `close_settled_tab` is called only from the two failure paths of `wait_for_settled_agent`, and
  `abort_acpx_attempt` (which closes tabs) runs only when post-settlement failures already exist, so
  nothing closes a successfully settled worker's tab before the audit that requires it absent. Checked
  against `e7528b3`: the happy path is identical there, and this change's diff never touches tab closing
  or the absence audit, so this is not a regression from this increment. It went unnoticed because the
  measurement driver records `record.failures` from collect errors and capture retention only, so a
  post-settlement failure is invisible in its run record. **Fix needed:** close the settled tab before
  the absence audit, and have the driver surface `postSettlementFailures` so the class cannot hide again.
- **Medium - a post-settlement failure replaces the candidate-less reason in the failure bundle.** The
  abort path writes the same `failure-<operationId>.json` the candidate-less path writes, so when a later
  step fails, the human-readable reason becomes "attempt aborted before cleanup". Observed and pinned by
  "a post-settlement failure replaces the candidate-less reason in the bundle that reports it"; the
  candidate-less signal survives in the bundle's `workerResult.capture.captureStatus`, which that test
  asserts.
- **Medium - a subscriber with no grace period is dropped on the first full socket buffer.** Unchanged
  from the previous review. The viewer now polls the backlog rather than holding a subscriber open, which
  is what keeps a view from losing its stream when it falls behind, but the policy itself is unchanged.
- **Low - `_greet` can deliver the backlog after newer live lines.** Unchanged.
- **Low - path containment is lexical, not symlink-aware.** Unchanged.

### Fixed during this increment

- **The failure bundle read the wrong stream path.** `write_failure_diagnostics` read
  `attempt_dir/worker.stdout.ndjson`, but a prompt worker writes its stream beside its result file, which
  is the asymmetry `retain_incomplete_capture` already documents and works around. The bundle's
  `recentEvents` was therefore empty for the normal runtime-v1 shape. Both now read the one
  `worker_stream_source` search: the live exercise went from 0 to 20 recent events on the same input.
- **The agent list repainted only after its asynchronous read.** Registration now draws from what is known
  and then enriches, so a newly registered worker appears immediately instead of one interval later.

## 3e. Live proof of the fix, both transports (2026-09-20)

**Headless, after US-006.** Authorized research run at the working tree, 1 repeat, `alibaba/qwen3.8-flash`,
`--transport headless` (the default): exit 0, terminal, 211,752 ms, 4 dispatches, 4 completions, 0 retries,
0 fallbacks, 0 failures. `op=watch` sampled 9 times, 10 agent rows, **10 carrying a non-null
`lastActivity`** - real worker output such as "So the cache is a memo of `rows`. Invalidation on save is
needed because if you ...". The run that opened the finding recorded 0 of 6 on the same transport. All run
directories were removed and 8 evidence records retained. Evidence:
`agent-output/runtime-measure-2026-09-20-headless-liveview/`. Mid-run, the reader was also pointed at the
live attempt directory by hand and returned the 12 lines the view would render.

**Herdr, the visible adapter.** Authorized research run with `--transport herdr` in a throwaway workspace
(created for this proof and closed afterwards; the operator's own workspaces were untouched): exit 0,
terminal, 164,725 ms, 4 dispatches, 4 completions, 0 retries, 0 failures, all four operations completed
with verdicts (`thinker_split` READY, `search` DONE, `search` DONE, `thinker_synthesize` DONE). Real tabs
were created with the role-bearing labels. `--transport herdr` was added to the measurement driver for
this, including a per-sample direct `herdr pane read` recorded beside the view's own reading, so agreement
is checkable rather than assumed: **4 of 4 comparisons match exactly**, the view's rendered line being
byte-identical to the pane's own last line (for example `"Let me be"` and then a longer sentence from the
answer). All run directories were removed afterwards. Evidence: `/tmp/dg-herdr-proof-evidence/` and the
run root `/tmp/pi-wave-measure-runtime-v1-S4EGVz/`.

The Herdr run is also what surfaced the open High finding in section 3d: its four operations each settled
with a post-settlement cleanup failure, and its tabs outlived the run.

**The candidate-less failure bundle, exercised live.** `test/support/failure-bundle-driver.py` starts the
real supervisor and a real worker that exits cleanly having captured nothing, then calls the shipped
`settle_runtime_attempt`. On 120 emitted events the settled attempt retained a 20-event tail (seq 100-119,
mode 600) and a `failure-op-candidate-less.json` bundle (mode 600) whose reason is "attempt settled without
a candidate", carrying the worker's stderr and its 20 most recent events. `test/failure-bundle-live.test.ts`
then drives the store's retention over those artifacts: both land under `evidence/<runId>/`, byte-exact and
mode 600, and the run directory is removed. The unpatched variant is recorded too, because it shows the
abort path replacing the candidate-less reason.

## 4. Functional Requirements

- FR-1: A retained capture must be bounded by the diagnostic windows already used for failure bundles.
- FR-2: A complete capture with a candidate must retain nothing.
- FR-3: A candidate-less settle must produce a failure bundle so no diagnosis depends on the capture alone.
- FR-4: No display path may read a stream file; the pane is the live source when a pane exists.
- FR-5: A transport with no pane must say so rather than substitute a file.
- FR-6: Wording must distinguish a live stream sink from a retained artifact.
- FR-7: One resolver decides the publish endpoint, and a test pins it per platform.
- FR-8: Headless must publish its live stream from the host-side supervisor, not from inside the sandbox.
- FR-9: The endpoint must require a per-attempt token and must bind `127.0.0.1` only.
- FR-10: Endpoint publication must be probed before dispatch and fail with a named blocker.
- FR-11: The endpoint must retain nothing; it must be a stream with no replay.
- FR-12: The story's execution record must have exactly one writer: the store.
- FR-13: No `legacy-v1` report or file-ledger machinery may be reintroduced into the package.

- FR-19: A headless worker's live view must read the stream its supervisor publishes, not the capture file.
- FR-20: The live view must never block on the stream: the read is async, deadline-bounded and cached.
- FR-21: A worker that publishes nothing must say so rather than showing a capture file in its place.

## 5. Non-Goals

- **Making Windows actually work.** The publish endpoint is chosen to be portable, but three blockers
  precede it and none is addressed here: `headless_supervisor.py:43` requires the private PTY executable
  `script`, which Windows does not provide; `scripts/doctor.mjs:137` fails any platform that is not
  `darwin` or `linux`; and AgentFS — required at exactly v0.6.4 by `require-agentfs.ts` — is FUSE plus
  Linux mount namespaces with "bash on Linux, zsh on macOS" shells, so there is no sandbox for a Windows
  worker to run in. Recorded so nobody later assumes the transport was the obstacle.
- A FIFO-based channel: POSIX-only, and a FIFO in a scanned directory is a hang trap, which is the same
  class of failure the dead AgentFS NFS mounts caused in `/tmp` during the 2026-09-20 session.
- A Unix domain socket **under the run directory**: `sun_path` is 103 bytes on macOS and 107 on Linux
  (Node docs), and the run directories measured in this session are 123 bytes, so
  `<run dir>/stream.sock` is 135 — over the limit on both platforms.
- Reintroducing `legacy-v1` report validation, `op=record` settlement, or the file ledger.
- Redacting the live stream. The failure-bundle redactions (`FAILURE_DIAGNOSTIC_REDACTIONS`) stay where
  they are; the live stream is not a retained artifact, and an endpoint's exposure is bounded by its
  token and by binding to loopback.

## 6. Design / Technical Considerations

- **Where the stream already is.** `scripts/acpx-worker.ts:138-141` spawns ACPX with `stdio: ["ignore",
  "pipe", "pipe"]` and writes each chunk to the worker's stdout; line 204 renders it for a TTY. The
  launcher `launch-acpx.sh` (`delegate_core.py:769-774`) execs with no redirection, so the pane carries
  the stream. There are two stream sinks in headless mode: the worker's in-sandbox
  `<attempt_dir>/runtime-output/worker.stdout.ndjson`, and the supervisor's host-side
  `run_dir/headless-<agent>.stdout` (`delegate_core.py:920`, wired at `:836`).
- **Why the supervisor binds.** `headless_supervisor.py` spawns the PTY (`script`) which spawns the
  launcher, so it is the outermost host-side process — outside the AgentFS sandbox. Binding there avoids
  every sandbox bind question and needs no worker change.
- **Portability.** Node's IPC is a named pipe on Windows (`\\?\pipe\` or `\\.\pipe\`) and a Unix domain
  socket elsewhere, with the 103/107-byte path limit above; loopback TCP is identical on all three
  platforms. `acpx` itself offers no attach-or-stream subcommand — its commands are agent presets plus
  `prompt`, `exec` and `cancel` — so the pane is the only direct source for Herdr.
- **Pane access.** `herdr.ts:122` already calls `herdr pane get <pane_id>`; `agents.herdr_pane_id` is on
  the agent row. `herdr pane read <pane_id> [--source visible|recent|recent-unwrapped] [--lines N]
  [--format text|ansi]` supplies the live view. Cost: one `herdr pane read` per redraw, default 2000 ms
  (`PI_GRAPH_WATCH_INTERVAL_MS`).
- **What the view becomes.** A pane carries rendered terminal text, not JSON-RPC, so `summarizeAcpxStream`
  no longer parses that source. The view changes from a parsed summary to terminal output, which is the
  requested behaviour and is a deliberate change of what the view *is*.
- **The old task's shape.** The store already supports it: `recordLedgerEntry` computes the per-story
  `sequence` inside the inserting transaction (replacing the file ledger's `.sequence-lock`),
  `storyLedger` reads a story back, and `auditStoryLedger` recomputes `percentage` from
  `numerator`/`denominator` and reports `AGGREGATE_MISMATCH`. The retired tool's required input was a
  `legacy-v1` `DelegateReport` file, which runtime-v1 no longer produces — which is why restoring or
  relocating the script is not the fix.

## 7. Success Metrics

- No display path opens a stream file; the pane renders with that file deleted.
- A retained capture is bounded, and its bound is asserted rather than described.
- A headless worker's stream is reachable on loopback with a token, and no artifact is created for it.
- The evidence-ledger rule names a command that exits zero.
- Every criterion carried from the earlier PRD is checked or explicitly retired.

## 8. Open Questions

1. **The retention bound.** Which window should a retained capture use — the failure bundle's
   `FAILURE_DIAGNOSTIC_EVENT_LIMIT` events and `FAILURE_DIAGNOSTIC_STDERR_BYTES`, or a byte cap chosen for
   the stream's shape? A byte cap is simpler to assert; the event window matches the bundle's existing
   semantics.
2. **Whether an HTTP layer is wanted later.** The TCP backend makes SSE or a REST view a later addition
   with no rework. Nothing in this PRD builds it.
3. **Whether the 91 leftover run directories on this machine should be cleared**, and whether the
   pre-existing leaked directories from before the deletion fix are worth reclaiming by hand.
4. **Live proof for the two gaps left open on 2026-09-20:** capture retention has never run live (every
   capture in the live run was complete with a candidate), and the `prune` reaper is covered only by unit
   tests because the measurement driver does not touch the real database. Both are stated as unproven in
   `agent-output/live-delegation-write-slice-20260920/README.md`.