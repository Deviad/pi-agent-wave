# Handoff: a worker's answer does not survive its worker

**Recorded:** 2026-10-03
**Reported by:** the operator, after losing the whole output of a `thinker_plan` worker in
`run_ab8675e8-d3e8-4b2d-bb79-efed9e1e1d7d` (story `ats-adapters-us002`, build graph, Herdr transport)
when the machine rebooted before the supervisor reached `op=collect`
**Affects:** every attempt on both transports, in every graph, between launch and a successful
`op=collect`; most severely read-only nodes, whose answer is their only product
**Does not affect:** attempts that settle normally — settlement retention itself is sound and proven
(`run_46bfcb33` retains 5 candidates for 5 attempts)
**Not a PRD.** This file is a work order, not a plan of record. Read it with `specification.md`
(§5.1, §5.5, §5.6, §2.13) and `product.md`.

**Status:** opened 2026-10-03 against `c096e4a`. Nothing implemented yet. Pre-implementation
verification done the same day (§2a): the orphan is detected and recoverable with today's verbs, and
the AgentFS question in §7 is answered — which changed the coding/operational design in §4.5.

## 1. Summary

A worker's output becomes durable only when `op=collect` succeeds. Until then the single copy lives
in a private run directory under `/tmp`, so the work is lost whenever the worker dies, the transport
dies, the supervisor session ends, or the host reboots.

| # | Issue | Consequence |
| --- | --- | --- |
| 1 | The private run directory is created under `/tmp` | Everything an unsettled attempt produced — stream, answer sink, AgentFS delta, and `state.json` itself — is discarded by a reboot or a `/tmp` sweep |
| 2 | `collect` can only settle from a worker result the worker never wrote | Even with the directory intact, a worker that dies mid-turn settles `failed` and its answer text is discarded although it is on disk |

The two are one defect seen from both ends: **the record of an attempt does not outlive the process
that produced it.** Issue 1 keeps the bytes; Issue 2 turns them back into a candidate. Issue 2 is
worthless without Issue 1, which is why they are one work order and not two.

A third, adjacent defect is already closed and is the reason this one is now visible: a dead worker
is reported as `orphaned` rather than `running`
(`tasks/handoff-unattended-run-reliability.md` §4, `lib/liveness.ts`). The operator is told the
worker is dead; this work order is about not throwing away what it had already said.

## 2. How this was found, and where the evidence is

The operator reported that worker output is visible in Herdr but absent from the store. All facts
below were read on 2026-10-03 at 20:39 CEST from the live store
(`~/.local/share/delegate-graph/delegate-graph.db`, read-only) and the host.

- `run_ab8675e8-d3e8-4b2d-bb79-efed9e1e1d7d` is `active`; its single operation `thinker_plan` is
  `running`; its single `runtime_attempts` row has `candidate_id` NULL, `outcome_json` NULL and
  `finished_at` NULL. The attempt identity names Herdr pane `w2:pF`, tab `w2:tF`, AgentFS session
  `dg-thinker-0-0-62fdd72c6453`, model `alibaba/deepseek-v4.1-flash`.
- No `acpx`, `agentfs`, `delegate_core` or `headless_supervisor` process is alive.
  `herdr tab list` → `server_not_running`.
- `ls -d /tmp/delegate-graph-*` → 0 directories. `evidence/run_ab8675e8-…/` does not exist.
- `kern.boottime` = Sat Oct 3 20:22:34 2026, `uptime` 17 minutes: the host rebooted and `/tmp` was
  cleared while the attempt was unsettled. The worker's stream, its `public-answer.txt`, its AgentFS
  delta and its `state.json` went with it. **The answer is unrecoverable.**
- The mechanism is sound when `collect` runs: `run_46bfcb33` (terminal) has 5 attempts and 5
  retained candidates, and `runtime-content/` holds 23 objects, 312 KB.

So this is not an AgentFS fault and not a retention fault. It is a storage-location fault plus a
missing recovery path.

## 2a. Pre-implementation verification (2026-10-03, 21:05–21:15 CEST)

Evidence and the probe scripts are in `agent-output/durable-worker-record-20261003/`.

