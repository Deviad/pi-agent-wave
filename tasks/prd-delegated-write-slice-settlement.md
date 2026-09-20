# PRD: Delegated write slices settle truthfully

**Status:** open — plan of record
**Recorded:** 2026-09-20
**Source report:** `tasks/handoff-delegation-write-slice-integration.md`
**Governing PRDs:** `tasks/prd-runtime-owned-results.md`, `tasks/prd-settlement-convergence-gaps.md`
**What remains is tracked elsewhere:** the criteria still open below — the US-001 owned-empty-directory case,
the US-003 `agentFsMountAbsent` case, the US-004 concurrent-writer sequence case, and US-004 slice 3 (the
`delegate-ledger` retirement) — are restated as US-004 and US-005 of
`tasks/prd-live-worker-stream-and-ledger-retirement.md`, which is now their plan of record. This document
keeps the record of what it completed and is no longer edited for new work.

## 1. Overview

A delegated build slice reports success and leaves nothing behind. The handoff that
opened this work recorded two implementation attempts whose deliverable code was
discarded and could not be recovered, and concluded that the AgentFS overlay was
read-only.

That conclusion is wrong, and this PRD records what actually happens.

The overlay is writable. AgentFS mounts the host working tree as a read-only base and
accepts writes into a delta layer; a bounded real slice (a real `agentfs run` session
doing `mkdir -p app/topics`, then the same sqlite `backup` + `DELETE` journal-mode
snapshot `delegate_core.snapshot_agentfs_db` takes, then `stageRuntimeAgentFs`) shows
the delta layers accepted only the write, and the host tree stayed byte-identical.

The real cause is the ownership rule. `auditAgentFsChanges` in
`lib/agentfs-sandbox.ts` treats a change as owned only when its path equals an owned
path or sits below one. A directory the worker creates as an ancestor of an owned file
therefore matches neither, is classified as a violation, and settlement refuses with
`AgentFS contains unowned changes: app, app/topics` — `stagedFiles: 0` is the symptom,
not the cause. Declaring those directories as owned reaches the next wall instead:
`stageRuntimeAgentFs` refuses any owned directory with `directory staging requires
directory integration support`. So an implement slice that creates a new directory
cannot settle under either declaration, which is why the build graph is unusable for
its primary purpose.

Two further defects were found while reproducing, both live:

