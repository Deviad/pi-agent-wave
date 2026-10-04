# pi-agent-wave — Technical Specification

This is the implementation-level specification of `@dpugliese/pi-agent-wave`, written from the
current source at revision `50f05b5`. It is detailed enough to reimplement the product in another
language or to run it as a standalone product. Every claim carries the file and symbol it was read
from. Where a component interacts with another, the mechanism that carries the interaction is named.

The package under discussion is `extensions/pi-agent-wave/`. All paths below are relative to that
directory unless they begin with the repository root. The only result contract is `runtime-v1`
(`lib/runtime-results.ts:parseResultContract`); `legacy-v1` was removed on 2026-09-12 and must not be
reintroduced.

---

## 1. Process model and IPC

### 1.1 Which process owns what

The product is a set of cooperating processes. The Pi supervisor session never executes a worker in
its own process; every worker is a separate OS process tree. Ownership is:

| Process | Started by | Owns | Source |
| --- | --- | --- | --- |
| Pi supervisor session (extension host) | Pi | the `delegate_graph` tool, the store handle, the interactive views, policy resolution | `index.ts:delegateGraphExtension`, `store.ts:GraphStore`, `index.ts:resolvePolicy` |
| `scripts/delegate.ts` wrapper | supervisor `pi.exec` (`index.ts:executor`) | transport selection, then `spawnSync` of the Python adapter | `scripts/delegate.ts:main`, `selectTransport`, `delegateInvocation` |
| `scripts/headless_delegate.py` / `scripts/herdr_delegate.py` | the wrapper | entry into the shared lifecycle with the transport fixed | `scripts/headless_delegate.py`, `scripts/herdr_delegate.py`; both call `delegate_core.main(transport)` |
| `scripts/delegate_core.py` (`init`/`start`/`wait`/`cleanup`) | the wrapper | private run directory, attempt materialization, launch, settlement orchestration | `scripts/delegate_core.py:command_init`, `command_start`, `command_wait`, `command_cleanup` |
| `scripts/headless_supervisor.py` (detached) | `command_start` via `subprocess.Popen(..., start_new_session=True)` | the worker's PTY, capture files, the loopback live stream | `scripts/delegate_core.py:launch_headless_worker`, `scripts/headless_supervisor.py:main` |
| `agentfs run` → `node scripts/acpx-worker.ts` (under the PTY) | the attempt's `launch-acpx.sh` | the worker's copy-on-write overlay and the ACPX child process | `scripts/delegate_core.py:prepare_acpx_attempt`, `scripts/acpx-worker.ts:runAcpxWorker` |
| the ACP agent CLI (`pi`, `codex`, `claude`) | `acpx` inside `acpx-worker.ts` | one model turn | `scripts/acpx-worker.ts:buildPromptArgv`, `lib/runtime-process.ts:runRuntimeProcess` |
| Herdr tab/pane (optional) | `delegate_core.py` | presentation of the worker stream | `scripts/delegate_core.py:tab_create_argv`, `herdr.ts` |
| `scripts/runtime-settle.ts` | `settle_runtime_attempt` via `subprocess.run([NODE, …RUNTIME_SETTLE])` | turning a finished worker into retained content + settlement evidence | `scripts/delegate_core.py:settle_runtime_attempt`, `scripts/runtime-settle.ts:settleRuntimeWorker` |
| `scripts/deferred-runner.ts` (launchd) | `launchctl bootstrap` (only the unwired `index.ts:resolveUserDecision` installs it) | one deferred resume | `scheduler.ts:writeDeferredJob`, `installDeferredJob`; `scripts/deferred-runner.ts:runDeferred` |

The supervisor drives the lifecycle through `pi.exec`: for `op=dispatch` it runs
`node --experimental-strip-types scripts/delegate.ts --transport <t> -- init <label>`, then
`-- start …`; for `op=collect` it runs `-- wait <run-dir> <agent>` (`index.ts`, dispatch and collect
branches). The extension's own `delegate_graph` tool is the only mutation surface (`index.ts`).
Before `init`, an `implement` dispatch runs `git -C <realpath(dispatch cwd)> rev-parse --verify
HEAD`; with no revision it is refused through `store.ts:retryRuntimeAttempt` with a
`[dispatch_precondition]` error naming that `base_dir` and the remedy, so the operation is
`failed`, the run `awaiting_user`, and no agent, attempt or run directory exists (`dispatched: false`,
`blocked: "precondition"`). Coding settlement needs the revision the launcher records there, so
without the check the worker's whole turn would be discarded at `collect`.

The same refusal covers declared ownership, for every node rather than only `implement`. A worker
writes only inside the copy-on-write overlay rooted at the dispatch working directory (§5.3), so
before `init` each entry of `owned_paths_json` is resolved against `realpath(dispatch cwd)` and
classified by `lib/agentfs-sandbox.ts:ownedRelativePaths` — the same function the settlement audit
uses, exported for this second call site so the two cannot disagree. An entry that escapes the base,
or one that covers the whole base, is refused with a `[dispatch_precondition]` message naming the
base directory, the offending paths and the remedy for each shape. An empty ownership list skips the
check, so read-only research searches are unaffected. Without it the slice still fails, but only
after a worker turn, as an `AgentFS audit error` carrying `[owned_path_escape]`, which §4.1 already
classifies permanent `unclassified`. The precondition saves that turn and replaces a diagnosis-free
reason with a named one and a remedy; it changes no retry budget.

The check guards the `delegate_graph` dispatch path, which is the only way a run dispatches in
production. `scripts/delegate_core.py`'s `start` subcommand remains reachable directly and is not
covered; today only test drivers invoke it that way.

### 1.2 The detached supervisor process

A headless worker is launched detached. `scripts/delegate_core.py:launch_headless_worker` calls
`probe_stream_endpoint()` before the launch, then
`subprocess.Popen([sys.executable, HEADLESS_SUPERVISOR, "--launcher", …, "--cwd", …, "--stdout", …,
"--stderr", …, "--status", …, "--stream-token", …, "--stream-endpoint", …], stdin=DEVNULL,
stdout=DEVNULL, stderr=DEVNULL, start_new_session=True)`. It therefore survives the
`delegate_core.py start` process and is reaped by the later `wait`/`cleanup` call. Its pid is
persisted into `state.json` through `command_start`'s `record_pid` callback, which re-acquires the
state lock with `mutate_state` and matches the resource by agent name.

`scripts/headless_supervisor.py:main` requires the private PTY executable `script`
(`shutil.which("script")`, error otherwise) and starts the worker under it. On Darwin the argv is
`[script, "-q", "/dev/null", launcher]`; on other supported systems it is
`[script, "-q", "-c", shlex.quote(launcher), "/dev/null"]`. It opens the stdout/stderr capture
files, starts one `drain` thread per stream, waits for the worker, joins the threads, closes the
publisher and removes the endpoint descriptor, then writes `status.json` (schema 1, `workerPid`,
`exitCode`) mode 600. The supervisor exits with the worker's exit code.

### 1.3 ACP over stdio

`scripts/acpx-worker.ts` runs two ACPX invocations:

- **Session ensure.** `buildEnsureArgv` produces
  `acpx --cwd <process.cwd()> --format json --json-strict --timeout <configured> --ttl 5 <agent>
  sessions ensure --name <sessionName>`; the result is read as JSON and the `session_ensured`
  action's `acpxSessionId` is required (`runAcpxWorker`). `ensureAcpxSession` retries exactly once
  after ~100 ms when the failure text contains `Cannot call write after a stream was destroyed`. If
  the ensure still fails, the worker writes the schema-2 worker result anyway, with a `failed` outcome
  whose error is `ACPX session ensure failed after <n> attempt(s): <acpx output>` and an empty capture
  (the ACPX output kept as `runtime-output/worker.stderr.txt`, beside an `environment.json` naming the
  working directory, the ACPX home, their lengths, and the environment given to ACPX with values kept
  only for `PATH`, `HOME`, `TMPDIR`, `NODE_*`, `npm_config_*` and `ACPX_*` names that are not
  secret-shaped), so `collect` settles the attempt at once; a missing `acpx` executable still throws
  without a result (`tasks/handoff-worker-startup-failure.md`). Before settlement removes the attempt,
  `delegate_core.py:write_failure_diagnostics` copies that stderr and environment, the prompt-time
  `worker-config.json`, the ACPX home's `.npm/_logs/*.log` (as `_logs/`) and `.acpx/` tree (as
  `acpx-state/`), and a `versions.json` (`agentfs`, `acpx`, `pi`, `node`, resolved `pi-acp`) into
  `<graph home>/evidence/<runId>/startup-failure-<operation>-<transient>-<model>/`, each file private
  and redacted, never a credential or `.claude.json`; the failure bundle names it as
  `startupFailureEvidence` (`tasks/handoff-worker-session-ensure-diagnostics.md`).
- **Prompt.** `buildPromptArgv` produces
  `acpx --cwd <process.cwd()> --format json --json-strict --timeout <configured> --ttl 5 --model
  <model> --permission-policy <json> --non-interactive-permissions fail [--no-terminal] <agent>
  --session <sessionName> --file <promptFile>`. The prompt is run through
  `lib/runtime-process.ts:runRuntimeProcess`, which spawns it with `shell: false`, pipes stdout and
  stderr into `lib/runtime-output.ts:RuntimeOutputFiles`, and feeds stdout to
  `lib/runtime-capture.ts:RuntimePublicCapture`. `--cwd` is `process.cwd()` and the model argument
  is `lib/acpx-select.ts:acpxModelArgument` (outer provider prefix stripped for Codex and Claude).
- **Close.** When `config.mode === "close"` the worker runs `acpx <agent> sessions close <name>`
  and `acpx <agent> status --session <name>`, and writes
  `{schemaVersion:1, mode:"close", processExitCode, sessionName, closed, noSession}`
  (`runAcpxWorker` close branch). `closed` comes from a `session_closed` action and `noSession`
  from a `status_snapshot` action with status `no-session`.

`lib/acpx-permissions.ts:acpxPermissionPolicy(readOnly)` can express two policies: a read-only policy
that auto-approves `read`/`search`/`execute` and auto-denies `edit`/`delete`/`move`, and an
owned-write policy that auto-approves all classes; both use `defaultAction: "deny"`. The prompt
invocation currently passes `acpxPermissionPolicy(false)`, i.e. it always requests the all-approve
policy; the actual preventative filesystem boundary is AgentFS, and read-only attempts are those
that never stage an owned-write snapshot (§5.4).

The ACP session identifier observed in the stream is not assumed to equal the ensured one: the
capture records the session the prompt actually ran in and its origin (`expected`, `loaded`,
`created`, `resumed`) (`lib/runtime-capture.ts:RuntimePublicCapture.bindSession`,
`RuntimeCaptureSummary.sessionOrigin`). Protocol interpretation never changes the recorded process
outcome: `runRuntimeProcess` derives `RuntimeOutcome` from cancellation/timeout/failure/signal/exit
code only (`lib/runtime-process.ts:runRuntimeProcess`).

### 1.4 The shared SQLite store as the coordination substrate

All durable coordination goes through one SQLite database. `sqlite.ts:Database` is a thin wrapper
over `node:sqlite`'s `DatabaseSync`, presenting `exec`/`query().run|get|all`/`close`.
`store.ts:GraphStore` opens (or creates) the database, runs
`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON`, runs migrations, and
chmods the file 600 in its constructor. Every state mutation runs inside `BEGIN IMMEDIATE` through
either the general `store.ts:transaction` helper or a migration body; the integration journal has
its own `lib/runtime-integration.ts:RuntimeIntegration.transaction`, also `BEGIN IMMEDIATE`. WAL plus
the busy timeout lets readers proceed during a write.

The single-active-attempt invariant is the partial unique index
`runtime_attempts_active ON runtime_attempts(operation_id) WHERE superseded_at IS NULL`, created in
v8 (`store.ts:migrateToV8`). The integration journal lives in the same database in
`runtime_integrations` with a partial unique index
`runtime_integration_owner ON runtime_integrations(workspace) WHERE state IN
('prepared','applying','needs_reconciliation')` and a manifest-immutability trigger
(`lib/runtime-integration.ts:RuntimeIntegration` constructor).

### 1.5 The per-attempt loopback live-stream endpoint and its bearer token

A headless worker has no pane, so its supervisor publishes its output live over loopback TCP
(`scripts/stream_endpoint.py`).