**Correction, recorded the same evening.** The first version of `liveness-probe.ts` called
`new GraphStore(dbPath)` with a string; the constructor takes `{ dbPath }`, so it fell back to
`DEFAULT_DB_PATH` and opened the **live** store read-write (WAL, `migrate()`, `chmod`) at about 21:06
and again at 21:14:01. `--experimental-strip-types` performs no type check, so nothing stopped it. The
live file's sha256 changed from `2655395225a5…bb15d2` to `686c3e22c66d…2d741c`; the reference copy
needed to tell which pages changed was deleted in cleanup, so that is unknown. The logical state
was re-read from a raw copy afterwards and matches the morning's reads: `integrity_check ok`, 8 runs,
20 attempts, `run_ab8675e8` `active` with `op_6c32d0f7…` `running`, and no `runs`/`state`
`updated_at` later than `2026-10-03T06:56:16.671Z`. The probe now passes `{ dbPath }` and refuses any
path that is not a `/tmp` copy; the liveness evidence was regenerated with it, and that run left the
live file's sha256 and mtime unchanged. `live-store-untouched.json` covers only the two recovery
rehearsals, during which the sha256 was indeed identical.

- **The orphan is detected.** `liveness-run_ab8675e8.txt`: `op_6c32d0f7…` `stored=running`,
  `liveness=orphaned (attempt-directory-missing)`, `orphaned workers: 1`. The existing reaper
  (`tasks/handoff-unattended-run-reliability.md` §4) classifies it correctly.
- **Both documented recoveries work on its real rows.** `zombie-rehearsal-abort.json` and
  `zombie-rehearsal-retry.json`, driven through the `delegate_graph` tool on a copy: `next` reports
  `orphaned`; `collect` settles the attempt `failed` with `worker orphaned: private run directory
  /private/tmp/delegate-graph-herdr-run-ab8675e8-…._grcts5h no longer exists` and `candidate: null`;
  `retry` parks the run `awaiting_user` with classification `unclassified`; `resolve abort` → run
  `cancelled`; `resolve retry` → run `active`, operation `pending`, ready for a fresh thinker. The
  answer is not recoverable by any path: its bytes no longer exist anywhere.
- **A SIGKILLed AgentFS session leaves a snapshottable delta** (answers §7 question 3).
  `agentfs-postmortem-clean-and-killed.json`, real `agentfs v0.6.4`, the real
  `delegate_core.snapshot_agentfs_db`, and the real `lib/agentfs-sandbox.ts` audit: the clean control
  and the killed session (process group SIGKILLed after its write) both leave `delta.db` plus
  `delta.db-wal`, both snapshot with `method: backup`, both read back `recovered payload` through
  `agentfs fs <snapshot> cat`, and both audit to one owned change `probe.txt` with 0 violations and 0
  errors. No process and no mount survived either kill.
- **A kill during a write can leave a truncated file in the delta.**
  `agentfs-postmortem-midwrite-repeats.jsonl`: a loop appending to one file and creating numbered
  files, SIGKILLed after 3 s, 6 repeats. Snapshot `backup` with `integrity_check ok` 6 of 6; audit and
  inventory errors 0; the appended file had 0 out-of-sequence lines in every repeat; no leftover
  process or mount. In **2 of 6** repeats the file being written at the kill was present with size 0
  (`counter-1388.txt`, `counter-1112.txt`): created, its content never written. The snapshot is
  consistent as a database and faithful to the instant of the kill — which is exactly what makes it
  unsafe to integrate unseen.
- **Method caveat for read-only tooling** (corrected the same evening after a reproduction). The
  macOS system CLI `/usr/bin/sqlite3` 3.51.0 cannot open a WAL database that has no `-wal`/`-shm` in
  read-only mode: `-readonly` and `file:…?mode=ro` exit 14 (`unable to open database file`), and
  `-readonly "$db" ".backup <dest>"` exits 1 **but leaves a 0-byte `<dest>` behind**. My first
  rehearsal ignored that exit code and handed the empty file to `GraphStore`, which migrated it into
  an empty store. The library versions the package uses do not share the limitation: Python's
  `sqlite3` and `node:sqlite` (both SQLite 3.53.4) open the same file read-only and recreate the
  sidecars, provided the directory is writable. Copy the live file raw, check every exit code, and
  verify the copy's run count before using it as evidence.