- The completion gate is not reproducible outside a Herdr workspace: six tests fail in
  a plain shell for want of `HERDR_ENV`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`, and
  `scripts/delegate_core.py:1622` raises `KeyError` rather than failing closed.
- Delegated workers leak their AgentFS mount. Two dead `nfs` mounts to `127.0.0.1`
  were found under `delegate-graph-herdr-run-*` run directories with no active
  `agentfs` session, hanging every read of those paths and raising macOS's "Server
  connections interrupted" dialog for two `/mnt` volumes. Nothing in the package
  unmounts an AgentFS mount; `agentfs prune mounts` refuses on macOS.

## 2. Goals

- An implement slice that creates new directories settles with its files staged.
- Genuinely unowned changes still fail closed, naming the offending path.
- The documented completion gate passes in a plain shell with no Herdr identity.
- A settled or aborted attempt leaves no AgentFS mount behind.
- One durable record per story, without a second write path that can silently rot.

## 3. User Stories

### US-001: An implement slice stages the files it created in new directories

**Description:** As the supervisor of a build run, I want a slice that creates new
modules to stage its files, so that delegated implementation is usable for its primary
purpose.

**Acceptance Criteria:**

- [x] A created directory that is an ancestor of an owned path is a container, not a
      violation. Proof: `treats a directory created for an owned file as a container but
      still refuses its other children` in `test/agentfs-sandbox.test.ts` asserts
      `violations` is empty of both directories and that `app` and `app/topics` appear in
      `owned`. File passes 20/20.
- [x] `stageRuntimeAgentFs` stages the owned file and omits container directories from
      `changes`. Proof: `stages an owned file the worker created inside new directories,
      and still refuses an unowned sibling` in `test/runtime-staging.test.ts` drives a real
      `agentfs run` session, snapshots with the lifecycle's own sqlite backup, and asserts
      `files.length === 1`, `changes` naming only `app/topics/index.ts`, and an untouched
      host tree. File passes 4/4.
- [x] A created directory that is not an ancestor of any owned path remains a violation
      naming the path. Proof: the first test asserts `violations` equals
      `["app/stray.txt", "stray-dir"]`; the second asserts staging throws
      `/unowned changes: app\/stray\.txt/`.
- [x] An owned directory with no owned file beneath it produces no staged change. **Closed
      2026-09-20** by US-005 of `tasks/prd-live-worker-stream-and-ledger-retirement.md`, which
      carried this criterion and pinned it: `an owned directory the worker created but left empty
      stages no change` in `test/runtime-staging.test.ts` runs a real mounted AgentFS worker that
      does `mkdir -p app/topics` and nothing else, then asserts `staged.files` and `staged.changes`
      are empty and the host tree untouched. Left unchecked when this slice closed because the
      directory filter made it hold without a dedicated test.
- [x] The gate reports no failure this change introduced. Proof: `node
      --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` from the
      repository root reports 550 tests, 539 pass, 0 fail, 11 skipped, with `npm run
      typecheck` and `git diff --check` clean, at revision `e7528b3`.

One test-design defect was fixed in the same change: the staging-scratch assertion swept
      every `pi-wave-staging-` entry in `/tmp`, so a staging call running concurrently in
      another test file failed it for a directory it did not create. The scratch name now
      carries its process id (`lib/runtime-staging.ts`) and the assertion is scoped to it.

### US-002: The completion gate passes without a Herdr workspace

**Description:** As a developer running the documented gate in a plain shell, I want it
to pass, so that a green gate means the code is green rather than that my shell is
special.

**Acceptance Criteria:**

- [x] `test/herdr-requirement.test.ts`, `test/doctor.test.ts` and
      `test/acpx-spike-preflight.test.ts` each supply the Herdr identity they exercise.
      Proof: running those three files plus `test/acpx-cleanup.test.ts` with `HERDR_ENV`,
      `HERDR_WORKSPACE_ID` and `HERDR_TAB_ID` unset reports 51/51 passing.
- [x] `test/support/acpx-cleanup-driver.py` selects the transport per case. Proof: `closure`
      and `persistence` call `use_transport("headless")`; `test/acpx-cleanup.test.ts`
      reports 39/39 with identity unset, and the six Herdr release cases still fail closed
      on their Herdr assertions. A blanket headless declaration was measured first and
      rejected: it breaks `fails closed on Herdr agent release failure` and
      `... Herdr tab release failure`.
- [x] `scripts/delegate_core.py` fails closed instead of raising `KeyError`. Proof: driver
      case `herdr-unverifiable` and the test `fails closed when a Herdr absence audit has
      no workspace identity`. Verified to fail (38/39) when the guard is removed.
- [x] The whole gate reports 0 failures in a plain shell, from the repository root. Proof:
      550 tests, 539 pass, 0 fail, 11 skipped with all three `HERDR_*` variables unset.

### US-003: A settled attempt leaves no AgentFS mount behind

**Description:** As an operator, I want teardown to unmount the worker's AgentFS mount,
so that leaked mounts stop hanging reads and raising macOS dialogs.

**Acceptance Criteria:**

- [x] Teardown unmounts the attempt's AgentFS mount. Proof: `release_agentfs_session` in
      `scripts/delegate_core.py`, called from `abort_acpx_attempt` and from the settle path
      before `verify_cleanup_absence`; the test `releases an AgentFS mount a killed worker
      left behind` starts a real session, waits for its real mount, kills the process group,
      and requires the release step to leave no mount. Verified to fail (37/38) when the
      release is neutralized.
- [x] The macOS branch is used, where `agentfs prune mounts` refuses. Proof: the release
      uses `umount -f` and the test above runs against a real macOS mount, confirming the
      probe saw a mount and that none remained.
- [x] `agentFsMountAbsent` is true for a settled attempt. **Closed 2026-09-20** by US-005 of
      `tasks/prd-live-worker-stream-and-ledger-retirement.md`: the mount-leak case in
      `test/acpx-cleanup.test.ts` now asserts the field directly on both sides of the release
      (`agentFsMountAbsentBeforeRelease` false, `agentFsMountAbsentAfterRelease` true) against a
      real mount, so it is no longer inferred from "no mount remains". Left unchecked when this
      slice closed because the field was proven only indirectly.
- [x] Repeated teardown over an already-unmounted attempt converges. Proof: the existing
      `repeated teardown over a torn-down attempt converges with written absence evidence`
      still asserts `exits` of `[0, 0, 0]`.

Note on the AC as written: "and reports it" is satisfied through the existing
      `agentFsMountAbsent` field in the absence audit rather than a separate unmount record.
      That is the field the audit already computes, so no new evidence shape was invented.

### US-004: One durable record per story

**Description:** As the user of the evidence-ledger workflow, I want one writer for the
story's execution record, so that the trail cannot rot in one place while living in
another.

**Decided:** 2026-09-20 — `delegate-graph.db` becomes the single source of truth. The
durable narrative stays in the story's PRD; the execution record becomes rows. The home
is `~/.local/share/delegate-graph/`, pinned by the user.

**Sequencing:** slice 1 is storage durability and the documentation that names it. Slice 2
is the ledger schema and its read model. Slice 3 is the CLI and the retirement of the file
ledger. Slices 1 and 2 are claimed here.

**Acceptance Criteria (slice 1 — done):**

- [x] The graph home is durable and is no longer a cache directory. Proof:
      `DEFAULT_GRAPH_HOME` in `store.ts` is `join(homedir(), ".local", "share",
      "delegate-graph")`; `test/graph-home.test.ts` case 1 asserts the path, and that it
      contains no `.cache` segment. No new environment variable was added: `DELEGATE_GRAPH_DB`
      remains the documented override.
- [x] No shipped module resolves the retired path. Proof: `test/graph-home.test.ts` case 2 walks the
      packaged sources — `.ts`, `.mjs` and `.py`, excluding `test/`, `node_modules` and `.git` — and
      asserts none contains `.cache/delegate-graph`, and that the walk really reaches
      `delegate_core.py` so the wider glob cannot silently stop matching. The walk covers code and not
      prose on purpose: `extensions/pi-agent-wave/README.md` names the old path deliberately, as
      history.
- [x] The whole layout moves with the one constant. Proof: case 3 asserts `runtime-content/`
      is created beside a database configured through `DELEGATE_GRAPH_DB`; `failures/`
      (`store.ts:1791`) and `runtime-integration-staging/` (`lib/runtime-integration.ts:95`)
      derive from the same `dirname(dbPath)`.
- [x] Every document that named the old path names the new one. Proof: `AGENTS.md`, the root
      `README.md` at two sites, and `extensions/pi-agent-wave/README.md` in both the
      `DELEGATE_GRAPH_DB` row and the storage table. The same pass corrected the staging
      scratch row to the pid-scoped name introduced for US-001, which had already gone stale.

**Deliberately not done in slice 1:** honouring `XDG_DATA_HOME`. The literal `~/.local/share`
is implemented because that location was pinned; reading a further variable would add a new
entry to a configuration surface this repository enumerates explicitly (`PI_CODING_AGENT_DIR`,
`PI_MODEL_ROUTING`, `PI_MODEL_CATALOG`). Whether to honour it is an open question, recorded in
§8.

**Acceptance Criteria (slice 2 — done):**

- [x] Schema v12 adds a per-story `sequence` and `topic` plus the ledger tables. Proof:
      `migrateToV12` in `store.ts` creates `ledger_entries`, `ledger_claims` and
      `ledger_aggregates`; the seeded test in `test/store.test.ts` (`migrates a v1 database to the
      current version preserving existing rows`) asserts all three exist and that an entry can be
      recorded from the oldest supported schema, while its existing assertions still pin the legacy
      `runs`, `operations`, `agents` and `events` snapshots row-for-row. v12 is purely additive
      (`CREATE TABLE IF NOT EXISTS`), so it cannot rewrite a historical row.
- [x] `CURRENT_SCHEMA_VERSION` replaces the version literal, and a stale constant fails loudly.
      Proof: `store.ts` throws `store migrated to schema vN, but this build expects vM` when the
      chain stops short; five hardcoded `11` assertions across `test/store.test.ts`,
      `test/acpx-store-migration.test.ts`, `test/runtime-results.test.ts` and
      `test/runtime-operations.test.ts` now read `CURRENT_SCHEMA_VERSION`, and that last file's
      `DELETE FROM schema_version WHERE version IN (9, 10, 11)` became `version >= 9`. Without this
      the bump cost thirteen failing assertions across five files.
- [x] `sequence` replaces the file lock under genuinely concurrent writers. **Closed 2026-09-20**
      by US-005 of `tasks/prd-live-worker-stream-and-ledger-retirement.md`: `two writers racing on
      one store take contiguous sequences, never the same one` in `test/story-ledger.test.ts` starts
      two processes that spin until a shared start time, each writing 25 entries to one story, and
      asserts the 50 sequences taken are exactly 1..50 with no gap and no duplicate. A manual run of
      the same shape confirmed the writers genuinely interleave, so it does not pass by accidental
      serialization. Left unchecked when this slice closed because only sequential connections had
      been exercised; what held then — `BEGIN IMMEDIATE` serializing the read and the insert, with
      the unique index on `(story, sequence)` refusing the loser — is what the racing test now pins.
- [x] Pruning a run cannot delete the story's ledger entries. Proof:
      `pruning a run keeps the story's record, because the entry outlives its run` asserts the run
      is gone while the entry, its sequence and its `runId` survive; verified to fail alone (5/6)
      when `prune` is made to delete ledger entries, so the assertion guards the missing foreign key
      rather than merely describing it. The storage table's "Until `/graph prune`" lifetime is
      therefore still accurate for run rows and no longer describes the record.
