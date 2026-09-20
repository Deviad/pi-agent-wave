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
- [x] A worker with no pane renders an explicit note that the transport has no terminal, and does not
      fall back to the file. Proof: a test asserting the note with `herdr_pane_id` null.
      Evidence: "a worker with no terminal says so, and no display path reads the worker's stream file"
      registers a headless worker, writes a renderable stream file, and asserts the detail view shows
      `NO_TERMINAL_NOTE`, shows none of the file's text, and performs no pane read at all.
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

**Description:** As the user of the evidence-ledger workflow, I want one writer for a story's execution
record, so that the rule I follow cannot reference a script that does not exist.

**Acceptance Criteria:**

- [ ] The supervisor's ledger write goes through the store's `recordLedgerEntry` and produces
      `ledger_entries` rows. Proof: a test asserting rows appear for a story and that no
      `agent-output/<story>/delegate-ledger/*.json` is created.
- [ ] `audit` reads the store and recomputes each aggregate from its components, reporting
      `AGGREGATE_MISMATCH`. Proof: `test/story-ledger.test.ts`'s existing aggregate case, exercised
      through the CLI surface rather than the store API directly.
- [ ] `~/.pi/agent/scripts/delegate-ledger` no longer resolves a package script. Proof: running it against
      a story exits zero and its output names the store, and the file contains no
      `scripts/ledger.ts` lookup. The wrapper is the user's own file at
      `~/.pi/agent/scripts/delegate-ledger`; the PRD records the change and the user owns it.
- [ ] The evidence-ledger rule in `~/.pi/agent/AGENTS.md` names the store instead of the wrapper's
      script resolution. Proof: the rule text, which currently reads "the wrapper resolves
      `scripts/ledger.ts` from whichever package `settings.json` loads", is updated in the same change.
- [ ] No file-ledger machinery is reintroduced into the package: no `ledger.ts`, no `report-audit.ts`, no
      `legacy-v1` report validation. Proof: `test/package-artifact.test.ts`'s required-file list is
      unchanged and `git status` shows no such file added.

### US-005: The carried residuals are closed or explicitly retired

**Description:** As a reviewer, I want the criteria that were left unchecked to be resolved one way or the
other, so that the record does not carry silent gaps.

**Acceptance Criteria:**

- [ ] An owned directory with no owned file beneath it produces no staged change. Proof: a test in
      `test/runtime-staging.test.ts` asserting `stagedFiles` is 0 for that input — carried from
      `prd-delegated-write-slice-settlement.md` US-001, currently unchecked.
- [ ] `agentFsMountAbsent` is true after a settled attempt. Proof: a test asserting the field on a
      resource whose mount the release path removed — carried from US-003, currently proven only
      indirectly.
- [ ] `sequence` is contiguous under two writers that overlap. Proof: a test racing two connections on one
      store — carried from US-004 slice 2, which today exercises two connections sequentially.
- [ ] The intermittently failing `herdr-worker-liveness.test.ts` case is diagnosed or recorded as
      accepted. Proof: either a fix with a test, or a recorded residual naming the observation (expected
      `null`, actual `invalid ACPX worker result: Expecting value: line 1 column 1 (char 0)`; passes 5/5
      alone; inferred writer-truncation race, unproven).
- [ ] The two Low findings from the 2026-09-20 review are closed or accepted: one logical record name
      resolving under both `failures/<runId>/` and `evidence/<runId>/`, and a repeated `collect` response
      omitting `diagnosticsPath`.

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