## 3. Issue 1 — the private run directory is created under `/tmp`

### 3.1 Symptom

Everything an attempt produces before settlement is written under
`/tmp/delegate-graph-herdr-<slug>.<rand>/`, a location the operating system is entitled to clear.

### 3.2 Evidence

- `scripts/delegate_core.py:37`: `TMP_ROOT = Path("/tmp").resolve()`.
- `:251`: `run_dir = Path(tempfile.mkdtemp(prefix=f"{RUN_PREFIX}{slug}.", dir=TMP_ROOT))`.
- `:143`: `require_run_dir` accepts a directory only when its resolved parent is `/tmp`, its name
  starts with `delegate-graph-herdr-`, and it contains `state.json`.
- `:148-168`: `state.json` — the only map from an attempt to its resources — lives in that directory.
  Losing it makes `collect` impossible even if the stream survived.
- `:726-729`, `:747-749`: the attempt directory holds `acpx-home/`, `agentfs-home/` (and therefore
  the AgentFS delta), `prompt.md`, `worker-config.json`, `worker-result.json`,
  `worker.stdout.ndjson` and `worker.stderr.txt`.
- `specification.md` §5.6: `RuntimeOutputFiles` writes `public-answer.txt`, `worker.stdout.ndjson`
  and `public-provenance.ndjson` into `<result-dir>/runtime-output/` **as the worker streams**. The
  answer is therefore already on disk, progressively, in the volatile directory.

### 3.3 Why this matters

The worker prompt (`scripts/delegate_core.py:737`) tells every worker: *"The runtime captures your
full reply durably, so report your evidence and reasoning once and in full."* That statement is
false before `collect`. A read-only node has no other channel at all — `lib/runtime-staging.ts`
discards every overlay change when `readOnly` (`input.readOnly ? [] : audit.owned`), and
`parseRuntimeStagingManifest` refuses a read-only manifest that contains changes. The answer is the
whole product, and the only copy sits in `/tmp`.

### 3.4 Fix options

- **(a) Move the run root under the graph home, recommended.** `<graph home>/runs/`, where the graph
  home is `dirname(DELEGATE_GRAPH_DB)`. The store already owns a durable home for exactly this class
  of data (`runtime-content/`, `evidence/`, `failures/`), and `prune` already resolves and removes
  run directories from `agents.acpx_cancel_script`, so reclamation needs no new mechanism.
- **(b) Keep `/tmp`, copy out periodically.** Rejected as the primary fix: it is the B option the
  operator and this analysis both narrowed away, because a durable write location makes the copy
  redundant. The supervisor's drain already writes partial lines as they arrive
  (`handoff`-era US-008), so a durable destination needs no second writer.
- **(c) A new `PI_DELEGATE_RUN_ROOT` variable.** Rejected for now: deriving the root from
  `DELEGATE_GRAPH_DB` gives tests and the measurement drivers isolation for free, since they already
  set that variable. Add the override only if a real case needs the two separated.

### 3.5 Chosen design (2026-10-03, recorded before implementation)

Option (a).

- The run root is `<graph home>/runs/`, created mode 700, where the graph home is the directory
  containing the graph database: `DELEGATE_GRAPH_DB` when set, otherwise
  `~/.local/share/delegate-graph/delegate-graph.db`. The Python launcher must resolve the same
  default as `store.ts:DEFAULT_DB_PATH`; the two defaults are pinned by a test the way
  `agent_for_model` / `agentForModel` / `selectAcpAgent` are.
- The directory name is unchanged (`delegate-graph-herdr-<slug>.<rand>`), so every path shape, the
  cancel-script-to-run-directory relationship `prune` depends on (three levels up), and the
  liveness reaper's `dirname(agents.acpx_cancel_script)` check keep working untouched.
- `require_run_dir` accepts a directory whose resolved parent is the configured run root. It also
  accepts `/tmp` for one release, so a run started by the previous version can still be collected;
  the compatibility branch is commented with the release that removes it.