- [x] `audit` is a story-scoped query that recomputes the aggregate. Proof: `recomputes the
      aggregate rather than trusting the recorded percentage` asserts `9/10` with `90` is valid,
      `9/10` with `100` yields `AGGREGATE_MISMATCH` naming `recorded 100, computed 90`, a zero
      denominator yields `AGGREGATE_INVALID`, and an unknown story yields `LEDGER_EMPTY`.
      `SEQUENCE_GAP` is pinned by `reports a sequence gap instead of assuming contiguity`.
- [x] Claims carry their evidence state as a state rather than as prose. Proof: `stores claims with
      their evidence state and aggregates as recorded` asserts `verified` and `unverified-recall`
      round-trip through the store; the schema's `CHECK(status IN (...))` and `refuses an entry that
      is missing identity or carries an unknown outcome` pin the allowed set.

**Carried over deliberately:** the legacy report fields (`report`, `rejectedCandidate`,
`rejectionDiagnostics`) are **not** in v12. They belong to the `legacy-v1` report machinery this
package removed and must not be reintroduced. The entry keeps the run, tier, model, outcome, task
and timestamp, which is what the record needs to be auditable on its own.

**Acceptance Criteria (slice 3 — not started):**

- [x] The `delegate-ledger` CLI writes through the store, and no file ledger is written. **Closed
      2026-09-20** by US-004 of `tasks/prd-live-worker-stream-and-ledger-retirement.md`:
      `the command surface writes through the store and audits from it, creating no ledger file` in
      `test/story-ledger.test.ts` runs `scripts/story-ledger.mjs`, reads the entry, its claims and
      its aggregates back through `storyLedger`, and asserts no `delegate-ledger` directory and no
      ledger JSON file exist beside the store.
- [x] The wrapper and its package-resolution problem are gone, and the evidence-ledger rule
      in `~/.pi/agent/AGENTS.md` names the store instead of a script path. **Closed 2026-09-20** by
      US-004 of the same PRD. The wrapper `~/.pi/agent/scripts/delegate-ledger` resolves
      `scripts/story-ledger.mjs` from the package `settings.json` loads and runs it with
      `--experimental-strip-types`; the rule in `~/.pi/agent/AGENTS.md` names the store tables and no
      script path. Independently re-checked on 2026-09-20 while reviewing the successor increment: the
      wrapper run against a temporary `DELEGATE_GRAPH_DB` exited 0 with `action: ledger_read` and named
      the store, and the package entry in `settings.json` is the tree that carries the script.

**The 109 existing runs at the old path are documented, not moved.** Slice 1 changes the
default and records the old location and the `DELEGATE_GRAPH_DB` escape hatch in the storage
documentation. Nothing relocates or deletes an existing database, and nothing was run against
the real one.

### US-005: A settled operation leaves no run directory behind

**Description:** As the operator of this machine, I want a finished operation to remove its working
directory, so that the system stops accumulating directories that hang reads and raise macOS dialogs.

**Recorded:** 2026-09-20, at the user's request: "I don't like the use of /tmp. And these files like
that. Why do we need this if we have already the db?"

**Corrected 2026-09-20 after that question, and the correction is the point of this story.** The first
version of this story proposed relocating the run root to `<graph home>/runs/`. That was wrong and is
withdrawn. The run directory is not storage: the extension keeps its path in a local variable
(`index.ts:853`, from the `init` subcommand) and passes it as argv to `start`, `wait` and `cleanup`, and
the store holds no column for it. It exists because a subprocess needs a HOME and an AgentFS mount
point, because `state.json` is the resource registry carried across those separate process invocations,
and because the launcher passes `--allow <run_dir>` to the sandbox — none of which a row can be. A
durable `runs/` home would have moved the accumulation rather than fixed it.

**Measured:** 67 leftover `delegate-graph-herdr-*` directories, 46 MB, of which 41 MB is AgentFS overlay
and ACPX home content. Two hosted dead NFS mounts to `127.0.0.1` that hung every read and produced
macOS's "Server connections interrupted" dialog; both were released by hand.

**Why they accumulated, precisely:** `rmtree` appears five times in the lifecycle and never targets the
run directory itself. `command_cleanup` removes `run_dir / "acpx"` (`delegate_core.py:1859`);
`settle_runtime_attempt` removes the attempt directory and the ACPX home (`:1807`-`:1808`). `state.json`,
`task.md`, `system-prompt.txt`, `runtime-evidence/` and the evidence records all survive. Nothing is
broken about the location; the delete is simply missing.

**Ordering constraint.** `settle_runtime_attempt` runs `verify_cleanup_absence` inline and returns
`settlementEvidencePath` and `cleanupEvidencePath` pointing *inside* the run directory, and the extension
reads them immediately after `wait` (`index.ts:604`). Deletion therefore cannot happen in settle or wait.
It belongs after `op=collect` has recorded the facts, and `collect` has exactly one caller
(`index.ts:917`), so finalization goes there rather than into collect's three return paths.

**Acceptance Criteria:**

- [x] A settled operation leaves no run directory. Proof, both live and unit:
      `finalizeRunDirectory` is called from the single `collect` handler and removes the directory
      after its records are retained; the test `a settled operation leaves no run directory and keeps
      its evidence` asserts the directory is gone, and `acpx-collect-convergence.test.ts`'s repeated
      collect still converges because `collectRuntimeAttempt` short-circuits on `registered.outcome`
      and never stats the directory. **Live:** a research measurement on Pi 0.85.1 with
      `alibaba/qwen3.8-flash` (`agent-output/live-delegation-write-slice-20260920/`, run
      `run_576308af-6c69-457d-9c7a-137d7d7570df`) dispatched four operations, terminated with 0
      failures, and left **zero** directories for that run; the count in `/tmp` was 83 before and 83
      after across two four-operation runs, so eight directories were created and removed.
- [x] Every record needed afterwards is retained in the store before deletion. Proof:
      `GraphStore.retainRunEvidence` writes `<graph home>/evidence/<runId>/<name>` mode 600, and the
      same test reads the settlement evidence, cleanup evidence, capture stream and failure bundle back
      from that directory after the run directory is gone. **Live:** the same run retained eight real
      records — four `runtime-settlement-<agent>.json` and four `cleanup-<agent>.json` — each mode 600
      in a mode 700 directory, carrying `resultContract: runtime-v1`, a real attempt key,
      `captureStatus: complete` and a cleanup audit with `agentFsMountAbsent: true`.
      **Not proven live:** capture-stream retention, because every capture in that run was complete
      with a candidate and `retain_incomplete_capture` only retains an incomplete one; that path rests
      on the unit test alone. The reaper is likewise covered only by unit tests, because it reads and
      writes the real graph database that the measurement driver deliberately does not touch.
- [x] The capture stream is retained byte-exact. Proof: the test asserts the retained bytes equal the
      bytes the launcher wrote, which is why retention copies bytes rather than re-serializing JSON.
- [x] Failure detection still reads the live bundle, so the teardown signal is not lost. Proof:
      `collect settles from retained teardown evidence without waiting` still detects the launcher's
      teardown before finalization; its `diagnosticsPath` assertion now names the durable copy.
- [x] Deleting one operation's directory cannot affect a later operation. Proof: `init
      <runId>-<operationId>` runs per dispatch (`index.ts:851`) and `materializeRuntimeEvidence` writes
      into the dispatching operation's own directory (`:855`), so directories are per operation, not
      per run.

**Acceptance Criteria, added after adversarial review (findings 1 and 2):**

- [x] Retention is bounded: pruning a run reclaims what it left on disk. Proof: `prune`
      (`store.ts`) resolves the run directory of every operation from `agents.acpx_cancel_script`
      before deleting the rows — exact, because `cancel-acpx.sh` sits three levels below its run
      directory — then, after the commit, removes `evidence/<runId>/`, `failures/<runId>/` and those
      directories. `pruning reclaims the run's evidence, diagnostics and transient directory` asserts
      all three are gone, and `pruning leaves another run's evidence alone` asserts a run prune did not
      delete keeps its evidence. Verified to fail alone (7/8) when the reclamation is neutralized.