- **Resolver and probe.** `resolve_stream_backend(system)` returns `loopback-tcp` for the supported
  platforms `("Darwin", "Linux", "Windows")`, and raises `ValueError` elsewhere.
  `probe_stream_endpoint(host="127.0.0.1")` binds `127.0.0.1:0` and raises
  `live worker stream unavailable: cannot bind a loopback listener on 127.0.0.1 (<code>)` when the
  bind fails. `launch_headless_worker` calls the probe before dispatch, and
  `headless_supervisor.py:main` calls both `resolve_stream_backend()` and `probe_stream_endpoint()`
  before starting the publisher.
- **Publisher.** `stream_endpoint.py:StreamPublisher.__init__` binds `127.0.0.1:0`, calls
  `secrets.token_hex(TOKEN_BYTES)` with `TOKEN_BYTES = 32`, and writes the token mode 600 via
  `publish_private_file` to the path the launcher passes (in production
  `<run-dir>/headless-<slug>.stream-token`, from `command_start`). The descriptor
  `{"schemaVersion":1,"backend":"loopback-tcp","host":…,"port":…}` is written atomically by
  `headless_supervisor.py:main` to `<run-dir>/headless-<slug>.stream-endpoint.json`. `_greet` reads
  the first line as the bearer token and compares it with `secrets.compare_digest`; a mismatch gets
  `unauthorized\n` and is closed. A subscriber is then set non-blocking and handed the backlog.
- **Backlog.** The publisher keeps a bounded window of recent output:
  `STREAM_BACKLOG_CHUNKS = 200` and `STREAM_BACKLOG_BYTES = 64 * 1024`; `publish` trims from the
  oldest end while either bound is exceeded. The channel is a view, never a record; the file capture
  is the record.
- **Non-blocking delivery.** `_send` performs one `sendall` on the non-blocking socket; a
  `BlockingIOError`/`OSError` means the subscriber is dropped rather than waited for, so a slow
  viewer can never backpressure the drain thread, the capture file or the worker's PTY.
  `close()` closes the listener, drops subscribers and removes the token file.
- **Drain.** `headless_supervisor.py:drain` reads with `raw.read1(READ_CHUNK_BYTES)` (8192),
  decodes incrementally, normalizes `\r\n` and `\r` to `\n`, carries a trailing `\r` to the next
  read so a split `\r\n` is not mis-normalized, and writes each chunk to both the capture file and
  `publisher.publish`.
- **Consumer.** `lib/live-stream.ts:refreshLiveView` resolves the endpoint for an attempt key,
  connects, sends the token, and reads the backlog for at most `REFRESH_BUDGET_MS = 1200` ms with a
  `QUIET_MS = 150` ms quiet window and a `MAX_BYTES = 256 * 1024` cap. It strips ANSI with
  `stripAnsi`, splits/drops blank lines, truncates to `LINE_LIMIT = 160` characters and keeps the
  last `lineLimit` lines. `streamRunDirectory` finds the run directory by searching upward from the
  agent's cancel script (default 5 levels) for a `*.stream-endpoint.json` file; `streamEndpointIn`
  reads the descriptor and the sibling `*.stream-token`. The poll-and-disconnect model is deliberate
  (module comment): a long-lived subscriber that fell behind would be dropped and lose its view.

### 1.5a Read-time worker liveness (`lib/liveness.ts`)

`runLiveness(store, runId)` classifies each current `running` operation whose attempt is registered,
unsettled and not superseded, in this order: `worker-result.json` in the attempt directory
(`dirname(agents.acpx_cancel_script)`) → `awaiting-collect`; attempt directory absent → `orphaned`
(`attempt-directory-missing`); within `LAUNCH_GRACE_MS` (60 s) of `agents.last_activity_at` →
`alive`; `ps -Ao command=` unreadable → `unknown` (`process-table-unreadable`); no line containing
`agents.agentfs_session_id` or the attempt directory → `orphaned` (`worker-process-gone`); else
`alive`. `acpx_state` is not read. The table is read at most once per call and only when a worker
needs it. `op=next` overlays `status: "orphaned"`, `storedStatus`, `orphanReason`, `recovery`;
`renderStatus` shows `orphaned (<reason>)` and an `orphaned workers: <n>` line; `watchRun` shows it as
the process state. None of them writes the store. `collectRuntimeAttempt` settles an unsettled attempt
whose private run directory is gone as `failed` (`worker orphaned: private run directory … no longer
exists`) without invoking the launcher; `retry` then classifies it permanent (`unclassified`) and the
run parks for `resolve`; that orphan path also calls `herdr.ts:closeRunTabs` for the worker and retains
`evidence/<runId>/tab-cleanup-<operationId>.json`. `index.ts:closeEndedRunTabs` runs after `decide`,
`resolve`, `cancel` and `cancelRunWorkers` when the run is `cancelled` or `terminal`: it lists tabs once
(`herdr tab list`), and closes each `agents.tab_id` of a `herdr` agent of the run whose listed label
starts with `<runId>-`; a reused id under another label is `not-owned`, a missing one `absent`. The
report is retained as `tab-cleanup-<status>.json`. No stall bound exists: `last_activity_at` is written only at registration
and settlement, so it serves only as the launch grace.

### 1.6 Herdr IPC

Herdr is driven only through its CLI with direct argv, never a shell. The commands used are:
`herdr tab create` and `herdr tab close` (`scripts/delegate_core.py:tab_create_argv`,
`close_created_tab`), `herdr pane run`, `herdr pane get`, `herdr pane report-agent`,
`herdr pane release-agent` (`scripts/delegate_core.py`), `herdr pane read`
(`lib/pane-read.ts:readPane`), `herdr agent get`, `herdr agent focus`
(`scripts/delegate_core.py:herdr_agent_registered`; `herdr.ts:focusHerdrAgent`), `herdr tab list` (also
`herdr.ts:closeRunTabs`, which closes with `herdr tab close`), `herdr integration status|install`
(`scripts/delegate_core.py:integration_status`, `ensure_pi_integration`). The pane reader runs
`herdr pane read <pane> --source recent --lines <n> --format text` with a 1000 ms timeout and
`SIGKILL` (`lib/pane-read.ts:PANE_READ_TIMEOUT_MS`, `readPane`). No settle decision reads a pane's agent
status: `wait_for_settled_agent` settles only on the worker's result file and refuses a resource
that has none; `herdr agent get <pane>` is an advisory liveness probe that can only end a wait early.
So is the process table: a pane outlives a worker that died early (its shell returns to the prompt
and Herdr keeps reporting the agent), so after `WORKER_LAUNCH_GRACE_S` (60 s, mirroring
`lib/liveness.ts:LAUNCH_GRACE_MS`) each liveness probe also runs `ps -axo command=`
(`worker_process_present`) and ends the wait with `Herdr worker process gone before result` when no
line carries the attempt's AgentFS session or attempt directory; an unreadable table keeps waiting.

### 1.7 The launchd deferred resume

`scheduler.ts:parseDeferredTime` parses either an ISO-8601 timestamp or a relative `+Nm`/`+Nh`. It
requires a future time. `scheduler.ts:writeDeferredJob` writes a self-removing launchd plist
(`se.pi.delegate-graph.<run>-<op>`, sanitized and truncated) mode 600 under
`<graph-home>/deferred/`, embeds a resume prompt naming the run, operation and frozen policy digest,
and returns the label, plist path, runner path and time. `scheduler.ts:installDeferredJob` runs
`plutil -lint` then `launchctl bootstrap gui/<uid>` with direct argv. `scripts/deferred-runner.ts:runDeferred`
parses its arguments, runs `pi -p <prompt>` once, then always `launchctl bootout gui/<uid>/<label>`
and removes the plist.