- The AgentFS grant stays exactly `--no-default-allows --allow <run-dir>`
  (`scripts/delegate_core.py:778`). The run directory is now a *sibling* of the graph database,
  `runtime-content/`, `evidence/` and `failures/`, not a parent of them, so the grant must not reach
  any of them. This is the one new risk the move introduces and it carries its own criterion below.
- Disk growth moves from a self-clearing volume to the user's home. `/graph prune` becomes the only
  reclaimer, which it already is for `evidence/` and `failures/`. No new retention knob.
- Path length is not a blocker: the deepest path (the AgentFS mount point) grows from 143 to 187
  characters, both already above the 104-byte `sun_path` limit — so nothing in the tree can be a
  unix socket today — and far below `PATH_MAX` 1024. The package's own code uses `AF_INET` only
  (`scripts/stream_endpoint.py:72,98`).

### 3.6 Acceptance criteria

- [ ] `init` creates the run directory under `<graph home>/runs/` and never under `/tmp`.
  Proof: a focused test with a temporary `DELEGATE_GRAPH_DB` asserting the created path's parent and
  its 700 mode, red before the change.
- [ ] The Python launcher's default graph-home resolution equals `store.ts:DEFAULT_DB_PATH`.
  Proof: a test that reads both and asserts equality, in the style of the `agent_for_model` triple
  pin; it must fail if either default is edited alone.
- [ ] A run directory created by the previous version under `/tmp` is still accepted by
  `require_run_dir`, and one outside both roots is refused.
  Proof: a test exercising all three cases (new root accepted, `/tmp` accepted, other refused).
- [ ] A worker cannot write the graph database, `runtime-content/`, `evidence/` or `failures/`
  through its AgentFS grant, nor another attempt's run directory.
  Proof: a test that resolves the launcher's `--allow` argument and asserts none of those paths lies
  under it, plus a live AgentFS check that a write to the database path and to a sibling run
  directory from inside the sandbox is refused. If the host refuses the sandbox, record the blocker
  rather than weakening the test. **Reads cannot be denied** with AgentFS 0.6.4 (§7 question 5): a
  sandboxed worker reads the whole host, so this criterion is about writes only. The original wording
  asked for a refused read; that was unachievable and is withdrawn, not satisfied.
- [ ] An attempt's stream and answer sink survive the death of the worker, the transport and the
  supervisor. Proof: launch an attempt, kill the worker process group, and assert
  `runtime-output/public-answer.txt` and `worker.stdout.ndjson` are still present and non-empty.
- [ ] `prune` still reclaims run directories in the new location.
  Proof: a test that prunes a terminal run and asserts its run directory under `<graph home>/runs/`
  is gone, alongside its `evidence/` and `failures/` entries.
- [ ] `specification.md` §5.1, §2.13 and §7 describe the new location; `extensions/pi-agent-wave/README.md`
  states where run directories live and that `prune` is what reclaims them.

## 4. Issue 2 — `collect` can only settle from a worker result the worker never wrote

### 4.1 Symptom

A worker that dies mid-turn leaves its answer text on disk and no `worker-result.json`. Settlement
reads only the latter, so the attempt settles `failed` and the text is discarded.

### 4.2 Evidence

- `scripts/runtime-settle.ts:parseRuntimeSettleConfig` requires `workerResultPath`;
  `settleRuntimeWorker` reads the worker result (`schemaVersion 2`, `resultContract runtime-v1`) and
  derives outcome, answer and observation from it. There is no other input path.
- `scripts/acpx-worker.ts` writes that file once, at the end of the prompt run
  (`specification.md` §5.6: private temp name, fsync, rename). A worker killed before that point
  writes none.
- The raw material is nevertheless present and already located by the launcher:
  `scripts/delegate_core.py:1452-1462` `worker_stream_source` finds
  `<result-dir>/runtime-output/worker.stdout.ndjson`, and `RuntimeOutputFiles` writes
  `public-answer.txt` beside it as chunks arrive.
- Today that material is used for diagnosis only: `retain_incomplete_capture` (`:1735`) keeps a
  bounded *tail* as private evidence, explicitly "nothing automated reads this file".