- [x] A directory left by a `collect` that throws is reachable by the same reaper. Proof: the run
      directory is derived from the run's registered agents, so it is reclaimed once the run reaches a
      terminal state and is pruned. Stated honestly: the run must reach that state first, so a
      never-terminating run keeps its directory.
- [x] A dispatch that never registers a worker removes the directory `init` created. Proof: found by a
      full-gate check that counted `/tmp/delegate-graph-herdr-*` before and after — the suite added two
      directories per run, both with `resources: []`, i.e. dispatches blocked at preflight that no
      `collect` ever reaches. `index.ts` now discards on the preflight-block return, before the start
      failure is thrown, and on a throw while materializing evidence, leaving a registered worker's
      directory untouched. Pinned by
      `forwards build access mode and records an unauthenticated route block` and its operations twin,
      which derive the run directory from the launcher invocation and assert it is gone: verified to
      fail (6/8) with the discard neutralized, and the full gate's directory count is now stable at 91
      before and after. **Not found live:** the measurement run's four dispatches all succeeded, so only
      the gate exposed this.
- [x] The evidence-retention guarantee is bounded in the documentation rather than absolute. Proof:
      `AGENTS.md` now reads "a path named at settle time resolves at settle time… bounded by retention",
      and the package README's evidence, failures and run-directory rows all give the lifetime as
      reclaimed by `/graph prune` with the run. The story's ledger entries are what carries the record
      past the evidence.