The only caller of `writeDeferredJob`/`installDeferredJob` is `index.ts:resolveUserDecision`
(`index.ts:836`–`837`), whose "Defer" choice calls
`store.resolveExhaustion(runId, operationId, "defer", …)`, `writeDeferredJob`, and
`installDeferredJob`. That function is exported but has no production caller — a full-tree search
finds only its definition and two direct test invocations (`test/commands.test.ts:201,236`) — so no
command and no `delegate_graph` operation installs a deferred job. The shipped README records this
(`extensions/pi-agent-wave/README.md`: "A terminal picker for that choice (`resolveUserDecision`)
exists in the code but is not wired to any command or tool path."). The reachable recovery paths for
a parked run are `delegate_graph op=resolve` and `/graph resume`, and neither writes a launchd plist;
the launchd job is present code that is not on a dispatchable path.

---

## 2. The store schema and its migrations

`store.ts:CURRENT_SCHEMA_VERSION = 13`. `GraphStore.migrate()` issues a base
`CREATE TABLE IF NOT EXISTS` block, seeds `schema_version(version)` to 1 when empty, then runs
`migrateToV2()` … `migrateToV13()` in order. Each migration inspects columns so an interrupted
migration repairs idempotently, and `migrate()` throws if the final `schema_version` is not
`CURRENT_SCHEMA_VERSION`. The base block is evolved with the build: it already contains some columns
that an older store received through a later migration (notably `operations.command_json`), so the
version migrations below must be read as the repairs and additions they perform, not as the literal
history of the base `CREATE`.

### 2.1 v1 — base tables

The base block creates:

- `schema_version(version INTEGER PRIMARY KEY)`.
- `runs(id TEXT PRIMARY KEY, story TEXT, graph_name CHECK(graph_name IN
  ('build','research','operations')), task TEXT, status CHECK(status IN
  ('active','terminal','blocked','awaiting_user','deferred','cancelled')), created_at, updated_at)`.
- `graphs(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, name, definition_json,
  sha256)`.
- `agents(id TEXT PRIMARY KEY, run_id REFERENCES runs(id) ON DELETE CASCADE, name, node, role,
  transport, herdr_agent, tab_id, status CHECK(…'pending','running','completed','failed','blocked',
  'cancelled'), current_task, created_at, last_activity_at, UNIQUE(run_id,name))`.
- `operations(id TEXT PRIMARY KEY, run_id REFERENCES runs(id) ON DELETE CASCADE, node, slice_id,
  agent_id REFERENCES agents(id), status CHECK(…same six…), read_only CHECK(read_only IN (0,1)),
  owned_paths_json DEFAULT '[]', round, fix_iteration, transient_attempts DEFAULT 0, command_json,
  task, verdict, classifier_reason, last_error, retry_not_before, created_at, started_at,
  finished_at)`.
- `events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts, run_id REFERENCES runs(id) ON DELETE CASCADE,
  operation_id REFERENCES operations(id), agent_id REFERENCES agents(id), type, node, from_agent,
  to_agent, reply_to, from_node, to_node, verdict, payload_json DEFAULT '{}')`.
- `state(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, current_node, round,
  fix_iteration, status CHECK(…same six…), updated_at)`.
- Indexes `idx_operations_current(run_id,node,round,fix_iteration,status)`,
  `idx_events_run_ts(run_id,ts,id)` and `idx_agents_run(run_id,status)`.
- `schema_version` seeded to 1.

### 2.2 v2 — frozen policy and model observability

`store.ts:migrateToV2` runs inside `BEGIN IMMEDIATE` and uses `ensureColumn` to add
`runs.policy_json TEXT NOT NULL DEFAULT '{}'`, `runs.policy_digest TEXT NOT NULL DEFAULT ''`,
`operations.model_attempt INTEGER NOT NULL DEFAULT 0`, `operations.selected_model TEXT`,
`operations.retry_reason TEXT`, `operations.fallback_reason TEXT`, `agents.policy_digest TEXT`,
`agents.selected_model TEXT`, `agents.model_attempt INTEGER NOT NULL DEFAULT 0`.

It then backfills every `runs` row whose `policy_digest` is empty: if the existing `policy_json`
parses to a valid `ResolvedPolicy` it is re-canonicalized, otherwise the canonical
`DEFAULT_AUTO_POLICY` is stored; the digest is `sha256(stableStringify(policy))`
(`store.ts:stableStringify`, `policyDigest`). It writes `schema_version = 2` and commits. The policy
digest is re-verified whenever the run is read (`store.ts:policy` recomputes it and throws on
mismatch).

### 2.3 v3 — operations graph and structured commands

`store.ts:migrateToV3` first adds `operations.command_json` if missing (the column exists in the
current base block, so this is the repair path), then, with `PRAGMA foreign_keys = OFF`, opens one
`BEGIN IMMEDIATE`, creates `runs_v3` including the `operations` value in the `graph_name` CHECK and
the `policy_json`/`policy_digest` columns, copies from `runs`, drops `runs`, renames `runs_v3` to
`runs`, sets `schema_version = 3`, and commits. It re-enables foreign keys in `finally` and checks
`PRAGMA foreign_key_check` before returning, throwing on any violation.

### 2.4 v4 — ACPX provenance

`store.ts:migrateToV4` runs inside `BEGIN IMMEDIATE` and adds nullable columns to `agents`:
`acp_agent`, `acpx_record_id`, `acpx_session_id`, `acpx_state`, `acpx_attempt_key`,
`agentfs_session_id`, `agentfs_db_path`, `herdr_pane_id`, `acpx_cancel_script`. It counts rows with a
partial identity (some but not all of the ACPX/AgentFS set) and throws
`agents table contains inconsistent partial ACPX/AgentFS identity` if any exist. It then creates
`agents_acpx_identity_insert` and `agents_acpx_identity_update` triggers that abort unless the
provided provenance set is either entirely absent or entirely present. It writes
`schema_version = 4`.

### 2.5 v5 — transport-aware presentation

`store.ts:migrateToV5` runs inside `BEGIN IMMEDIATE`. It first rewrites retired labels: rows whose
`transport` is `delegate` or `opaque-delegate` become `herdr` only when they carry a complete Herdr
triple or carry no ACPX identity at all; any other retired-labelled row keeps failing closed below.
It then counts invalid presentation rows — a transport outside `('headless','herdr')`, a `herdr` row
with a partial or missing triple when it has an ACPX agent, or a `headless` row carrying any Herdr
identity — and throws `agents table contains invalid transport presentation identity` if any exist.
It drops the v4 triggers and recreates `agents_acpx_identity_insert`/`_update` requiring a valid
transport, a complete Herdr triple for `herdr`, no Herdr identity for `headless`, and a complete
ACPX set. It writes `schema_version = 5`, commits, and checks `PRAGMA foreign_key_check`.

### 2.6 v6 — `runtime_attempts`

`store.ts:migrateToV6` runs in `store.transaction`. While `schemaVersion() < 10` it adds
`runs.result_contract TEXT NOT NULL DEFAULT 'runtime-v1' CHECK(result_contract IN
('legacy-v1','runtime-v1'))` (the column exists only on v6–v9 databases). It creates
`runtime_attempts(attempt_key TEXT PRIMARY KEY, run_id REFERENCES runs(id) ON DELETE CASCADE,
operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE, identity_json CHECK
json_valid, outcome_json CHECK, candidate_json CHECK, candidate_id TEXT UNIQUE, started_at,
finished_at)` with two settlement-completeness CHECKs: an outcome and `finished_at` are either both
present or both absent; a candidate and `candidate_id` are either both absent or both present with an
outcome. It creates `runtime_attempts_identity_immutable` (identity fields may never be updated) and
`runtime_attempts_settlement_immutable` (an attempt with an outcome may never have its settlement
rewritten). It writes `schema_version = 6`, and while `schemaVersion() < 10` creates
`runtime_attempts_identity_insert`, which requires a matching operation and a `runtime-v1` contract.

### 2.7 v7 — decisions and adapter evidence

`store.ts:migrateToV7` runs in `store.transaction`. It adds `runtime_attempts.observation_json` and
`runtime_attempts.agent_id REFERENCES agents(id)`. It creates
`runtime_decisions(attempt_key TEXT PRIMARY KEY REFERENCES runtime_attempts(attempt_key) ON DELETE
CASCADE, candidate_id, decision CHECK(decision IN ('accepted','rejected')), verdict, reason CHECK
length(trim(reason)) > 0, integration_id, payload_json CHECK, decided_at)` with an immutability
trigger `runtime_decisions_immutable` and a `runtime_decisions_candidate` trigger requiring the
attempt to carry the same candidate. It creates `runtime_adapters(agent TEXT PRIMARY KEY CHECK(agent
IN ('pi','codex','claude')), evidence CHECK nonempty, enabled_at)` (removed again in v11). It writes
`schema_version = 7`.

### 2.8 v8 — fenced replacement

`store.ts:migrateToV8` rebuilds `runtime_attempts` because SQLite cannot drop the v6
`operation_id UNIQUE` constraint in place. It sets `PRAGMA foreign_keys = OFF`, opens one
`BEGIN IMMEDIATE`, re-checks the version under the lock, drops `runtime_decisions_candidate`, creates
`runtime_attempts_v8` with the v6 columns plus `observation_json`, `agent_id`, `superseded_at`, and
the added `CHECK(superseded_at IS NULL OR outcome_json IS NOT NULL)`, copies the rows, drops the old
table, renames the new one, and creates the partial unique index
`runtime_attempts_active ON runtime_attempts(operation_id) WHERE superseded_at IS NULL`. It recreates
all triggers, including `runtime_attempts_superseded_immutable` and a corrected
`runtime_decisions_candidate` requiring the active (`superseded_at IS NULL`) settled candidate. It
writes `schema_version = 8`, validates `PRAGMA foreign_key_check`, and commits; foreign keys are
re-enabled in `finally`.

### 2.9 v9 — operations on runtime-v1

`store.ts:migrateToV9` runs in `store.transaction` and drops `runs_result_contract_graph` (the
trigger that enforced the operations graph's contract before operational runs were runtime-v1). It
sets `schema_version = 9`.

### 2.10 v10 — remove the report contract

`store.ts:migrateToV10` refuses to migrate a database that still contains a `legacy-v1` run: it
checks `hasColumn("runs","result_contract")` and counts `WHERE result_contract='legacy-v1'`, throwing
`v10 migration refused: … legacy-v1 run(s) remain` if any. It then, with foreign keys off and one
`BEGIN IMMEDIATE`, drops `runtime_attempts_identity_insert`, rebuilds `runs_v10` without
`result_contract`, rebuilds `operations_v10` without `report_path` (the omitted column), copies both,
drops and renames both, recreates `idx_operations_current`, and recreates
`runtime_attempts_identity_insert` without the contract check. It writes `schema_version = 10`,
validates `PRAGMA foreign_key_check`, and commits.

### 2.11 v11 — drop adapter enablement

`store.ts:migrateToV11` runs one `BEGIN IMMEDIATE` and executes
`DROP TABLE IF EXISTS runtime_adapters`, then writes `schema_version = 11`. There is no per-adapter
enablement gate: a worker runs on the adapter its frozen model selects.

### 2.12 v12 — story ledger

`store.ts:migrateToV12` runs one `BEGIN IMMEDIATE` and creates:

- `ledger_entries(id TEXT PRIMARY KEY, story, sequence CHECK(sequence > 0), topic, run_id, tier,
  model, outcome CHECK(outcome IN ('accepted','blocked','failed')), dispatched_at, task)` plus a
  unique index `ledger_entries_sequence(story, sequence)`.
- `ledger_claims(entry_id REFERENCES ledger_entries(id) ON DELETE CASCADE, position, claim,
  evidence, status CHECK(status IN ('verified','unverified','unverified-recall')), PRIMARY
  KEY(entry_id, position))`.
- `ledger_aggregates(entry_id REFERENCES ledger_entries(id) ON DELETE CASCADE, position, name,
  numerator REAL, denominator REAL, percentage REAL, PRIMARY KEY(entry_id, position))`.

The `ledger_*` tables deliberately hold **no foreign key to `runs`** (module comment and
`store.ts:migrateToV12`). The sequence is computed inside the inserting transaction
(`store.ts:recordLedgerEntry`, `SELECT COALESCE(MAX(sequence),0)+1 AS next FROM ledger_entries WHERE
story=?`); `BEGIN IMMEDIATE` serializes writers and the unique index refuses a duplicate rather than
allowing a gap. `store.ts:auditStoryLedger` recomputes `numerator/denominator*100` and reports
`AGGREGATE_MISMATCH` when the recorded percentage differs by more than `1e-9`, plus `LEDGER_EMPTY`
(no entries), `SEQUENCE_GAP` (an entry whose `sequence` is not its 1-based position), and
`AGGREGATE_INVALID` (a non-finite figure or a zero denominator). `scripts/story-ledger.mjs` is the
CLI over `recordLedgerEntry`, `auditStoryLedger` and `storyLedger`.

### 2.12a v13 — home workspace root

`migrateToV13` adds `runs.workspace_root TEXT` additively (`ensureColumn`, one immediate transaction,
`schema_version` 13). NULL for every existing run and every repository run; a home run records its
real working directory (§5.1a). No row is rewritten.

### 2.13 Single-writer, transaction and retention rules

- Every state change is inside `BEGIN IMMEDIATE` (`store.ts:transaction`, migration bodies,
  `lib/runtime-integration.ts:RuntimeIntegration.transaction`). WAL plus `busy_timeout=5000` lets
  readers run during a write.
- `agents` provenance and `runtime_attempts` identity/settlement rows are append-only and immutable
  by trigger; a settled attempt may be superseded (`superseded_at`) but not rewritten, and a
  superseded row becomes fully immutable (`runtime_attempts_superseded_immutable`).
- A runtime attempt registers only while its operation is `pending` and current for the graph state
  (`store.ts:beginRuntimeAttempt`), and settles by committing facts only
  (`store.ts:settleRuntimeAttempt` infers no report, verdict, retry or graph transition).
- Retention: `store.ts:prune(days)` selects `terminal|blocked|cancelled` runs with
  `updated_at < now - days*86400000`, resolves each run's transient directories from
  `agents.acpx_cancel_script` **before** deleting rows (a cancel script sits three levels below its
  run directory), deletes the runs inside one transaction, then removes
  `<graph-home>/evidence/<runId>/` and `<graph-home>/failures/<runId>/` and each collected run
  directory. Filesystem removal runs after the commit. The `ledger_*` rows are never pruned, and
  `runtime-content/` is content-addressed and is not reclaimed by `prune` (only `evidence/`,
  `failures/` and the transient run directories are).
  Run directories live under `<graph home>/runs/` (§5.1), so `prune` is their only reclaimer: they
  no longer sit on a self-clearing volume. The resolution through `agents.acpx_cancel_script` is
  location-independent, so a run directory left in `/tmp` by an earlier version is reclaimed the same
  way.
- The launcher's own `state.json` is serialized by a directory lock with an orphan check and written
  by atomic rename (`scripts/delegate_core.py:mutate_state`, `clear_orphaned_state_lock`,
  `write_state`).

---

## 3. The scheduler and the graph-core transition rules

### 3.1 Graph definitions

`graph-core.ts` exports `BUILD_GRAPH`, `RESEARCH_GRAPH`, `OPERATIONS_GRAPH` and
`graphDefinition(kind)`. Each node is `GraphNodeDefinition` from `types.ts`: `{name, role, fanOut,
readOnly}`.

- `BUILD_GRAPH`: `thinker_plan` (thinker, read-only) → `implement` (implementer, fan-out,
  writable) → `review` (reviewer, read-only) → `test` (tester, read-only) → `audit` (auditor,
  read-only).
- `RESEARCH_GRAPH`: `thinker_split` (thinker, read-only) → `search` (searcher, fan-out, read-only)
  → `thinker_synthesize` (thinker, read-only).
- `OPERATIONS_GRAPH`: `source_search` (searcher, fan-out, writable) → `thinker_synthesize` (thinker,
  read-only) → `audit` (auditor, read-only).

`store.ts:initRun` serializes the definition into `graphs.definition_json` with a sha256
(`store.ts:graphHash`).

### 3.2 `decideTransition`

`graph-core.ts:decideTransition(input: TransitionInput)` is a pure function of
`{graph, currentNode, round, fixIteration, verdict, allComplete}` and returns a
`TransitionDecision` `{kind, nextNode, round, fixIteration, replyTo, reason}`. If `allComplete` is
false it returns `stay` on `join:<currentNode>`. Otherwise it uppercases the verdict and applies:

- **Research:** `thinker_split` → `search`; `search` → `thinker_synthesize`; `thinker_synthesize` →
  terminal.
- **Operations:** `source_search` advances to `thinker_synthesize` only on `DONE`, otherwise
  `blocked`; `thinker_synthesize` advances to `audit` only on `DONE`, otherwise `blocked`; `audit`
  terminates only on `PASS`, otherwise `blocked`.
- **Build:** `thinker_plan` → `implement`; `implement` → `review`; `review` `PASS` → `test`,
  `FAIL` → `implement` with `fixIteration + 1` (blocked at `fixIteration >= 2` with
  `review fix-iteration cap reached`), any other verdict blocked; `test` `GREEN` → `audit`,
  `NOT_OK` → `implement` with `round + 1` and `fixIteration` reset to 0 (blocked at `round >= 3`
  with `semantic implementation-round cap reached`), any other verdict blocked; `audit` `PASS` →
  terminal, otherwise blocked.

There is no positive-verdict-from-exit-code rule anywhere: verdicts come from the answer and are
uppercased for comparison.

### 3.3 The scheduler in the store

`store.ts:next(runId)` returns `operations(runId, currentOnly = true)` — the operations of the
current `(node, round, fix_iteration)` phase, ordered by `created_at, id` — each decorated with its
frozen role `PolicyRoute` (`routeForNode`) and its active `RuntimeAttempt` (`runtimeAttemptForOperation`),
plus the frozen `FrozenPolicy`. `store.ts:operations(runId, false)` returns every operation of the run.

`store.ts:initRun` inserts the run, the frozen graph, the state row (initial node, round 1,
fixIteration 0, status `active`), a `run_initialized` event, and the initial operation(s):
`insertOperation` for each structured operational command, or one operation for the task. Fan-out
nodes get one operation per slice.

`store.ts:createNextOperations` materializes the next phase:

- For `implement` or `search`: slices come from the completed thinker's `payload.slices`
  (`store.ts:slicesFromPayload`, requiring at least one slice with `id`, `name`, `task`) when the
  current node is `thinker_plan`/`thinker_split`, or from the previous implement phase
  (`store.ts:previousSlices`, the highest `fix_iteration` at that round) on a rework cycle. Build
  implementation slices are checked for disjoint ownership (`store.ts:assertDisjointOwnership`);
  research searches are forced read-only with empty owned paths.
- For `review`, `test`, `audit`, `thinker_synthesize`: one operation with the canned task from
  `taskByNode`.

`store.ts:insertOperation` assigns a new `op_<uuid>`, sets
`read_only = nodeIsReadOnly(node) ? 1 : 0` (`true` except `implement` and `source_search`), and
emits an `operation_pending` event.

Completion and advancement happen in `store.ts:completeOperation` (private; called under a
transaction by `decideRuntimeCandidate` on acceptance). It marks the operation `completed` with its
verdict and clears `retry_not_before`, marks its agent `completed`, computes
`store.ts:allCurrentComplete` (zero operations at the current node/round/fix that are not
`completed`), calls `decideTransition`, emits a `result` event, and then — unless
`settlingWhileParked` or the transition is `stay` — either sets the run terminal, or sets it
`blocked` and emits a `capsule` event, or sets the next node `active`, creates the next operations
and emits a `handoff` event. `settlingWhileParked` is used when a decision is recorded while the run
is already parked, so it does not re-advance.

`store.ts:cancelRunningOperations` is the operator's cancel-all: it marks every running operation of
the current node `cancelled`, marks their agents `cancelled`, emits `operation_cancelled` per
operation and one `run_cancelled`, and moves the run to `cancelled` in one transaction.

The only remaining `record` transition is cancellation: `store.ts:record` refuses any status other
than `cancelled` with `unsupported record status <status>: runtime attempts settle through collect
and advance through decide`.

### 3.4 Deadlines, deferral and parking

`store.ts:retryRuntimeAttempt` computes `retry_not_before` from `retry.ts:retryDelayMs` for a
transient retry and from `retryDelayMs(0, …)` for a chain fallback. `store.ts:resolveExhaustion`
applies one of `defer` (sets the run `deferred`, stores no operation status change, emits a
`deferral` event with `deferredUntil`), `abort` (operation and run `cancelled`), or `escalate`
(operation and run `blocked`). A deferred operation is resumed only through
`retryRuntimeAttempt({approved:true})`: `delegate_graph op=resolve decision=retry` calls it directly
(`index.ts:1033`) and `/graph resume` calls it and then sends a resume user message (`index.ts:1130`).
No reachable path installs the launchd job described in §1.7, so a deferred run has no unattended
resume: it is resumed by the operator, or it stays deferred until pruned.

---

## 4. Retry classification, the frozen model route and failover

### 4.1 Worker failure classification (`retry.ts`)

`retry.ts:classifyFailure(message, semanticVerdict = false)` returns `{kind: "transient" |
"permanent", reason}` and applies these checks in order:

1. `semanticVerdict === true` → permanent `semantic-verdict`.
1a. A message starting `[dispatch_precondition]` → permanent `dispatch-precondition`, before
   anything else can read the path it names as provider text.
2. Ownership failures matching `\[owned_path_escape\]|AgentFS (contains unowned changes|export
   failed[^\n]*: unowned changes)` → permanent `unclassified` (checked before anything that could
   look provider-shaped).
3. `APPROVAL_BLOCK_PATTERN` (permission denials/approval blocks) → permanent `approval-block`,
   before the transient scan, so a denied authorization never spends budget.
4. `TRANSIENT_PATTERNS`, in order, first match wins; each maps to a reason: HTTP `429/500/502/503/504`
   (`http-429`…`http-504`), `rate-limit`, `quota`, `overloaded`, `timeout` (also `ETIMEDOUT`/timed
   out), `connection-reset`, `connection-closed`, `worker-runtime-failure`
   (`ACPX worker failed|terminal=failed|QUEUE_RUNTIME_PROMPT_FAILED`), `provider-link-churn`
   (`provider credential target changed`), `worker-report-missing`, `worker-credential-preflight`
   (`worker preflight|no usable credential`), `worker-report-unavailable` (`REPORT_UNAVAILABLE`),
   `worker-exited-before-result`, `worker-gone` (`attempt directory removed before result`,
   `no longer registered before result`, `process gone before result`, or a message starting `worker orphaned:` — the same death
   noticed by Herdr's wait or by `collect` after a reboot), `worker-startup-failure` (`ACPX session ensure failed` or `Cannot call write after a stream was
   destroyed`: the ACP session could not be opened and no prompt ran; §4.2 parks a repeated identical
   one), `worker-empty-answer`
   (`exited without a candidate`),
   `runtime-snapshot-churn` (`runtime configuration snapshot changed`), `agentfs-audit-error`
   (`AgentFS audit error`), `agentfs-snapshot-error` (`AgentFS snapshot failed`), and `timeout` for
   `ACPX worker result present but worker process <n> did not exit within`. A genuine "unowned
   changes" verdict is deliberately absent from this list, so it stays permanent.
5. `NEVER_LAUNCHED_PATTERN` (`no worker was registered|command never started|worker never
   launched`) → permanent `worker-never-launched` (after the transport signals, so a genuine
   infrastructure failure still falls across the chain).
6. Otherwise permanent `unclassified`.

`retry.ts:selectModelFallback(chain, attempt, message, {exactLock, semanticVerdict})` validates a
non-empty chain and an in-range attempt, classifies, and returns
`{…classification, advance, attempt, model, fallbackReason}` where
`advance = !exactLock && transient && attempt + 1 < chain.length`; an out-of-range attempt throws.
`retry.ts:retryDelayMs(attempt, random)` returns full-jitter exponential backoff
`floor(random() * min(300000, 30000 * 2**attempt))`.

### 4.2 The store's retry application

`store.ts:retryRuntimeAttempt(input: RuntimeRetryInput)` runs in one transaction:

- It loads the run and operation, rejects an operation stale for the current graph state, and finds
  the active attempt row and `RuntimeAttempt`.
- **Approved operator retry** (`approved: true`): requires the run parked
  (`awaiting_user|deferred|blocked`) and the operation `failed|blocked` (a `blocked` run requires an
  explicitly `blocked` operation); refuses while the active attempt is still running; refuses when
  the candidate has an outstanding integration (`outstandingIntegrationFor`); supersedes the active
  attempt (sets `superseded_at`, emits `runtime_attempt_superseded`); advances
  `transient_attempts` by one without resetting it (so an attempt key is never minted twice) and
  does **not** restore the same-model budget; sets the operation `pending` with `agent_id` and
  timing fields cleared; recomputes run status to `awaiting_user` if any sibling at the phase is
  still `failed|blocked`, else `active`; emits a `resume` event; and returns the next counters.
- **Automatic retry** (no `approved`): requires the run `active`. With an active attempt it must be
  settled (`outcome` present), undecided, not `exited`-with-candidate, and not `cancelled`; the
  error text is read from the recorded outcome — `failed.error`, `interrupted.reason`, or the
  synthesized `runtime worker exited without a candidate (capture <status>)`. With no attempt, the
  operation must be `pending` and the caller must supply both the launch error and the exact
  `modelAttempt`/`transientAttempt` it was dispatched with, otherwise the retry is refused as stale.
  It classifies with `classifyFailure`. A `worker-startup-failure` whose operation's
  `classifier_reason` is also `worker-startup-failure` and whose `retry.ts:startupFailureSignature`
  equals that of `last_error` (retained-diagnostics lines dropped, absolute paths and ACPX session
  names masked) parks at once, because a failed `sessions ensure` precedes any model call: the operation
  `failed`, the agent `failed`, the run `awaiting_user`, a `startup_failure_repeated` event whose
  payload lists `evidenceDirectories`, and `last_error` ending `retained startup evidence: <dir>; <dir>`
  for the startup-failure directories of the current and previous attempt that exist
  (`store.ts:startupFailureEvidenceDirectory`, the naming rule `delegate_core.py` writes with). An
  approved retry clears `classifier_reason` and `last_error`, so the next startup failure retries
  again. Otherwise, if transient and `transient_attempts < 3`, it supersedes,
  increments the transient counter, records `classifier_reason`/`retry_reason`/`last_error` and
  `retry_not_before = now + retryDelayMs(transient_attempts)`, clears `started_at`/`finished_at`,
  and emits a `retry` event. Otherwise, if transient and the chain has a next model, it advances
  `model_attempt` by exactly one, resets `transient_attempts = 0`, sets `fallback_reason`, clears
  timings, and emits a `model_fallback` event. Otherwise it marks the operation `failed`, the agent
  `failed`, the run `awaiting_user`, and emits `retry_exhausted` (transient) or `operation_failed`
  (permanent).
- `store.ts:assertDispatchPolicy` re-validates at dispatch that `policyDigest`/`modelPolicy` match
  the frozen policy, that `modelAttempt` is the current value or exactly one greater and inside the
  chain, and that `selectedModel` equals `route.chain[attempt]`; a cross-model advance requires a
  `fallbackReason`, and a `model`-kind policy forbids any advance.

### 4.3 The frozen route

At `/delegate` and at `op=init`, `index.ts:resolvePolicy(input, exec)` shells out to
`scripts/policy-resolver.mjs` with `--input <json> --roles <GRAPH_ROLES>` (`GRAPH_ROLES` is the set
of roles over the three graph definitions), maps the resolver's `roles[]` to `PolicyRoute[]`, and
`store.ts:initRun` persists `stableStringify(policy)` plus its sha256 digest (`policyDigest`).
`store.ts:policy` re-derives and verifies that digest on every read, refusing a mismatch. The
resolver maps presets through `scripts/policy-resolver.mjs:PRESET_ALIASES`
(`cheap→tools`, `balanced→coding`, `strong→reasoning`, `local→local-fast`,
`long-context→long-context`), resolves each role's tier from `config.roles[role].tier` or
`config.default_tier`, and promotes the tier to the stronger of the selected tier and the role's
capability floor using `TIER_RANK`/`promoteTier` and `adaptive.capability_floors`. The resolved
`thinking` and `session` come from `scripts/resolve-model.mjs:resolveModel` (re-exported from
`lib/model-routing.mjs`). `index.ts`'s dispatch branch passes `--thinking <route.thinking>` and
`--session <route.session>` to the launcher, and `scripts/delegate_core.py:worker_pi_settings`
writes the thinking level into the worker's private `settings.json` as `defaultThinkingLevel`
(copying only `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `compaction` and `retry`
from the supervisor's settings, with `packages: []`).

### 4.4 Main-session failover (`model-failover.ts`, `lib/model-failover-native.mjs`)

`model-failover.ts:modelFailoverExtension` registers `/failover`. `/failover enable <tier>` loads
the tier route with `lib/model-failover-native.mjs:loadTierRoute` (which reads
`config.tiers[tier].models` and validates it with `parseFailoverRoute`), requires the current model
to be in the route, and arms `state.route`/`state.cursor`. On `message_end` with an assistant error
it calls `classifyFailoverError(message, {contextWindow, responseStatus, isContextOverflow,
isRetryableAssistantError})`, which returns one of `quota`, `ordinary`, `connection-closed`,
`terminal` or `none`. For `ordinary`, `quota` or `connection-closed` it calls
`findNextFailoverCandidate` (searches forward from the cursor, skips the current model and the whole
failed provider, requires a registered model via `modelRegistry.find` and configured auth via
`modelRegistry.hasConfiguredAuth`) and, on a candidate, captures Pi's global `settings.json` with
`captureSettings`, calls `pi.setModel(candidate.model)`, and always restores the captured bytes with
`restoreSettings` in `finally`. It appends `model-failover-ready-v1` and `model-failover-event-v1`
session entries with `pi.appendEntry`. A manual model selection sets `state.manualLock = true` and
appends a `model-failover-lock` entry; an exact lock (`PI_FAILOVER_LOCKED=1`) cannot be unlocked. A
successful fallback clears `state.excludedProviders`.

---

## 5. The worker lifecycle

### 5.1 `init` — the private run directory

`scripts/delegate_core.py:command_init` requires ACPX and AgentFS (`require_worker_runtime`, exact
versions below), or Herdr identity for the Herdr transport (`require_herdr`, which also verifies
`herdr integration status` and installs the Pi integration if needed). It creates
`Path(tempfile.mkdtemp(prefix="delegate-graph-herdr-<run_dir_slug(label)>.", dir=run_root()))`, where
`run_dir_slug` is the label's slug with each UUID cut to its first 8 characters, at most 40 long
(`run-d34d01f4-op-ed00d5ce` for the extension's `<runId>-<operationId>` label), chmods it 700, writes
`state.json` (`caller_tab`, `transport`, `closed_tabs`, `resources`, `run_label`, `run_slug`) mode
600 and a private `system-prompt.txt`, and prints the run directory. `run_root()` is `<graph
home>/runs/` (created mode 700), where the graph home is the directory of `graph_db_path()`:
`DELEGATE_GRAPH_DB`, else `~/.local/share/delegate-graph/delegate-graph.db`, the same default as
`store.ts:DEFAULT_DB_PATH` (pinned by `test/durable-run-root.test.ts`). `require_run_dir` accepts a
directory only when its resolved parent is the run root or `LEGACY_RUN_ROOT` (`/tmp`, kept for one
release so a run started by the previous version can still be collected), its name starts with
`delegate-graph-herdr-`, and it contains `state.json`.

The run root moved out of `/tmp` on 2026-10-04 (`tasks/handoff-durable-worker-record.md` §3): a host
reboot on 2026-10-03 cleared the only copy of an unsettled attempt's stream, answer sink, AgentFS delta
and `state.json`, making `run_ab8675e8`'s `thinker_plan` answer unrecoverable. The cancel-script-to-run-
directory relationship used by `prune` and by the liveness reaper is unaffected by the move.

The move lengthened every worker's working directory, the AgentFS mount
`<run dir>/acpx/<agent>/agentfs-home/.agentfs/run/<session>/mnt`, past what `pi` can open: `pi` 0.87.1
names a session directory `--<cwd with "/" replaced by "-">--`, which must fit 255 bytes, so a working
directory of 253 characters or more exits on `ENAMETOOLONG` before ACPX opens a session
(`tasks/handoff-worker-session-ensure-diagnostics.md` §4 item 4). The full-UUID label gave 257
characters under `~/.local/share/delegate-graph`; the shortened name gives 201. The full label is still
stored in `state.json`, where the run-id fallback and the Herdr tab title read it. For a `pi` worker,
`prepare_acpx_attempt` checks the computed working directory (`worker_cwd_precondition`) before it
materializes any credential, and raises a `[dispatch_precondition]` naming the length, the limit and
the remedy (a shorter `DELEGATE_GRAPH_DB` location). `index.ts` takes a `start` failure carrying that
marker through `retryRuntimeAttempt` like a credential-preflight block (permanent
`dispatch-precondition`, run `awaiting_user`, run directory discarded, `blocked: "precondition"`).
Codex and Claude workers are not checked; their limits were not measured. The AgentFS grant stays `--no-default-allows --allow <run-dir>`; with the root
under `$HOME` a worker cannot write the database, `runtime-content/`, `evidence/`, `failures/` or a
sibling run directory, and the grant still delivers `worker-result.json` to the host when the run
directory lies inside a home run's copy-on-write base (both verified with real AgentFS).

### 5.1a Home runs (`workspace_root`)

A run initialized with `workspaceRoot` (`delegate_graph op=init`; `store.ts:initRun` option
`workspaceRoot`) is a home run. `store.ts:homeWorkspaceRoot` requires the `build` or `research` graph,
expands `~`, and records the realpath only when it is an existing directory equal to or under the
realpath of `$HOME` (`os.homedir()`). For every operation of a home run the dispatch branch of
`index.ts` uses `workspace_root` as the working directory regardless of `ctx.cwd`, skips the
owned-path and Git preconditions, launches with `--workspace-mode home`, and passes
`--owned-paths-json ["."]` to owned-write operations. Slices still declare disjoint `ownedPaths` as a
statement of intent; they do not limit what the slice may write. `scripts/delegate_core.py` records
`workspace_mode` on the resource, appends `HOME_WORKSPACE_INSTRUCTION` to the prompt (address files
relative to the working directory because `~` and `$HOME` are private; changes are placed after review
and undoable; do not commit inside repositories), and `require_settlement_base` waives the Git base
revision. `commands.ts:renderStatus` ends the run line with `| workspace=home:<root>`. Verified
2026-10-03 for a workspace under `$HOME`: an absolute write into the workspace's host path, with or
without a `cd` into it, is refused inside the sandbox rather than reaching the host.

### 5.2 `start` — materialize and launch one attempt

`scripts/delegate_core.py:command_start` validates the run directory and task file (mode must be
600), resolves the frozen route (`frozen_route`), derives the node (`args.node` or `ROLE_NODES[role]`),
generates an agent name matching `[a-z][a-z0-9_-]{0,31}` (`dg_<run8>_<role9>_<hex4>`), and calls
`prepare_acpx_attempt`. `prepare_acpx_attempt` performs:

1. Computes the ACPX plan by running `scripts/acpx-plan.ts` (the CLI over
   `resolveAcpxPlan`/`createAcpxAttemptIdentity`), yielding `agent`, `sessionName`, `attemptKey`.
   `lib/acpx-types.ts:createAcpxAttemptIdentity` builds the attempt key from
   `runId:operationId:role:modelAttempt:transientAttempt:selectedModel:agent` and derives the session
   name `dg-<slug(role)>-<modelAttempt>-<transientAttempt>-<sha256(runId:operationId:modelAttempt:transientAttempt)[:12]>`
   (`acpxAttemptKey`, `createAcpxAttemptIdentity`).
2. Creates `<run>/acpx/<agent>/` (700) with `acpx-home/`, `agentfs-home/`, `providers/`.
3. Builds the provider environment (`provider_runtime_environment`): preflight, then materialization
   (§5.3).
4. Builds the prompt: the task text, the operational instruction when `--command-json` is present
   (`operational_instruction`, which resolves the command's `cwd` against the worker's working
   directory and refuses a mismatch), the runtime-answer contract text, the `VERDICT:` line
   requirement for `RUNTIME_VERDICT_NODES` (`review`, `test`, `audit`, `source_search`), a
   no-terminal note when `--no-terminal`, the read-only note when read-only, and the host-services
   paragraph when `--host-services-json` attaches any (§5.3).
5. Writes `worker-config.json` (schema 1; `resultContract: runtime-v1`; `attemptKey`;
   `hostReadOnly`/`discardAllChanges` equal to `read_only`; `noTerminal`), mode 600.
6. Writes `launch-acpx.sh` (700): `exec <agentfs> run --session <sessionName> --no-default-allows
   --allow <run-dir> <node> --experimental-strip-types <acpx-worker.ts>`, the same with or without host
   services. With host services it also writes `launch-with-host-services.sh` (700): `exec <python>
   host_service_launcher.py --spec <attempt>/host-services.json --state-root <attempt>/host-services --
   <attempt>/launch-acpx.sh`, recorded as `service_launcher`. Only the first launch uses it
   (`first_launcher`, both transports); `run_acpx_again`, which closes the session after settlement,
   runs `launch-acpx.sh` and so starts no service a second time.
7. Writes `cancel-config.json` and `cancel-acpx.sh` (700), the latter setting
   `PI_ACPX_CANCEL_CONFIG` and execing `scripts/acpx-cancel.ts`.
8. Resolves `owned_paths` and `ignored_paths` (relative to `cwd`), the Git `base_revision`
   (`git rev-parse HEAD`), and the operational `checkpoint_path`; assembles the resource record
   (`execution: acpx-agentfs`, `base_dir`, owned/ignored paths, `read_only`, ACPX/AgentFS identity,
   `acpx_cancel_script`, `provider_links`, `worker_environment`) and returns it with the worker
   environment.

`command_start` then adds the presentation/stream fields to the resource and appends it to
`state.resources` under the state lock. For a Herdr attempt it creates the tab
(`tab_create_argv`, passing the frozen `delegation_environment` via `--env`), reads the tab and root
pane ids, re-derives the ACPX identity with the real tab/pane and refuses a changed session or agent,
reports the agent to the pane (`herdr pane report-agent`), and runs the launcher in the pane
(`herdr pane run`). For a headless attempt it calls `launch_headless_worker`, stores the returned
pid, and emits the JSON launch line naming agent, transport, policy/digest/tier/model, ACPX session,
attempt key, cancel script, AgentFS session and db, attempt identity, and any pane/tab. The
extension (`index.ts` dispatch branch) parses this, registers the agent
(`store.ts:registerAgent`), re-derives the identity with `resolveAcpxPlan` and refuses a mismatch,
registers the attempt (`store.ts:beginRuntimeAttempt`), emits `runtime_attempt_registered`, and
opens the agent list (`agent-list.ts:noteRegisteredAttempt`).

### 5.3 The AgentFS copy-on-write sandbox

Every attempt runs under `agentfs run --session <sessionName> --no-default-allows --allow <run-dir>`
with `HOME` set to the attempt's `agentfs-home` and a `PATH` that prepends the node, acpx and
agentfs directories (`scripts/delegate_core.py:prepare_acpx_attempt`). `scripts/acpx-worker.ts:workerEnvironment`
adds `HOME` = `acpxHome` and `GIT_OPTIONAL_LOCKS=0`. The overlay delta is
`<agentfs-home>/.agentfs/run/<session>/delta.db`. The graph passes the persisted access mode to the
launcher (`--access-mode read-only|owned-write`); read-only sets `discardAllChanges = true` and
`hostReadOnly = true`, and `scripts/acpx-worker.ts:parseWorkerConfig` refuses a config where the two
disagree. Read-only is enforced structurally: settlement only snapshots and stages coding and
operational (owned-write) attempts (§5.5), and `settle_runtime_attempt` refuses a read-only
coding/operational attempt.

What the sandbox does not confine (verified 2026-10-03 against `agentfs v0.6.4` on macOS, launched
as above; `tasks/handoff-durable-worker-record.md` §7 question 5). Only writes relative to the working
directory go to the overlay and are audited. Writes to `/tmp`, `/private/tmp` and the per-user temp
directory `/var/folders/<user>/T/` succeed and land on the host without appearing in the delta,
whatever `TMPDIR` is set to; the run directory is host-writable by design (`--allow`). Absolute
writes elsewhere under `$HOME` are refused. Every host file is readable, including the graph database
and `~/.pi/agent/auth.json`. `agentfs run` 0.6.4 has no option that denies `/tmp` or reads. Run directories made by a version before 2026-10-04 still live under `/tmp`, where any worker can
write into them; current run directories are under the graph home (§5.1).

What the sandbox denies that a worker may need (verified 2026-10-04, macOS 26.7.1, `agentfs v0.6.4`;
`tasks/handoff-worker-browser-sandbox.md`): `IORegisterForSystemPower` returns 0 inside `agentfs run`,
with or without `--no-default-allows`, and every Chromium-family browser then segfaults at startup in
`IONotificationPortGetRunLoopSource`. No `agentfs run` option grants it; a worker that needs a browser
gets one as a host service (below). A plain background process started by a worker's bash tool call
survives into the next call; Pi's bash tool kills a call's process tree only on abort or timeout.

**Host services** (`tasks/handoff-host-services.md`). A tool a worker needs but cannot run inside the
sandbox runs on the host beside it. The operator registers it in `host-services.jsonc` (agent directory, or
`PI_HOST_SERVICES`), parsed and validated only by `lib/host-services.mjs` (`loadHostServices`,
`attachHostServices`); `op=dispatch` takes `hostServices: string[]`, refuses an unknown, repeated or
unavailable name before `init` as a parameter error, and passes the entries resolved for `process.platform`
to `start --host-services-json`. `prepare_acpx_attempt` then writes `<attempt>/host-services.json` and
`launch-with-host-services.sh`, which runs `scripts/host_service_launcher.py` around the unchanged
`launch-acpx.sh` for the first launch only (§5.2 step 6), records `host_services`, `host_services_root` and
`service_launcher` on the resource, and appends `host_services_instruction`, which names each service, its description and its
variables but no path or port. The wrapper runs on the host for both transports: for each service it
expands `{port}` (a free loopback port) and `{stateDir}` (`<attempt>/host-services/<name>/`), starts it in
its own process group with its log beside the directory, records `{name, pid, started, executable}` in
`running.json` (`started` is `ps -o lstart=`), and waits until the port accepts a connection; a service
that exits or times out stops every started service and exits 70 before the worker starts. The worker runs
as a child with the expanded `env`; SIGTERM, SIGINT and SIGHUP are forwarded to it, and when it exits each
group gets SIGTERM, then SIGKILL after 5 s. `delegate_core.stop_host_services` is the backstop for a wrapper
killed outright: from `abort_acpx_attempt` and before a settled attempt's directory is removed, it stops each
recorded group whose start time still matches, so a reused pid is never signalled, and reports one still
running. A leaked service whose arguments name its `{stateDir}` also fails the absence audit's
`ownedProcessesAbsent`, which matches any process naming the attempt directory. The wrapper's process
handling is POSIX; a `win32` registry entry is accepted, but running it needs a Windows process path there.

### 5.4 Audit and staging

At settlement, `scripts/delegate_core.py:snapshot_agentfs_db` creates one consistent SQLite backup of
the closed delta into `<attempt>/agentfs-snapshot/delta.db` (journal mode `DELETE`) with a 30 s
deadline, using `sqlite3.Connection.backup(pages=256, progress=…)`. `scripts/runtime-settle.ts:settleRuntimeWorker`
then calls `lib/runtime-staging.ts:stageRuntimeAgentFs`, which:

- hashes the snapshot before and after staging (`snapshotDigest`) and refuses a self-contained check
  failure (`lstat`/symlink/`-wal` present) or a race;
- copies the snapshot to scratch and audits it with
  `lib/agentfs-sandbox.ts:auditAgentFsChanges`;
- filters container directories out of `changes`, reads each owned file's bytes with
  `agentfs fs <snapshot> cat /<path>`, retains them with `RuntimeContentStore.retain`, and retains a
  canonical `RuntimeStagingManifest` (`{version:1, attemptKey, workspace, baseRevision,
  snapshotDigest, ownedPaths, changes[{path, after, mode}], readOnly}`).

`lib/agentfs-sandbox.ts:agentFsChangeInventory` reads the AgentFS schema directly with a recursive
CTE over `fs_inode`/`fs_dentry`, left-joins `fs_origin`, reads `fs_whiteout` as deletions, and
compares each candidate to its host preimage (overlay bytes via `agentfs fs <db> cat /<path>` against
`readFileSync(hostPath)`, plus the mode); a failed comparison is recorded
as an `audit_error` rather than promoted to a change. `auditAgentFsChanges` normalizes owned and
ignored paths with the symlink-aware `realpathExistingPrefix`, rejects whole-base ownership unless
`ownWholeBase`, classifies each change as owned, ignored (platform metadata `._*`/`.DS_Store`,
checked first so it is ignored inside ownership too, or explicit `ignoredPaths`), a container of an
owned path, or a violation, and returns the errors. Platform metadata is never work in any mode: the
macOS overlay writes `._*` beside the files a worker creates (`tasks/handoff-repository-sidecars.md`).
`stageRuntimeAgentFs` fails on any audit error for a non-read-only attempt and on any violation
(`AgentFS contains unowned changes: …`).

The default ignored paths are `[".git/index"]`, defined once as
`lib/agentfs-sandbox.ts:DEFAULT_IGNORED_PATHS` and mirrored by
`scripts/delegate_core.py:DEFAULT_IGNORED_PATHS`; the two must stay identical (comments on both).
Ignoring never grants ownership: ignored paths are never staged or exported, and integration refuses
Git-internal paths.

### 5.5 Settlement and evidence retention

`scripts/runtime-settle.ts:settleRuntimeWorker(config)`:

1. Opens `RuntimeContentStore(config.dbPath ?? DELEGATE_GRAPH_DB ?? DEFAULT_DB_PATH)` **before**
   touching the worker result, so an unreachable store fails by name.
2. Reads the worker result (`schemaVersion 2`, `resultContract runtime-v1`), verifies `attemptKey`,
   parses the process outcome with `parseRuntimeOutcome`, and retains `public-answer.txt` when
   non-empty.
3. For coding/operational, stages the AgentFS snapshot (§5.4). For operational, calls
   `observeCheckpoint`, which requires the checkpoint to be a staged owned change; only its
   non-negative safe-integer `jobsSaved` and non-empty `status` are recorded; a checkpoint that
   exists on the host with no overlay change raises
   `operational checkpoint <path> exists on the host but was not written through the sandbox overlay`.
4. Builds the candidate: `coding` when a manifest exists and there is an answer or at least one
   change; `operational` when a manifest exists and there is an answer; `research` when there is an
   answer. A deletion counts as a change. The staging manifest alone is never evidence of work.
5. Builds the observation from the capture summary (`sessionId`, `requestId`, `sessionOrigin`,
   `captureStatus`, and the manifest reference only when the candidate retains it).
6. Publishes the evidence atomically with `publishEvidence`: delete stale temp files, write and
   `fsync` a private temp file (`openSync(..., "wx", 0o600)`), `linkSync` it exclusively into place
   (refusing an existing record for another attempt), remove the temp, chmod 600, and fsync the
   directory.

For a home run the configuration carries `ownWholeBase: true` (coding only;
`delegate_core.py:runtime_settle_config`), and `runtime-settle.ts` passes it to
`lib/runtime-staging.ts:stageRuntimeAgentFs` with the graph home as an excluded root. Staging then owns
every changed path except paths with a `.git` segment and paths under the graph home (platform sidecars
never reach staging: the audit ignores them in every mode), and records the staged paths
themselves as the manifest's `ownedPaths`, because the whole base has no relative spelling.

`scripts/delegate_core.py:settle_runtime_attempt` wraps this: it waits for the worker
(`wait_for_settled_agent`), writes the `runtime-settle.json` config and invokes the script with
`PI_RUNTIME_SETTLE_CONFIG`, retains a bounded capture tail when capture was incomplete or produced no
candidate (`retain_incomplete_capture`), writes a failure bundle when there is no candidate
(`write_failure_diagnostics`), then closes/verifies/cleans up (§5.7) and returns the paths plus any
`postSettlementFailures`. A failure after content retention is reported, never used to discard the
candidate.

**Recorded 2026-10-03, not yet implemented** (`tasks/handoff-durable-worker-record.md` §4):
settlement gains a recovery branch for an attempt whose worker is not alive and whose
`worker-result.json` is absent or unparseable — the file `acpx-worker.ts` writes only at the end of
a prompt run, so a worker killed mid-turn writes none. The branch replays the retained
`runtime-output/worker.stdout.ndjson` through `lib/runtime-capture.ts:RuntimePublicCapture` and
settles from the replayed summary: the outcome stays the real process failure, a non-empty replayed
answer is retained as a candidate with `captureStatus: "incomplete"` and an explicit recovered
marker, and an empty replay stays the transient `worker-empty-answer` failure. A `VERDICT:` line is
honored only when the worker itself wrote it; recovery never fabricates one, so a positive semantic
verdict still never originates from the runtime. Recovery is reachable only through `op=collect`,
adds no verb, and needs no schema change. It depends on §5.1's durable run root: without it there is
nothing left to replay.

### 5.6 Process outcome capture

`lib/runtime-output.ts:RuntimeOutputFiles` writes exclusive per-attempt files into the output
directory (`<result-dir>/runtime-output/`): `worker.stdout.ndjson` (capped at 16 MiB),
`worker.stderr.txt` (capped at 1 MiB with `stderrTruncated`), `public-answer.txt`,
`public-provenance.ndjson`, and `runtime-output.json` (written to `runtime-output.pending`, fsynced,
then `renameSync`d). `lib/runtime-capture.ts:RuntimePublicCapture` maintains capture limits
(`maxEventBytes` 1 MiB, `maxTotalBytes` 16 MiB), records diagnostics, and reports
`captureStatus: complete|incomplete|empty`; a public `agent_message_chunk` inside the bound prompt
is written to the answer and provenance sinks. `lib/runtime-process.ts:runRuntimeProcess` spawns the
ACPX prompt with `shell:false`, consumes stdout/stderr through `RuntimeOutputFiles`, calls the
optional renderer observer (whose failure never affects capture), and derives the `RuntimeOutcome`
from cancellation (`AbortSignal`), timeout, spawn failure, signal, or exit code. The
`acpx-worker.ts` prompt branch writes the schema-2 worker result under a private temp name, fsyncs,
and renames it into place, so the waiter never sees a half-written file.

### 5.7 Session close, provider verification, cleanup and the absence audit

On a successful settlement `settle_runtime_attempt` first calls
`observe_presentation_identity`, which checks that the recorded attempt identity matches the run,
operation, role, model, ACPX agent, session names and AgentFS session, and, for Herdr, that
`herdr pane get` reports the same pane and tab. It then calls `close_acpx_attempt`: a `close` ACPX
run that must report `closed` and `noSession`, followed by `verify_provider_links` (and, for Herdr,
`herdr pane release-agent`). `verify_provider_links` checks every materialized credential/snapshot
for file type, mode and (for exact snapshots) byte hash or key set; Claude's two configuration
files (`~/.claude.json` and `.claude/settings.json`) are under the self-write rule: they must remain
a mode-600 JSON object, and any change is recorded in `configuration_self_writes`, never refused.
Codex's `config.toml` is a `selfWrites: codex-trust` snapshot (`copy_runtime_file(..., codex_trust_root=<attempt>)`,
which also writes `<attempt>/config.toml.pristine`): when its bytes changed, `codex_trust_additions` parses both
with `tomllib` and accepts only added `projects` entries naming directories inside the attempt, the trust entry
Codex writes for each new working directory; everything outside `projects` must be equal and every existing
entry unchanged. Accepted entries are recorded in `configuration_self_writes` as `addedKeys`.
Every other snapshot keeps exact bytes. A failure in this close/verify block is appended to
`postSettlementFailures`; the candidate is not discarded.

Then, if there were post-settlement failures, the attempt is torn down through `abort_acpx_attempt`;
otherwise the attempt directory and ACPX home are removed. The settled Herdr tab is then closed by
`close_settled_tab` **before** the audit (a close failure is appended and the audit still runs).
`release_agentfs_session` force-unmounts any leftover AgentFS NFS mount (located from `mount`
output under the attempt's private home, via `umount -f`). Finally `verify_cleanup_absence` builds
`cleanup_absence_inventory` over: tab absent from `herdr tab list --workspace
$HERDR_WORKSPACE_ID`, pane absent from `herdr pane get`, agent absent from `herdr agent get`, no
queue owner, no ACPX session files, no AgentFS mount/server/database/home, no provider links, no
report/repair children, no attempt directory, and no owned processes. `owned_process` identifies the
launcher by session name or attempt directory and ignores the Python entry-point processes
`herdr_delegate.py`, `headless_delegate.py` and `headless_supervisor.py`. `sessionClosed` is true
only from an observed cancel (`cancel-proved`), a verified close (`close-proved`), or both files and
processes absent (`files-and-processes-absent`); `sessionClosureEvidence` names which. Any required
absence that is not true raises `cleanup absence audit failed: …`. The evidence is written
`cleanup-<agent>.json` mode 600. A terminated attempt always settles: `op=collect` records the
failure and names the retained diagnostic. A launcher-side teardown with a
`failure-<operationId>.json` and no attempt directory is recognized by `index.ts:retainedTeardown`
and settled `failed` without waiting.

An operation whose authorized command never started has no session and no attempt: `op=cancel`
routes it through `index.ts:settleUnlaunchedOperation`, which writes
`failures/<runId>/unlaunched-<operationId>.json` (`store.ts:retainRunDiagnostic`) and records the
operation `cancelled`.

### 5.8 Cancellation

`scripts/acpx-cancel.ts:cancelAttempt` runs `acpx <agent> cancel --session <name>` and requires a
`cancel_result.cancelled` acknowledgement; it then polls up to 120 s for a `status_snapshot` status
of `idle` or `no-session`, runs `acpx <agent> sessions close <name>`, and finally requires a
`no-session` status. Its result reports `cancelled`, `structuredCancelled`, `closed` and
`noSession`. `herdr.ts:cancelRegisteredAttempt` runs the agent's `acpx_cancel_script` (a no-op when
the launcher is absent, so a repeat cancel converges), parses the `cancel_attempt` line, and requires
the returned `sessionName`/`recordId`/`attemptKey` to match the stored agent and all four booleans to
be true. The run-scoped cancel-all is `index.ts:cancelRunWorkers`: for each running operation it
calls `cancelRegisteredAgent` (tolerating an already-`no-session` agent), settles an unsettled
attempt `cancelled` (`store.ts:settleRuntimeAttempt`), and then calls
`store.ts:cancelRunningOperations`. A worker whose stop cannot be confirmed is reported by name in
`CancelRunReport.failed`, and the run is still recorded cancelled.

### 5.9 Integration journal

`lib/runtime-integration.ts:RuntimeIntegration` stores an immutable manifest whose id is
`runtimeDigest(manifest)` (sha256 of the canonical manifest) and journals state
`prepared|applying|applied|rolled_back|needs_reconciliation` with the partial unique index and
manifest-immutability trigger described in §1.4. `prepare` takes a `validate` callback (supplied by
`store.ts`) and:

- rejects an empty change set, and returns the existing integration when the same candidate is
  prepared again with identical inputs;
- for `gitChecks` (coding), requires the workspace to be its own Git root, `HEAD` to equal the
  recorded base revision, every preimage to be clean and tracked, and no active integration on the
  workspace; for operational placement (`gitChecks:false`) it skips the Git checks;
- refuses non-relative, backslash/`\0`/`.git` paths, unowned paths (outside `ownedPaths`),
  overlapping entries, symlinks, hard links, nested repositories, files over 16 MiB, and a staging
  root on a different filesystem; a refused parent is named with its entry
  (`integration parent <dir> of <entry> is missing or not a real directory`, or `… is a submodule or
  nested repository`);
- treats a file under a missing parent as absent in both modes and records the entry parents absent at
  `prepare` in the manifest as `newDirectories`, deepest first (omitted when empty, so earlier manifests
  keep their digest). A directory the integration creates is new and empty, so it holds no nested
  repository and nothing in Git's index; the refusals protect existing paths only;
- reports a dirty preimage that an earlier `applied` integration in the same workspace wrote
  (`appliedHere`) as uncommitted output of that integration, naming the duty to commit the previous
  round's integrated files, rather than as a bare dirty-or-untracked refusal: the graph's rounds hand
  their output to each other through the working tree, so the duty is the graph's to state;
- retains each preimage with `RuntimeContentStore.retain`, records the caller's `overrideReason`
  (nullable `override_reason`, added additively on open and outside the manifest so it never changes
  the digest two identical candidates share), and writes the manifest.

`advance` commits the recovery direction in one transaction before any filesystem mutation, then, in
one transaction per step, verifies the base revision and every content reference, snapshots each
path and requires it to equal either the preimage or the new image (otherwise
`needs_reconciliation`), finds the first not-yet-applied (or not-yet-reverted) entry, replaces it
via a private staging file and `renameSync`, creating missing parents with `mkdirSync` first, and
records `applying`. When every entry matches the target it records `applied` or `rolled_back`; before
`rolled_back` it removes each `newDirectories` entry that is still empty, deepest first, keeps one that
holds anything, and stops in `needs_reconciliation` if the path to one now crosses a symlink or a
non-directory. A directory that existed at `prepare` is never removed. Supervisors must not issue a
workspace mutation and the `integrate` that depends on it in one parallel tool batch: the integration
may run first (`tasks/handoff-integration-new-directories.md` §3). `finish` loops `advance` until the state is no longer
`applying`, so a lost acknowledgement converges. `store.ts:prepareIntegration`/`applyRuntimeIntegration`
validate that the candidate settled, that it retains the manifest and every staged file, that the
manifest matches the candidate's identity and base revision, that `realpath(workspace)` is
unchanged, and that the operation is still current.

**Placement without Git checks.** `gitChecks` is false for operational candidates and for coding
candidates of a home run (`store.ts:prepareIntegration`). Such a placement creates missing parents and
removes them on rollback exactly as above, and it does not refuse a path under a nested repository;
with Git checks that refusal stands (`RuntimeIntegration.target`).

**Undo of an applied placement.** `rollback` reverses only a `prepared` or `applying` integration.
`RuntimeIntegration.undo` also reverses an `applied` one, only without Git checks and only while no
other integration of the workspace is active, through the same per-file step: a file that is neither
the placed image nor the preimage stops it in `needs_reconciliation` and nothing is overwritten.
`store.ts:applyRuntimeIntegration(…, "rollback")`, which `op=integrate decision=rejected` calls, first
tries `undoRuntimeIntegration`: when the candidate has an applied placement it is undone whatever the
graph or run has done since, no graph state changes, and an `integration_undone` event is recorded;
otherwise the ordinary rollback applies.

**The live-sibling guard.** Creating an integration writes into the workspace that a still-running
sibling worker's settlement audit reads, which fails that worker permanently with `AgentFS contains
unowned changes` (2026-09-21 incident, `tasks/handoff-settlement-and-integration-races.md`).
`store.ts:prepareIntegration` therefore refuses while `liveSiblingOperations` reports any other
operation of the same run, node, round and fix iteration that is `running` and whose attempt has
neither an outcome nor a supersession, naming those operations. The window is exactly "dispatched and
not yet settled": a settled sibling has already run its audit, even though its operation stays
`running` until `op=decide`, and an undispatched one builds its overlay from the integrated tree. The
guard covers creation only, so re-reading an existing integration stays idempotent, and a rollback is
never refused by it because rollback is the recovery route out of the state. An operator who knows a
sibling is dead passes an override reason, which must be non-blank and is recorded on the row.

---

## 6. The live-view pipeline

### 6.1 Sources

- **With a terminal (Herdr):** the pane is the source. `lib/pane-read.ts:paneLines` calls
  `herdr pane read <pane> --source recent --lines <n> --format text` synchronously on the UI thread
  with a 1000 ms timeout and `SIGKILL`, drops blank lines and truncates long lines to 160
  characters. The launcher execs the worker with no redirection, so the pane carries the worker's own
  rendered output; a display path never opens the capture stream file.
- **Without a terminal (headless):** the supervisor's loopback publisher is the source
  (`lib/live-stream.ts`). No view reads the capture file.
- **Whether the turn has ended:** the worker's own result file is the source (`lib/turn-end.ts`).
  Between the end of a worker's turn and `op=collect` the store still reads `running`, because the
  process outcome is recorded at settlement; `scripts/acpx-worker.ts` renames `worker-result.json`
  into the attempt directory when its prompt run is over, on both transports, so its presence is
  exactly "the turn ended and nobody has collected it". `turnEndFor` stats that path beside the
  registered `acpx_cancel_script`, refusing anything that is not a regular file so a FIFO or a hung
  worker cannot block the UI thread, and takes the exit code from the nearest
  `*.status.json` above it when the transport publishes one (`headless_supervisor.py`; Herdr
  publishes none, so the label omits the code). `processLabel` renders this as
  `process exited[ <code>], awaiting collect` for an unsettled attempt only: a settled attempt is
  always described by what settlement recorded. Nothing here writes to the store, and acceptance
  still belongs to `op=decide`.

### 6.2 Renderers

`lib/acpx-render.ts:renderAcpxLine` turns one JSON-RPC line into display text: assistant text
streamed inline, thoughts dimmed when `options.thoughts !== false`, `▸`/`✓`/`✗` for tool calls and
tool-call updates, `plan: done/total`, separator rules for `session/prompt` and `session/cancel`,
`? permission: …` for `session/request_permission`, and short rules for a result `stopReason` or an
error. Adapter bookkeeping (`available_commands_update`, `config_option_update`,
`session_info_update`, `usage_update`, `current_mode_update`, `_auth/status_update`, and
`user_message_chunk`) is suppressed; a non-JSON line passes through prefixed `| `.
`AcpxRenderer.push` buffers a partial trailing line in `state.carry` until its newline and `end`
flushes it. `lib/live-stream.ts:toLines` strips ANSI (`stripAnsi`), splits, drops blank lines,
truncates to `LINE_LIMIT = 160` and takes the last `limit` lines.

### 6.3 Consumers and caching

The views are:

- `index.ts:watchRun`/`renderWatch` and `index.ts:refreshWatchLiveViews`, used by `op=watch` and the
  `/graph watch` one-shot path. `op=watch` awaits `refreshWatchLiveViews` and emits a `watch`
  progress event so ACP clients see the same summary.
- `index.ts:startFollow`/`renderFollow`, the run-scoped persistent form of `/graph watch --follow`;
  its redraw timer runs at `watchIntervalMs()` and stops when the run leaves `active`.
- `agent-list.ts:listRows`/`attemptDetail` through `liveViewForAgent`, which uses `paneLines` for a
  Herdr agent and `liveViewFor` for a headless one.

`refreshWatchLiveViews` and `refreshAgentListLiveViews` skip agents with a `herdr_pane_id` (the pane
already shows the worker) and await `refreshLiveView(attempt.attemptKey,
streamRunDirectory(agent.acpx_cancel_script), …)` for the rest. `lib/live-stream.ts` caches a
`LiveView` per attempt key; `LIVE_VIEW_PENDING`, `LIVE_VIEW_QUIET` and `LIVE_VIEW_UNAVAILABLE` are
the distinct "nothing to show" notes, and a failed refresh leaves the last view in place.
`agent-list.ts:ensureTimer` and `index.ts:startFollow` each own a redraw timer that exists only while
the view is open and something listed is running, and each `unref`s it; the renderers stay
synchronous so a worker, socket or `herdr` process cannot block the terminal.

---

## 7. Configuration and environment variables

The following environment variables are read. The `read by` column names the entry point and
symbol; `PI_CODING_AGENT_DIR`, `PI_MODEL_ROUTING`, `PI_MODEL_CATALOG` and `PI_HOST_SERVICES` are the documented
configuration overrides and tests use temporary agent directories.

| Variable | Read by | Meaning | Source |
| --- | --- | --- | --- |
| `PI_CODING_AGENT_DIR` | extension, scripts, provider | Pi agent directory; default `~/.pi/agent` | `route-picker.ts:resolveAgentDir`, `lib/agent-paths.mjs:resolveAgentDir`, `lib/claude-auth-config.ts:claudeAgentDir`, `model-failover.ts:agentDirectory`, `scripts/policy-resolver.mjs:AGENT_DIR` |
| `PI_MODEL_ROUTING` | resolver, doctor, picker, failover | explicit `model-routing.jsonc` path | `route-picker.ts:resolveRoutingPath`, `lib/agent-paths.mjs:resolveRoutingPath`, `scripts/policy-resolver.mjs`, `model-failover.ts:routingPath` |
| `PI_MODEL_CATALOG` | resolver, doctor, picker | explicit `models.json` path | `route-picker.ts:resolveCatalogPath`, `lib/agent-paths.mjs:resolveCatalogPath`, `scripts/policy-resolver.mjs` |
| `PI_HOST_SERVICES` | extension, doctor | explicit `host-services.jsonc` path; default `<agent dir>/host-services.jsonc` | `lib/host-services.mjs:resolveHostServicesPath` |
| `DELEGATE_GRAPH_DB` | store, settlement | graph DB path; default `~/.local/share/delegate-graph/delegate-graph.db` | `store.ts:DEFAULT_DB_PATH` (and `GraphStore` constructor), `scripts/runtime-settle.ts:settleRuntimeWorker` |
| `PI_CLAUDE_OAUTH_TOKEN_FILE` | launcher, doctor, matrix | mode-600 raw Claude token | `scripts/delegate_core.py:preflight_agent_credentials`, `provider_runtime_environment` |
| `CODEX_HOME` | launcher, doctor | Codex credential/config home | `scripts/delegate_core.py:preflight_agent_credentials`, `provider_runtime_environment` |
| `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID` | extension, launcher | a complete identity selects Herdr under `auto` | `scripts/delegate.ts:completeHerdrIdentity`, `scripts/delegate_core.py:require_herdr`, `verify_cleanup_absence` |
| `PI_DELEGATE_WAIT_TIMEOUT_MS` | launcher | worker wait bound; default `3600000` | `scripts/delegate_core.py:WAIT_TIMEOUT_MS` |
| `PI_DELEGATE_HERDR_LIVENESS_INTERVAL_S` | launcher | Herdr liveness probe interval; default `5` | `scripts/delegate_core.py:HERDR_LIVENESS_INTERVAL_S` |
| `PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS` | launcher | wait for process exit after the result; default `30000` | `scripts/delegate_core.py:WORKER_EXIT_TIMEOUT_MS` |
| `PI_GRAPH_WATCH_INTERVAL_MS` | extension | redraw interval; default 2000, floor 50 | `index.ts:watchIntervalMs` |
| `PI_ACPX_CONFIG` | worker | private per-attempt worker config path | `scripts/acpx-worker.ts:main` |
| `PI_ACPX_CANCEL_CONFIG` | cancel script | private per-attempt cancel config path | `scripts/acpx-cancel.ts:main` |
| `PI_RUNTIME_SETTLE_CONFIG` | settlement | private per-attempt settle config path | `scripts/runtime-settle.ts:main` |
| `ANTHROPIC_CLI_VERSION`, `ANTHROPIC_USER_AGENT` | Claude provider | request-header overrides | `lib/claude-auth-config.ts:registerClaudeHeadersCommand`, `lib/claude-auth-headers.ts:buildClaudeRequestMetadata` |
| `CLAUDE_CODE_ENTRYPOINT` | Claude provider | billing/entrypoint metadata; default `sdk-cli` | `lib/claude-auth-headers.ts:buildClaudeRequestMetadata` |
| `PI_FAILOVER_LOCKED`, `PI_FAILOVER_ROUTE`, `PI_FAILOVER_TIER`, `PI_FAILOVER_ROLE`, `PI_DELEGATION_KIND` | model-failover | worker failover arming | `model-failover.ts` (`session_start`, `/failover`) |
| `PI_DELEGATION_LABEL`, `PI_DELEGATION_MODEL`, `PI_DELEGATION_POLICY`, `PI_DELEGATION_POLICY_DIGEST`, `PI_DELEGATION_ROLE`, `PI_FAILOVER_LOCKED` | worker's Pi session | frozen delegation identity written by the launcher | `scripts/delegate_core.py:delegation_environment`, consumed by `model-failover.ts` |

`DELEGATE_GRAPH_DB` also determines the private run root, `<graph home>/runs/` (§5.1;
`scripts/delegate_core.py:run_root`, `scripts/production-audit.ts:readCleanup`). No separate variable
exists: deriving the root from the database path gives the tests and measurement drivers, which
already set it to a temporary path, their isolation for free.

`PI_FAILOVER_ROUTE` etc. are set by `scripts/delegate_core.py:delegation_environment` when a Herdr tab
is created (`tab_create_argv` passes them as `--env KEY=VALUE`), and the same values are set in the
worker environment for the headless transport.

Pinned external runtimes: ACPX `0.13.2` (`require-acpx.ts:REQUIRED_ACPX_VERSION`), AgentFS `0.6.4`
(`require-agentfs.ts:REQUIRED_AGENTFS_VERSION`); `require-runtime.ts:requireRuntime` runs both and
stops package registration on a mismatch. `pi-acp` `0.0.31`, Pi `0.84.1`/`0.84.2`, and JetBrains
Air `262.834.44`/`262.579.44` are stated by the READMEs as the tested matrix.

Routing config format (`lib/routing-template.mjs:generateRoutingTemplate`): a `tiers` object with
one entry per tier (`label`, `models[]`, `thinking`, `session`), a `roles` object mapping each graph
role to `{tier, capability_floor}`, an `adaptive` object with `enabled_by_default` and
`capability_floors`, and a `default_tier`. The required tiers are
`lib/routing-template.mjs:REQUIRED_TIERS = ["tools","coding","test","review","reasoning","long-context"]`
with the optional `local-fast`; the roles are `DELEGATE_GRAPH_ROLES =
["thinker","implementer","reviewer","tester","auditor","searcher"]`
(`route-picker.ts:DELEGATE_GRAPH_ROLES`, mirrored by `lib/routing-template.mjs`).

---

## 8. Packaging layout and exactly what ships

`extensions/pi-agent-wave/package.json` declares:

- `"name": "@dpugliese/pi-agent-wave"`, `"version": "0.2.0"`, `"type": "module"`,
  `"license": "MIT"`.
- `"files": ["*.ts", "lib", "scripts/*.ts", "scripts/*.mjs", "scripts/*.py",
  "scripts/delegate-ledger", "README.md", "LICENSE"]`.
- `"pi".extensions`: `["index.ts","questionnaire.ts","cmux-session.ts","model-failover.ts",
  "claude-code-auth.ts"]` (the graph extension plus the questionnaire, cmux-session, model-failover
  and claude-code-auth entry points).
- `"bin"`: `pi-agent-wave-migrate → scripts/migrate.mjs`, `pi-agent-wave-init → scripts/init.mjs`,
  `pi-agent-wave-doctor → scripts/doctor.mjs`, `pi-agent-wave-install-ledger →
  scripts/install-ledger.mjs` (installs `<agent dir>/scripts/delegate-ledger`, a launcher that `exec`s
  the shipped `scripts/delegate-ledger`; dry-run default, backups through `lib/safe-write.mjs`, whose
  restore allowlist is `model-routing.jsonc`, `fzf.json` and `scripts/delegate-ledger`).
- `"dependencies"`: `@anthropic-ai/sdk@0.91.1` and `@cgaravitoq/claude-code-core@0.1.0`;
  `"peerDependencies"`: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`; `"devDependencies"` pin Pi `0.84.1` for typechecking.

Shipped: the root `*.ts` entry points and helpers (including `agent-list.ts`, `commands.ts`,
`contract.ts`, `delegation-identity.ts`, `graph-core.ts`, `herdr.ts`, `index.ts`, `model-failover.ts`,
`questionnaire.ts`, `cmux-session.ts`, `claude-code-auth.ts`, `require-acpx.ts`,
`require-agentfs.ts`, `require-runtime.ts`, `retry.ts`, `route-picker.ts`, `scheduler.ts`,
`claude-code-auth.ts`, `sqlite.ts`, `store.ts`, `types.ts`), the whole `lib/` directory (TypeScript
and `.mjs`/`.d.mts` helpers), `scripts/*.ts|mjs|py`, `README.md` and `LICENSE`.

Not shipped: `test/` at any depth, `node_modules/`, tarballs, generated evidence, databases, caches
and `agent-output/`. The package-artifact test pins this by checking the `npm pack`/`npm publish`
file list against required entries and by rejecting `test/`, `node_modules/`, `__pycache__`,
`*.pyc`, `herdr-agent-state` and any `agentfs*.db` (`test/package-artifact.test.ts`). Herdr
executables, Herdr-managed files, credentials, databases and generated evidence never enter the npm
artifact.

The Claude auth provider is an adaptation of `@cgaravitoq/pi-claude-code-auth` 2.2.2; its MIT license
is preserved at `lib/claude-auth-LICENSE` (`claude-code-auth.ts` header; package-artifact test
requires the file) and the package README documents it rather than copying the upstream README.

The supervisor provider must retain prompts and executable tool declarations on both the legacy
Pi context API and the Pi 0.87 transcript API. When transcript replay helpers are available,
resolve system prompt sections and tool additions/removals through those helpers before
constructing the Anthropic request and mapping returned tool names. Preserve legacy top-level
fields on older Pi releases. Verify this with the installed Pi loader in a temporary agent home,
a synthetic token, captured HTTP responses, and a real harmless Bash execution; no paid request
or live credentials are required. The focused regression reproduced missing Bash before the fix
and passed after it on Pi 0.87.1; all 12 provider checks and package type checking passed
on the working tree based on `67ea969e796d8f6d35b3439c73359db326b56c13`. Broader package
release checks were not run for this focused tool-access repair.

---

## 9. Test surfaces

Automated verification lives entirely under `extensions/pi-agent-wave/test/`. The completion gate
from the repository root is:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts
git diff --check
```

Package-focused Bun checks (single files, because several tests import `node:sqlite`, which Bun
cannot load in the whole-directory glob): `package-manifest.test.ts`,
`package-portability.test.ts`, `package-artifact.test.ts`, `package-docs.test.ts`,
`package-migration.test.ts`, `questionnaire.test.ts`, `cmux-session.test.ts`,
`model-failover.test.ts`. The Node-only installation rehearsal is
`package-install-rehearsal.test.ts`. Package checks run from `extensions/pi-agent-wave/`:
`npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`,
`npm publish --dry-run --json --ignore-scripts`.

The test tree (top-level `test/*.test.ts`) covers, by area:

- **Graph and store:** `graph-core.test.ts`, `store.test.ts`, `graph-home.test.ts`,
  `acpx-store-migration.test.ts`, `runtime-results.test.ts`, `runtime-operations.test.ts`,
  `runtime-settle.test.ts`, `runtime-staging.test.ts`, `runtime-capture.test.ts`,
  `runtime-output.test.ts`, `runtime-process.test.ts`, `runtime-candidate-integration.test.ts`,
  `runtime-integration.test.ts`, `story-ledger.test.ts`, `commands.test.ts`,
  `supervisor-contract.test.ts`, `runtime-contract-command.test.ts`.
- **Lifecycle and transport:** `acpx-headless-lifecycle.test.ts`, `runtime-lifecycle-python.test.ts`,
  `acpx-worker-launch.test.ts`, `acpx-cancellation.test.ts`, `acpx-cleanup.test.ts`,
  `runtime-tool-lifecycle.test.ts`, `runtime-dispatch-evidence.test.ts`,
  `run-directory-finalization.test.ts`, `unlaunched-settlement.test.ts`,
  `acpx-collect-convergence.test.ts`, `delegate-script-rehearsal.test.ts`,
  `worker-transport.test.ts`, `headless-pi-stdio.test.ts`.
- **Credential and configuration:** `credential-preflight.test.ts`,
  `provider-credential-snapshot.test.ts`, `provider-runtime-config.test.ts`, `codex-trust-selfwrite.test.ts`,
  `approval-block-routing.test.ts`, `owned-path-normalization.test.ts`, `agentfs-sandbox.test.ts`,
  `claude-code-auth.test.ts`, `acpx-permissions.test.ts`, `acpx-routing.test.ts`,
  `acpx-requirement.test.ts`, `agentfs-requirement.test.ts`, `herdr-requirement.test.ts`,
  `headless-requirement.test.ts`, `host-services.test.ts` (registry, dispatch refusal, launch
  preparation, doctor), `host-service-launcher.test.ts` (the wrapper around real `agentfs run`, the
  backstop, and a browser driven over CDP from inside the sandbox).
- **Failure and recovery:** `retry.test.ts`, `acpx-failover.test.ts`, `model-failover.test.ts`,
  `acpx-event-mapping.test.ts`, `acpx-events.test.ts`.
- **Views:** `live-view.test.ts`, `runtime-watch.test.ts` (TUI agent-list and follow view,
  `agent-list.ts`), `stream-endpoint.test.ts`, `acpx-render.test.ts`.
- **Herdr:** `herdr-transport.test.ts`, `herdr-worker-liveness.test.ts`,
  `acpx-herdr-presentation.test.ts`, `acpx-focus-cancellation.test.ts`,
  `herdr-state-concurrency.test.ts`.
- **Install and packaging:** `initial-config*.test.ts` (`initial-config.test.ts`,
  `initial-config-core.test.ts`, `initial-config-doctor.test.ts`, `initial-config-safety.test.ts`),
  `doctor.test.ts`, `acpx-doctor.test.ts`, `package-*.test.ts`, `production-audit.test.ts`,
  `production-review-gate.test.ts`.
- **Opt-in live:** `acpx-real-matrix.test.ts` (skips unless `RUN_REAL_ACPX_MATRIX=1` and a
  `PI_CLAUDE_OAUTH_TOKEN_FILE` are present), `acpx-production-matrix.test.ts`,
  `acpx-headless-real-matrix.test.ts`, `credential-preflight-live.test.ts`,
  `failure-bundle-live.test.ts`, `runtime-probe-gate.test.ts`, and the `npm run test:acpx` gate
  driven by `test/support/acpx-matrix-gate.mjs` (which refuses rather than reporting skips as
  passes).

`test/support/` holds the fake ACPX and shims (`acpx-fixture.mjs`, `fake-acpx.mjs`,
`acpx-shim/`, `herdr-shim/`), lifecycle and cleanup drivers (`acpx-lifecycle-driver.mjs`,
`acpx-cleanup-driver.py`), the live probe (`runtime-result-probe.py`, `runtime-result-probe.ts`),
the measurement driver (`runtime-measure.ts`), the Herdr settle-mutation proof
(`herdr-settle-mutation-proof.sh`), the partial-line driver (`partial-line-driver.py`), the
stream-endpoint and backpressure drivers (`stream-endpoint-driver.py`,
`stream-backpressure-driver.py`), the live-view driver (`live-view-driver.py`), and the test-only
AgentFS export harness (`agentfs-export.ts`, never shipped). Because `test/` is not in the package
`files` list, none of these enter the npm artifact.

Fixtures never stand in for installed Pi, npm, Git, SQLite or the package loader: tests use
temporary Pi homes, temporary Git repositories, real SQLite and real AgentFS where the host permits
(the repository contract). `@dpugliese/pi-agent-wave` remains the MIT-licensed package described
here.