- The already-implemented orphan path settles such an attempt `failed`
  (`tasks/handoff-unattended-run-reliability.md` §4.5: `worker orphaned: private run directory … no
  longer exists`). Correct for a missing directory; wrong once Issue 1 keeps the directory.

### 4.3 Why this matters

Issue 1 alone turns a total loss into an unreadable one. The operator would be able to point at the
bytes and still have `collect` record `failed` with no candidate — which is the same lost work with
better forensics. A 17-minute thinker that died at minute 16 has said almost everything it was going
to say.

### 4.4 Fix options

- **(a) Replay the stream into a synthetic worker result, recommended.** When the worker is gone and
  no `worker-result.json` exists, rebuild the capture by feeding the retained
  `worker.stdout.ndjson` through the existing `lib/runtime-capture.ts:RuntimePublicCapture`, and
  settle from that. One new entry point over code that already parses exactly these events.
- **(b) Read `public-answer.txt` directly.** Simpler, but it skips the capture summary
  (`captureStatus`, `sessionId`, diagnostics), so the observation would have to be invented. Rejected:
  settlement records facts.
- **(c) Have the worker checkpoint a partial result periodically.** Rejected: a second writer for
  data the stream already carries, and it changes the worker contract.

### 4.5 Chosen design (2026-10-03, recorded before implementation)

Option (a), triggered only by `op=collect`. No new operator verb.

- Settlement gains a recovery branch, used only when the attempt's worker is not alive and
  `worker-result.json` is absent or unparseable. It replays `worker.stdout.ndjson` through
  `RuntimePublicCapture` and settles from the replayed summary.
- The outcome is the real one — the process is gone, and that is what is recorded. Recovery never
  turns a dead worker into a successful one.
- The candidate is retained when the replayed answer is non-empty, with observation
  `captureStatus: "incomplete"` and an explicit recovered marker, so no consumer can mistake a
  truncated answer for a complete one. An empty replay retains no candidate and stays the existing
  transient `worker-empty-answer` failure.
- **A verdict is never fabricated.** The `VERDICT:` line is honored only when the worker itself
  wrote it into the recovered text; its absence parks the run exactly as it does today. This
  preserves the invariant that a positive semantic verdict never originates from an exit code or
  from the runtime.
- `op=decide` is unchanged and still adjudicates. The decision brief states that the answer is a
  recovered partial, so accepting one is a deliberate operator act.
- For coding and operational attempts the AgentFS delta now also survives (Issue 1), and §2a proves
  it can be snapshotted and audited after a SIGKILL, so recovery is not answer-only. The branch
  snapshots and stages as usual; if a snapshot fails anyway, the answer is still retained and the
  attempt still settles `failed` with the recovered answer attached. Retention precedes everything,
  as it already does.
- **A recovered overlay is an image of the instant of death, not of finished work.** §2a observed a
  file being written at the kill left at size 0 in 2 of 6 repeats, and staging would carry it as an
  ordinary owned change. Integrating it would truncate the real file. Therefore a recovered coding or
  operational candidate is never integrated without an explicit operator `op=decide`, and its
  decision brief lists every recovered file with its byte size, flagging size-0 files, so a truncation
  is visible before acceptance rather than after.

### 4.6 Acceptance criteria

- [ ] A worker killed mid-answer settles through `op=collect` with its partial answer retained as a
  candidate. Proof: an end-to-end test that launches a fake ACPX worker, kills it after it has
  emitted answer chunks, runs `collect`, and asserts a retained candidate whose content matches the
  emitted text and whose observation reports `captureStatus: "incomplete"` and the recovered marker.
- [ ] The recorded outcome still reflects the real process failure, and the operation does not
  advance on it. Proof: the same test asserts the attempt's outcome and that the graph state is
  unchanged until an explicit `op=decide` or `op=retry`.
- [ ] A recovered answer with no `VERDICT:` line parks a verdict node instead of advancing it, and
  one that contains the line is honored as the worker's own statement. Proof: two cases in a focused
  test over the verdict extraction path.
- [ ] A killed worker that emitted no answer text still settles as the existing transient
  `worker-empty-answer` failure, with no candidate. Proof: a case in the same test.
- [ ] Recovery is reachable only through `op=collect`; no new verb and no change to `op=watch`'s
  read-only contract. Proof: the tool-surface test that already pins the verb list.