- [x] The retired-storage-path guard covers Python, where `TMP_ROOT` and `SCRATCH_ROOT` live. Proof:
      `test/graph-home.test.ts` walks `.ts`, `.mjs` and `.py`, and asserts the walk really reaches
      `delegate_core.py` so the wider glob cannot silently stop matching.

**Non-goals for this story:**

- Moving `state.json` into the store. It would make the Python lifecycle a second writer on a store the
  extension owns, and it is not required for correctness.
- Keeping the run directory in `/tmp`, which is right for transient working state and is already the
  documented choice, because a launcher-supplied `TMPDIR` was reaped mid-run on 2026-09-16.
- Reaping the directory of a run that never reaches a terminal state. `prune` only deletes settled
  runs, so a run that hangs forever is never reachable by it; that is the accepted residual, not an
  oversight.
## 4. Functional Requirements

- FR-1: The ownership audit must classify a created directory as a container when it is
  an ancestor of at least one owned path, and must not report it as a violation.
- FR-2: Staging must not require content for a directory and must not fail on an owned
  directory. Parent directories are created implicitly when an owned file is applied.
- FR-3: The ownership audit must keep failing closed on any change that is neither the
  owned path, below an owned path, an ancestor container of an owned path, nor
  platform metadata.
- FR-4: The gate command in `AGENTS.md` must pass from the repository root in a shell
  with no `HERDR_*` environment.
- FR-5: A cleanup path that cannot verify Herdr tab absence must fail closed with a
  named error, never an uncaught `KeyError`.
- FR-6: Attempt teardown must remove the AgentFS mount for that attempt and record the
  removal in cleanup evidence.
- FR-7: The story's execution record must have exactly one writer.
- FR-8: The graph home must be a durable data directory, never a cache directory that invites
  reclamation, because `prune` cascades.
- FR-9: Presentation, settlement and diagnostics must derive from `dirname(dbPath)`, so one
  configured database path moves the whole layout.
- FR-10: No shipped module may resolve a retired storage path; only documentation may name one,
  and only as history.
- FR-11: The store must hold a story's execution record: entries numbered per story, claims each
  carrying an explicit evidence state, and aggregates stored as recorded.
- FR-12: Pruning a run must never delete the story's record of it.
- FR-13: Reading a story back must recompute each aggregate from its own components and report a
  mismatch, never trust the recorded figure.
- FR-14: The build must refuse to open a store whose migrations stop short of
  `CURRENT_SCHEMA_VERSION`, so a forgotten version bump is loud rather than silent.

## 5. Non-Goals

- Reintroducing any `legacy-v1` result contract, worker-authored report file, report
  repair, or owned-path export.
- Reintroducing a per-adapter enablement switch.
- Supporting symlinks, hard links, submodules or special files in staging.
- Preserving an attempt's overlay after a failed settlement; AC3 of the source handoff
  is satisfied by the failure record naming the snapshot state, not by retaining bytes.