- [ ] The decision brief names a recovered candidate as partial. Proof: an assertion on the brief
  text in the collect test.
- [ ] A recovered coding candidate is snapshotted and staged from a SIGKILLed session, is never
  integrated without an explicit `op=decide`, and its brief lists each recovered file with its byte
  size and flags a size-0 file. Proof: a test over a real AgentFS session killed mid-write (the
  `midwrite-probe.py` shape in `agent-output/durable-worker-record-20261003/`), asserting the staged
  changes, the size-0 flag when present, and that no integration journal entry exists before the
  decision. If the host refuses AgentFS, record the blocker here rather than faking the delta.
- [ ] `specification.md` §5.5 describes the recovery branch; the README states that a dead worker's
  partial answer is recoverable through `collect`.

## 4a. Issue 3 — the package's SQLite wrapper ignores `readonly`

### 4a.1 Symptom and evidence

`extensions/pi-agent-wave/sqlite.ts:Database` accepts `{ readonly?: boolean }` and discards it
(`constructor(path, _options = {})` → `new DatabaseSync(path)`), so
`new Database(path, { readonly: true })` opens read-write. `node:sqlite` supports the option:
`new DatabaseSync(path, { readOnly: true })` refuses a write with `attempt to write a readonly
database` (verified 2026-10-03). The one shipped caller, `lib/agentfs-sandbox.ts:agentFsChangeInventory`,
opens a staging working copy in a scratch directory and only reads, so nothing is damaged today; the
hazard is the promise. It is the same failure shape as the incident in §2a: a call that looks
read-only and is not.

### 4a.2 Chosen design (2026-10-03, recorded before implementation)

Pass the option through: `new DatabaseSync(path, { readOnly: options.readonly === true })`. Verified
safe for the shipped caller before choosing it: `node:sqlite` 3.53.4 opens a WAL file without
sidecars read-only when its directory is writable, and opens a `DELETE`-journal file read-only even
when it is not — the staging snapshot is `DELETE` (`snapshot_agentfs_db` sets it).

### 4a.3 Acceptance criteria

- [x] `new Database(path, { readonly: true })` refuses a write and still reads. Proof: a focused test,
  red before the change.
  Evidence: `test/sqlite-readonly.test.ts` "a readonly Database reads but refuses to write" failed
  before the `sqlite.ts` change (0 of 1) and passes after (1 of 1).
- [x] Every existing caller of `{ readonly: true }` still passes: the full Node suite.
  Evidence: 619 tests, 608 pass, 0 fail, 11 skipped, `npm run typecheck` exit 0
  (`agent-output/durable-worker-record-20261003/gate-node-suite.log`). Bun package checks not run:
  Bun is not installed on this host.

## 5. Sequencing, ownership and verification

Do Issue 1 first; Issue 2 is not reviewable without it, because there is nothing to recover from.
They are two slices, not one commit.

**Source ownership.** `extensions/pi-agent-wave/scripts/delegate_core.py` owns the run-root change,
`require_run_dir`, and the settlement recovery branch's launcher side.
`extensions/pi-agent-wave/scripts/runtime-settle.ts` and `extensions/pi-agent-wave/lib/runtime-capture.ts`
own the replay entry point. `extensions/pi-agent-wave/store.ts` owns nothing here — no schema change
is needed, which is a deliberate constraint on the design. One writer per file; the two slices touch
`delegate_core.py` in sequence, never in parallel.