- A UI layer; every story here is verified by tests, so no `e2e/tests/` artifact is
  required.
- Making the coverage criterion work inside a read-only mount. The overlay is writable
  and the handoff's §3.4 premise is withdrawn with this PRD.

## 6. Design / Technical Considerations

- `lib/agentfs-sandbox.ts`: `auditAgentFsChanges` builds `owned`, `ignored` and
  `violations` through a single `under(change, paths)` predicate. The container rule
  belongs beside it and must apply to both the allowed and ignored lists.
- `lib/agentfs-sandbox.ts`: `agentFsChangeInventory` deliberately keeps platform
  metadata (`._*`, `.DS_Store`) so the caller decides ownership; `agentFsChanges`
  filters it. Any container rule must not widen ownership of those files when a
  supervisor declares a parent directory.
- `lib/runtime-staging.ts`: `stageRuntimeAgentFs` currently throws on an owned
  directory. Filtering directories out of `changes` keeps `RuntimeStagingManifest`
  unchanged, so no migration and no change to `parseRuntimeStagingManifest`.
- Journal compatibility: `tasks/prd-runtime-owned-results.md` records that the
  integration journal refuses directory creation and deletion. Dropping container
  directories from staged changes avoids that restriction entirely, because
  `exportOwnedAgentFsChanges` and the apply path already create parents with
  `mkdirSync(dirname(target), { recursive: true })`.
- `scripts/delegate_core.py:1622`: `scripts/production-audit.ts:243` already uses the
  `process.env.HERDR_WORKSPACE_ID ?? ""` pattern for an optional-Herdr read; the Python
  side should match it and fail closed.
- `scripts/delegate_core.py`: `ACTIVE_TRANSPORT = "herdr"` is the module default,
  overwritten by `main(transport)`. Any importer that never calls `main` therefore runs
  in Herdr mode, which is precisely how the test driver trips the unguarded read.
- Mount cleanup: `verify_cleanup_absence` already computes `agentFsMountAbsent` from
  `mount` output compared against `agentfs_home`; the missing half is the removal
  action. `agentfs prune mounts` is Linux-only, so macOS needs `umount -f` on the
  recorded mount path.
- Live AgentFS proof is required for US-001: a fixture that writes the delta db
  directly cannot show that a mounted session records a new directory. The probe used
  while writing this PRD ran a real `agentfs run` session and then the real snapshot
  routine.

## 7. Success Metrics

- The full gate reports 0 failures in a plain shell, with the same test count as before
  the change plus the new tests.
- A real `agentfs run` slice that creates a new directory settles with
  `stagedFiles` equal to the number of owned files it wrote.
- `mount | grep agentfs-home` is empty after a settled attempt.

## 8. Open Questions

1. **US-004 slice 1 is done; slices 2 and 3 are not.** Recorded in §3. The decision that was
   open — which writer owns the story's execution record — is settled: `delegate-graph.db`,
   with the durable narrative left in the story's PRD.
2. Does an owned directory with no owned file beneath it deserve a staged change of its
   own? This PRD says no, and US-001 records `stagedFiles: 0` rather than inventing one.
3. Should the leftover run directories in `/private/tmp` be reclaimed by `/graph prune`, or
   by the attempt teardown in US-003? The count stood at 55 after the final gate run; nothing
   in this increment removes a run directory on the failure path. The two hung mounts found
   while writing this PRD were released by hand with `umount -f`, because `agentfs prune
   mounts` refuses off Linux, and neither run directory was removed.
4. **Observed intermittent failure, not yet diagnosed.** `test/herdr-worker-liveness.test.ts`
   case `a malformed liveness answer keeps waiting for the result` failed once in six gate runs
   with `expected: null, actual: 'invalid ACPX worker result: Expecting value: line 1 column 1
   (char 0)'`, and passes 5/5 when its file runs alone. Inferred cause, not proven: the case's
   writer uses `Path.write_text`, which truncates before it writes, so the reader can observe an
   empty `worker-result.json` under load and treat it as invalid instead of continuing to wait.
   If that is the cause it is a real reader-side race, not only a test artifact, and it belongs
   in its own increment rather than this one.
5. Should the home honour `XDG_DATA_HOME` when it is set, falling back to `~/.local/share`?
   Slice 1 implements the literal path that was pinned and reads no new variable. Honouring it
   would be the conventional behaviour of that location, but it adds an entry to a configuration
   surface this repository enumerates explicitly, so it is a decision rather than an oversight.
6. Should the 109 runs left at `~/.cache/delegate-graph/delegate-graph.db` be relocated, or is
   the documented `DELEGATE_GRAPH_DB` escape hatch enough? Slice 1 does neither: it changes the
   default and records the old location as history.