**Verification**, from the repository root:

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`
- `npm run typecheck --prefix extensions/pi-agent-wave`
- `git diff --check`
- One authorized live measurement per slice:
  `node --experimental-strip-types test/support/runtime-measure.ts --graph research --execute --repeats 1`
  from `extensions/pi-agent-wave`. It spends provider credit and needs explicit authorization each
  time. Issue 2 additionally needs the kill-mid-answer rehearsal against the fake ACPX worker before
  any live run.

Report counts, skips, failures and the source revision from the run actually made. Never weaken an
assertion to turn a proof green; when the host blocks a criterion, record the blocker here with the
fresh counts.

## 6. Non-goals

- Changing `runtime-v1`, the acceptance model, the graph topology, retry budgets or model policy.
- A shared filesystem between workers. Attempts stay isolated; the only cross-worker channel remains
  `index.ts:materializeRuntimeEvidence`, which hands a worker the accepted answers of *completed*
  operations as read-only files in its own private directory.
- Giving read-only nodes an exported report path. That is a product-contract change, tracked
  separately, and this work order deliberately keeps the answer as the thinker's product.
- Periodic copy-out of a running worker's stream. Narrowed away in §3.4(b); reopen only with a
  measured case that §3.5 does not cover.
- A stall bound for a worker that is alive but silent — owned by
  `tasks/handoff-unattended-run-reliability.md` §11.

## 7. Open questions

1. How long should `require_run_dir` keep accepting `/tmp`? One release is proposed; the alternative
   is a one-off migration at `init` that adopts surviving `/tmp` run directories into the new root.
2. Should a recovered candidate be ineligible for automatic acceptance on *any* node, not only
   verdict nodes — i.e. should `op=decide accepted` on a recovered partial require an explicit
   operator reason string?
3. ~~Does `snapshot_agentfs_db` succeed against a delta database whose AgentFS session is dead?~~
   **Answered 2026-10-03 (§2a): yes**, 1 of 1 after a post-write kill and 6 of 6 after a mid-write
   kill, all with `integrity_check ok` and 0 audit errors. Recovery covers file changes, not only the
   answer — with the truncation caveat now written into §4.5.
4. `op=retry` classifies a dead orphan as `unclassified` and parks the run `awaiting_user` (§2a)
   instead of spending the transient budget. Defensible — the runtime cannot tell a reboot from a
   worker that crashed itself, and an automatic retry may repeat the crash — but it means every
   reboot needs an operator. Retry classification belongs to `retry.ts` and
   `tasks/handoff-unattended-run-reliability.md`, not to this work order; decide there.
   **Decided 2026-10-03**: it is one of four messages for the same event that were classified
   inconsistently by transport and timing; all become transient `worker-gone`. Tracked as Issue 7 in
   `tasks/handoff-unattended-run-reliability.md` §8a.
5. ~~Is `/tmp` passthrough?~~ **Verified 2026-10-03**, real `agentfs v0.6.4`, launched the way the
   launcher launches (`--no-default-allows --allow <run-dir>`, workspace as cwd):
   - writes to `/tmp`, `/private/tmp` and the per-user temp directory `/var/folders/<user>/T/`
     succeed, land **on the host**, and are **not recorded in the delta**, so the audit never sees
     them. This holds whatever `TMPDIR` is set to. The `agentfs run` banner lists `/tmp` but not
     `/var/folders/…/T/`, so the banner is not a complete list. Pointing `TMPDIR` into the run
     directory steers Python's `tempfile` but not `mktemp -d`, so it is not a control;
   - a write to an absolute path under `$HOME` is refused; a write relative to the working directory
     goes only to the overlay;
   - **every host file is readable**, including the live graph database and `~/.pi/agent/auth.json`
     (verified by byte count only, contents not read). A write to the graph database is refused;
   - `agentfs run --help` offers no option to deny `/tmp` or reads (`--no-default-allows` covers only
     `~/.config`, `~/.cache`, `~/.local`, `~/.claude`).

   Evidence: `agent-output/durable-worker-record-20261003/sandbox-writes-and-wal-snapshot.json`
   (write destinations and the post-checkpoint snapshot) and `sandbox-host-reads.jsonl` (byte counts:
   `delegate-graph.db` 651264, `auth.json` 2935, graph database write `refused`).

   Consequences: today every attempt's run directory sits under `/tmp`, so a worker can write into
   any other attempt's run directory — its `worker-result.json`, its settlement inputs, its
   `state.json` (inferred from the verified `/tmp` passthrough, not separately exercised). Issue 1
   removes that channel by moving run directories out of `/tmp`. The read exposure of credentials is
   not addressed by this work order: it needs a sandbox that can deny reads (another OS user, a
   `sandbox-exec` profile, or an AgentFS feature), which is a separate design decision. Both facts are
   recorded as known hazards in `AGENTS.md` and `specification.md` §5.3.
