# pi-agent-wave

pi-agent-wave gives Pi a durable, evidence-gated delegation graph. A supervisor session dispatches Pi, Codex, and Claude workers through ACPX, isolates every attempt in an AgentFS copy-on-write sandbox, and advances the graph only on verified evidence. JetBrains Air drives it through `pi-acp` in headless mode; Herdr is an optional presentation adapter for visible worker tabs.

This document is the reference for installing, configuring, and operating the package. The repository root README covers the product overview and the Air journey.

## Contents

| Section | What it covers |
| --- | --- |
| [Requirements](#requirements-and-compatibility) | Tested Pi, ACPX, AgentFS, and pi-acp versions |
| [Install](#install) | Runtimes, the package, optional Herdr |
| [First run](#first-run) | Restart, enable an adapter, start a run, watch it |
| [Configure](#configure) | Initializer, doctor, migration, environment variables |
| [Environment and storage](#environment-and-storage) | Every variable the package reads and where it writes |
| [Commands](#pi-commands) | `/delegate`, `/graph`, `/failover` |
| [Tools](#tools) | `delegate_graph`, `questionnaire`, cmux hooks |
| [Result contract](#result-contract) | `runtime-v1`: retained answers, audited changes, explicit decisions |
| [Graphs](#graphs) | Build, research, operational search |
| [Worker lifecycle](#worker-lifecycle) | Agent selection, credentials, sandbox, settlement, cleanup |
| [Failure recovery](#failure-recovery) | Retry, chain fallback, parking, main-session failover |
| [Verification tooling](#verification-tooling) | Host audit, live matrix, measurement, live result probe |
| [Known limitations](#known-limitations) | What is proven, what is open |
| [Security](#security) and [Uninstall](#uninstall) | |

## Requirements and compatibility

| Component | Version | Role |
| --- | --- | --- |
| Pi | `0.84.1` or `0.84.2` | Host and supervisor |
| ACPX | `0.13.2` | Worker execution for Pi, Codex, and Claude |
| Turso AgentFS | `0.6.4` | One copy-on-write sandbox per attempt |
| pi-acp | `0.0.31` | Air's ACP bridge to Pi |
| Herdr | any current release | Optional visible worker tabs |

ACPX `0.13.2` and AgentFS `0.6.4` are hard requirements: the package fails before registration when either is absent or mismatched. No compatibility is claimed outside this matrix. ACPX, AgentFS, `pi-acp`, Herdr, and the ACP adapter packages are external runtimes; pi-agent-wave bundles none of them.

## Install

### ACPX and AgentFS

```bash
npm install -g acpx@0.13.2
acpx --version
agentfs --version
```

AgentFS must report `agentfs v0.6.4`. Download the platform archive and checksum from https://github.com/tursodatabase/agentfs/releases/tag/v0.6.4.

Claude workers authenticate with a token created by `claude setup-token`, supplied only through a mode-600 file whose path is in `PI_CLAUDE_OAUTH_TOKEN_FILE`. The doctor reports a missing or insecure file without printing its contents.

### pi-agent-wave

The npm package has not been published yet. Install from a retained source checkout:

```bash
git clone https://github.com/Deviad/pi-agent-wave.git
pi install ./pi-agent-wave-new-design/extensions/pi-agent-wave
```

Keep the clone in place; Pi loads the extension from that path. After npm publication the command will be:

```bash
pi install npm:@dpugliese/pi-agent-wave
```

Do not use the npm form before the package exists in the registry.

`pi install` records the checkout path in `~/.pi/agent/settings.json` under `packages`; Pi loads the extension's TypeScript from that path at startup, so a change in the checkout takes effect after Pi is restarted, and an uncommitted checkout runs exactly as it is on disk.

### Optional: Herdr

Herdr adds visible worker tabs and `/graph focus`. Install it only if you want that:

```bash
brew install herdr
# or: curl -fsSL https://herdr.dev/install.sh | sh
herdr --version
```

Windows PowerShell: `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`. See the [Herdr installation guide](https://herdr.dev/docs/install/) for other options.

## First run

1. **Restart Pi.** Extensions load at startup.
2. **Check the tier routes.** Every worker is dispatched to the adapter its frozen model selects (`openai-codex/*` Codex, `claude-code/*` Claude, anything else Pi); no enablement step exists. Put a Pi-adapter model behind every Codex or Claude entry in `~/.pi/agent/model-routing.jsonc` so an exhausted plan quota or usage window falls over to another provider instead of parking the run. Provenance for each adapter's runtime-v1 evidence lives in [Adapters](#known-limitations) and the PRD.

3. **Check the doctor** (`node scripts/doctor.mjs` from the checkout) for the routing file, credentials and the optional Claude token.
4. **Start a run.** From a Herdr workspace in your terminal the workers get tabs; from Air or a plain terminal they run headless:

   ```text
   /delegate research where is cache invalidation triggered in this repository
   /graph watch <runId> --follow
   ```

   The run id is in the run notice and in `/graph status`. As soon as the first worker registers, a numbered agent list opens above the editor; type its number and press Enter to see the worker's task, state, live output and retained answer in the terminal, `q` goes back and then closes, Escape asks to cancel the run's workers, `/graph agents` reopens. The explicit follow view uses the same number-plus-Enter details and `q` closes it; `/graph focus` brings a worker's tab forward.
5. **Decide what a role thinks.** The tier a role maps to in `model-routing.jsonc` carries `thinking`; that level is frozen into the run and written into each worker's private settings, so a `high` tier streams thoughts (shown dimmed) and an `off` tier does not. The level applies to runs started after the change.

## Configure

Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. Route inspection and failover also honor `PI_MODEL_ROUTING` (an explicit `model-routing.jsonc` path) and `PI_MODEL_CATALOG` (an explicit `models.json` path).

A local-path install loads the extension but adds no shell commands, so run the scripts through Node. After npm publication, the package binaries will be `pi-agent-wave-init`, `pi-agent-wave-init apply`, `pi-agent-wave-doctor`, and `pi-agent-wave-migrate`:

```text
pi-agent-wave-init [dry-run|apply|rollback] [options]
pi-agent-wave-doctor [--json] [--agent-dir <path>] [--routing <path>] [--models <path>]
pi-agent-wave-migrate [preflight|dry-run|apply|rollback] [options]
```

### Initializer

The initializer writes a valid `model-routing.jsonc` from the models already in your catalog. It defaults to dry-run and writes only on an explicit `apply`:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs --agent-dir "$PI_CODING_AGENT_DIR"
```

It reads `models.json` (`--models`, then `PI_MODEL_CATALOG`, then the agent directory) and offers only ids found under `providers.<provider>.models[].id`. It never creates providers, credentials, or `models.json`.

Interactive mode prompts for one model per tier: the six public tiers plus the optional `local-fast` tier. Automation passes every required tier explicitly with `--non-interactive`; each flag takes a comma-separated `provider/model-id` chain whose order becomes the tier's fallback chain:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply --non-interactive \
  --tools openai-codex/gpt-5.4-mini \
  --coding openai-codex/gpt-5.6-luna \
  --test openai-codex/gpt-5.4-mini \
  --review claude-code/claude-opus-5 \
  --reasoning claude-code/claude-opus-5 \
  --long-context openai-codex/gpt-5.6-luna \
  --local-fast ds4/deepseek-v4-flash
```

Apply fails closed when an existing `model-routing.jsonc` differs or a pi-fzf `route` or `delegate-model` command would be overwritten. `--force` backs the originals up first to a private, content-addressed directory under `migration-backups/pi-agent-wave-init/<id>/`, and `rollback --manifest` restores them byte-for-byte:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply --force
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs rollback --manifest /path/to/migration-backups/pi-agent-wave-init/<id>/manifest.json
```

When pi-fzf is installed (detected from `settings.json`), the initializer merges `route` and `delegate-model` list and preview commands that point at the installed package's `route-picker.ts`, leaving unrelated commands untouched. Without pi-fzf the plan reports `skipped` and creates no `fzf.json`.

### Doctor

The doctor is read-only:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs --json
```

It checks agent-directory resolution, catalog readability, routing JSONC, the six required tiers and roles, non-empty chains, catalog membership, local-model loopback validity, pi-fzf targets, package entry points, and real `policy-resolver` and `route-picker` execution. Its `route-credentials` section names the executing agent for every routed model and whether that agent's credential store is structurally usable. It exits nonzero only on a required failure; absent pi-fzf is a warning. Output redacts credential-bearing fields.

### Migration from a loose install

The migration utility moves a loose extension install aside and enables the package. It defaults to dry-run:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs preflight
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs apply
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs rollback --manifest /path/to/manifest.json
```

Apply moves conflicting loose extensions to `migration-backups/pi-agent-wave/`, records a manifest, enables the package source in `settings.json`, and repairs the pi-fzf `route` and `delegate-model` commands to execute the installed package's `route-picker.ts`. The original `fzf.json` bytes are kept in the manifest. Review every dry-run before applying, and never migrate a real installation without explicit authorization.

## Environment and storage

| Variable | Read by | Meaning |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | extension, scripts | Pi agent directory; default `~/.pi/agent` |
| `PI_MODEL_ROUTING`, `PI_MODEL_CATALOG` | resolver, doctor, picker | Explicit `model-routing.jsonc` and `models.json` paths |
| `DELEGATE_GRAPH_DB` | extension, settlement | Graph database path; default `~/.cache/delegate-graph/delegate-graph.db`. Tests and the measurement driver point it at a temporary file |
| `PI_CLAUDE_OAUTH_TOKEN_FILE` | launcher, doctor, matrix | Mode-600 raw Claude token for `claude-code/*` workers |
| `CODEX_HOME` | launcher, doctor | Codex credential and configuration home; default `~/.codex` |
| `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID` | extension, launcher | Set by Herdr in a workspace shell; complete identity selects the Herdr transport under `auto` |
| `PI_DELEGATE_WAIT_TIMEOUT_MS` | launcher | Bound on waiting for a worker to settle |
| `PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS` | launcher | Bound on waiting for the worker process to exit after its result; default `30000` |
| `PI_GRAPH_WATCH_INTERVAL_MS` | extension | Redraw interval of the agent list and of `/graph watch --follow`; default `2000`, minimum `50` |
| `PI_ACPX_CONFIG`, `PI_ACPX_CANCEL_CONFIG`, `PI_RUNTIME_SETTLE_CONFIG` | worker scripts | Private per-attempt configuration paths set by the launcher; never set them yourself |

Where the package writes:

| Location | Contents | Lifetime |
| --- | --- | --- |
| `~/.cache/delegate-graph/delegate-graph.db` | Runs, operations, agents, events, runtime attempts, decisions, integrations, adapter evidence rows | Until `/graph prune` |
| `~/.cache/delegate-graph/runtime-content/` | Content-addressed retained answers, staged files and manifests | With the run |
| `~/.cache/delegate-graph/failures/<runId>/` | Diagnostics for operations that were never dispatched | With the run |
| `/tmp/delegate-graph-herdr-<run>-<operation>.*/` | The attempt's private run directory: task, prompt, worker configuration, ACPX and AgentFS homes, capture files, settlement and cleanup records, materialized run evidence, retained failure bundles and raw streams | Attempt directories are removed after a clean settlement; the run directory and its records remain |
| `<workspace>` | Files placed by `integrate` through the journal, and nothing else | Yours |

All of these are private, mode 600 or 700, and may contain sensitive values. None is packaged.

## Pi commands

The same operations are available to ACP clients through the `delegate_graph` tool. For JetBrains Air, register a global ACP agent whose command is the absolute `npx` path and whose args are `["-y", "pi-acp@0.0.31"]`, select Pi in a new Air task, and ask it to use `delegate_graph`; Air owns the Pi process and receives structured progress, questions, cancellation, recovery, and `awaiting_user` results in headless mode without Herdr.

### `/delegate`

```text
/delegate [--policy <auto|cheap|balanced|strong|local|long-context>] <task>
```

Starts a durable run, freezes the model route for every role, renames the Pi session, and injects the supervisor contract. The only leading flag is `--policy`; flags inside the task text stay task text. In TUI mode, omitting `--policy` opens the policy picker; headless mode defaults to `auto`.

A task is a build graph unless it begins with `research`, `explore`, or `search`; those prefixes select the read-only research graph and are removed from the task text.

```text
/delegate Implement tenant-scoped API keys
/delegate --policy strong Implement tenant-scoped API keys
/delegate research compare SQLite replication options
/delegate --policy local search for the source of the cache invalidation bug
```

| Policy | Behavior |
| --- | --- |
| `auto` | Each role's configured default tier |
| `cheap` | The configured economy route |
| `balanced` | Balance capability and cost |
| `strong` | Stronger configured models |
| `local` | Local routes only; preflight fails closed if a role cannot meet its capability floor locally |
| `long-context` | The configured long-context route |

Capability floors may promote a role to a stronger tier. The frozen policy records promotions and stays authoritative for every retry and resume.

### `/graph`

| Command | Purpose |
| --- | --- |
| `/graph agents` | Reopens the session's numbered agent list. It opens by itself when the first worker of the session registers and appends later workers with stable numbers, across runs and retries. A number followed by Enter opens that attempt's details: run and status, node, role, transport, model, task, process state (running, settled with its outcome, or superseded) and acceptance, the rendered tail of the retained stream, and the retained answer after settlement, bounded; missing output or answer is stated. Settled or superseded workers fold into one line, `settled (N): 1, 3 | s shows them`, so only running workers are listed; `s` shows or hides them, their numbers never change and still open details. `r` refreshes; `q` clears a pending number, returns from details to the list, and closes the list. Escape asks to cancel every running worker of the run in view (the selected worker's run, otherwise the most recently registered one): the prompt names the workers, Enter confirms, `q` or Escape aborts. A confirmed cancellation stops each worker through its structured cancel script, settles its attempt as cancelled, and records the run cancelled; a worker that cannot be confirmed stopped is named in the notice and in the operation's error. Keys reach the list only while the editor is empty. Selection never runs a Herdr focus or cancel command, so a worker whose tab is gone stays inspectable. TUI only; the redraw timer runs only while a listed worker is running and the view is open |
| `/graph status <runId> [--follow]` | Graph state, pending work, blockers, registered workers, and for runtime runs each attempt's process, acceptance, capture, and session state. With `--follow` (before or after the run id) it is an alias of `/graph watch <runId> --follow` |
| `/graph watch <runId> [--follow]` | One line per running worker: agent, node, process state, tool-call count, and the last thing it did, rendered from its live ACPX stream; the most recent rendered lines follow. Without `--follow` it prints once. With `--follow` it stays on screen as a widget above the editor, redraws every two seconds while the run is active, and takes keys while the editor is empty: a number then Enter opens that worker's details (the same view as the agent list, bound to the attempt, so a vanished Herdr tab changes nothing), `r` redraws; `q` clears a pending number, returns from details, and closes; Escape asks to cancel the run's running workers with the same confirmation as the agent list. It never focuses a worker; use `/graph focus` for the tab. The timer lives only while the view is open. Read-only |
| `/graph log <runId> [--tail <count>] [--agent <name>]` | The event ledger; default tail 50, filterable by agent |
| `/graph focus <runId> <node-or-agent>` | Bring a Herdr worker tab forward; headless workers have nothing to focus |
| `/graph resume <runId> <operationId>` | Operator-approved retry of a parked operation with its stored policy digest and frozen route; never reopens the picker |
| `/graph ledger <runId> [path]` | Derived, read-only JSON view of a run: attempts, outcomes, candidates, checkpoints, decisions, supersessions, events. Printed, or written mode-600 to `path`. It is consulted by no gate. |
| `/graph prune [days]` | Remove settled runs older than the retention window (default 30 days) |

`/graph resume` is the operator's fenced replacement of a parked attempt: it advances the transient counter so the new identity is fresh, never restores the budget, and never bypasses edges or joins.

### `/failover`

Main-session failover is separate from worker failover and is off until enabled:

| Command | Purpose |
| --- | --- |
| `/failover enable <tier>` | Arm same-tier runtime failover for the current session; the current model must belong to the tier route |
| `/failover status` | Enabled state, route position, lock state, and latest recovery details |
| `/failover unlock <tier>` | Clear a manual-selection lock and re-arm the tier |

Exact-model locks cannot be unlocked; they remain authoritative.

## Tools

### `delegate_graph`

`delegate_graph` is the state-machine API behind `/delegate`. It is what ACP clients such as Air call directly.

| Operation | Input and behavior |
| --- | --- |
| `init` | `story`, `task`; optional `graph` (`build`, `research`, `operations`), `modelPolicy`, and `commands` for operations runs. Refused until every adapter the frozen routes can select has an evidence row. Returns the run and its first pending operations. |
| `next` | `runId`. Current-phase operations with their frozen route, `modelPolicy`, `policyDigest`, attempt counters, `retry_not_before`, and the active attempt. |
| `status` | `runId`. Read-only rendered status. |
| `watch` | `runId`. Read-only view of every running worker: agent, node, process and acceptance state, the retained stream path, its last rendered activity, the most recent rendered lines, and prompt, tool-call and text counts. Emits a `watch` progress event, so ACP clients such as Air show the same summary. Consulted by no gate. |
| `dispatch` | `runId`, `operationId`, optional `transport`. Preflights, materializes the run evidence for the worker, launches one worker, and registers the agent and the attempt under its frozen identity. |
| `collect` | `runId`, `operationId`. Waits for the worker and settles the attempt from durable evidence: process outcome, retained candidate, observed session. Collecting again returns the same settlement. The result also carries what the supervisor needs to decide: `answer` (the retained answer, first 16 KiB, with `answerBytes` and `answerTruncated`), `verdict` (the answer's final `VERDICT:` line, or null), a `decide` template with this operation's id and the fields its node takes (`verdict` for review, test, audit and source_search; `payload.slices` for thinker_plan and thinker_split), and a `note` naming the next step (`op=integrate` first for coding and operational candidates, `op=retry` when no candidate was retained). |
| `integrate` | `runId`, `operationId`, optional `decision: "rejected"` to roll back. Applies a coding or operational candidate's audited changes through the journal. |
| `decide` | `runId`, `operationId`, `decision` (`accepted` or `rejected`), `reason`, optional `verdict` and `payload`. The only way an operation completes. `retry`, `defer`, `abort` and `escalate` are refused here with a message naming `resolve`, which applies only to a parked run. A thinker on the build or research graph is accepted only with `payload.slices` (`id`, `name`, `task`, and `ownedPaths` on the build graph). |
| `retry` | `runId`, `operationId`, optional `retryReason`. Replaces a `failed`, `interrupted` or candidate-less `exited` attempt under the frozen budget. For a launch failure with no registered attempt, pass the `error` plus the `modelAttempt` and `transientAttempt` the launch used; a replayed or stale failure is refused. |
| `resolve` | `runId`, `operationId`, `decision`: `retry` (the operator's fenced replacement of a parked attempt), `defer` with `deferredUntil`, `abort`, `escalate`. |
| `cancel` | `runId`, `operationId`. Cancels through the persisted attempt boundary and records `cancelled`; an operation that was never dispatched is cancelled with a retained diagnostic. |
| `record` | `runId`, `operationId`, `status: "cancelled"` only. Every other transition was removed with the report contract. |

Direct initialization accepts every tagged model-policy form: `auto`, a named preset, an explicit tier, or an exact model with a reason. `/delegate` exposes only the six picker policies.

#### Dead and unlaunched attempts

`collect` always converges. When the launcher cannot produce a settlement record, the attempt settles `failed` with the launcher's reason and names the retained `failure-<operationId>.json` diagnostic bundle (mode 600, redacted, written before the attempt directory is removed); the operation keeps that failed attempt until `retry` classifies it. `cancel` refuses while a worker's ACPX state is `alive` and its cancel command fails, and records `cancelled` when the state is already `no-session`.

An operation whose worker was never registered has nothing to collect: `collect` refuses it without writing anywhere, and `cancel` settles it as cancelled with a diagnostic under `failures/<runId>/` beside the graph database naming the cause. A dispatch whose preflight fails classifies the launch failure through `retry`, fenced to the exact counters that were dispatched. A wrong `runId` is a refusal, not a write.

A parked run resumes through `resolve`: `retry` supersedes the parked attempt and returns the operation to `pending` with a fresh identity; `defer`, `abort` and `escalate` are graph transitions. An escalated run can also be resumed by the operator. Foreign, stale, cancelled, terminal, and completed semantic-cap operations cannot be reopened.

### `questionnaire`

`questionnaire` presents one or more option questions, each with an `id`, `prompt`, and options plus optional `label` and `allowOther`. In a terminal it renders Pi's picker. In ACP clients with a dialog UI but no terminal (Air, IntelliJ via `pi-acp`) it renders each question as a native picker with Cancel and, after the first question, Back; a final review picker requires an explicit Submit, so nothing is sent before you confirm. Free-form answers are typed in chat. Without any dialog UI it returns an `awaiting_user` state with a Markdown table of choices.

### cmux hooks

`cmux-session.ts` has no command. When cmux metadata and hooks are present it forwards session, prompt, and stop metadata; otherwise it does nothing.

## Result contract

Every run uses `runtime-v1`: workers author no report, the runtime retains what happened, and the supervisor decides. The earlier report contract, `legacy-v1`, was removed on 2026-09-12; naming it is refused. Operations runs settle the operational candidate kind described under [Operational search delegation](#operational-search-delegation).

**Adapters.** Every adapter is dispatchable; the frozen model selects it. The earlier per-adapter enablement gate (`/graph enable-adapter`, the `runtime_adapters` table) was removed on 2026-09-12 with schema v11; the evidence it pointed at is listed under [Known limitations](#known-limitations). Nothing enables autonomous scheduling.

**Attempts.** `dispatch` registers the attempt with the worker's frozen identity (run, operation, role, model attempt, transient attempt, model, agent); the ACP request id binds later from the worker's own stream. `collect` waits for the worker and, before the session is closed, the provider boundary is verified, or anything is cleaned up, retains the public answer and (for `implement`) the audited AgentFS changes as content-addressed private files. The process outcome, candidate, and observed session identity (`loaded`, `created`, `resumed`, `expected`) are then settled immutably. A close, provider-boundary, or cleanup failure after that point comes back as `postSettlementFailures` and never discards the candidate. Collecting again returns the same settlement.

**Decisions.** An `exited` attempt is completed or parked only by `decide`. `accepted` with a `reason` (and, for review, test, audit and source-search nodes, the `verdict` you read from the answer; the worker prompt asks those roles to end with one line `VERDICT: <value>`) completes the operation through the graph's join and transition logic. `rejected` marks the operation failed and parks the run with the candidate retained. A coding or operational candidate with file changes must be applied with `integrate` first; the journal reserves the Git workspace, keeps preimages, recovers or rolls back interrupted writes from private staging on the same filesystem, and refuses changed bases, dirty affected files, symlinks, Git-internal paths, missing parents, and files over 16 MiB. A candidate without changes needs no integration.

**Retry and fallback.** A `failed` or `interrupted` attempt, or an `exited` attempt whose capture produced no candidate, is replaced only by `retry`. Its recorded failure text is classified: transient failures spend the three-attempt same-model budget, then advance to the next model of the frozen chain, then park the run in `awaiting_user`; permanent failures park at once; exact-model locks never advance. A replacement stamps the old attempt `superseded`, returns the operation to `pending` with a `retry_not_before` backoff, and the next `dispatch` mints a new attempt key and ACPX session from the advanced counters. Old identities can no longer register. A dispatch preflight failure with no worker registered goes through the same classification, fenced to the exact counters that were dispatched so one failure can never spend the budget twice. A failed coding attempt whose partial candidate was prepared or applied cannot be replaced until that integration is rolled back, and a superseded attempt's candidate can only ever be rolled back, never applied. A parked run resumes only through the operator's `resolve` with `retry` or `/graph resume`, which advance the transient counter so the replacement identity is fresh without restoring the budget; `defer`, `abort` and `escalate` are graph transitions. `record` accepts only cancellation.

**Evidence durability.** The settlement record is published atomically: written under a private temporary name, fsynced, linked into place exclusively, then the directory is fsynced. A crash between content retention and the record leaves no partial file; re-collecting replays the settlement from the same retained content. `/graph ledger` derives a read-only JSON view of the run from these facts.

**Bounds and limits.** Capture bounds individual events to 1 MiB and total input to 16 MiB. Response completeness is labelled unverified, and independent review of a candidate is the caller's responsibility, recorded in the decision reason.

**Adapters.** Pi is proven end to end on the build, research and operations graphs. Claude passed the probe under the configuration self-write rule described under [Credentials and configuration](#credentials-and-configuration) but has not run a graph. Codex is proven on the research, build and operations graphs (`agent-output/runtime-measure-codex-20260912/`, `runtime-measure-codex-build-20260912/`, `runtime-measure-codex-operations-20260912/`): with its shell available, which graph dispatch always is, it reads and edits inside the overlay; only the evidence-only review gate, which removes the terminal, leaves Codex without file access. Codex's own `sandbox-exec` was refused once inside the overlay during the build smoke; the tester reported the blocker with `VERDICT: NOT_OK`, the graph returned to implementation, and the next test pass ran clean. Expect an occasional extra cycle of that kind with Codex.

## Graphs

### Build

```text
thinker_plan -> implement (fan-out) -> review -> test -> audit -> terminal
```

Implementers fan out only when `next` returns several eligible operations, and the join completes before review. A review `FAIL` returns to implementation for up to two fix iterations; a test `NOT_OK` returns for up to three rounds. These are graph edges, never ad hoc retries.

### Research

Prefix the task with `research`, `explore`, or `search`:

```text
thinker_split -> search (fan-out) -> thinker_synthesize -> terminal
```

Searchers are read-only and may run in parallel; synthesis waits for their join.

### Operational search delegation

Use the `operations` graph when workers must run existing commands and write explicitly owned result artifacts:

```json
{
  "op": "init",
  "story": "source-search",
  "graph": "operations",
  "task": "Run the supplied source commands",
  "commands": [
    {
      "id": "source-a",
      "name": "Source A",
      "command": {
        "executable": "node",
        "args": ["/absolute/path/search.mjs", "--source", "source-a"],
        "cwd": "/absolute/project/path"
      },
      "ownedPaths": ["/absolute/project/path/runs/source-a"]
    }
  ]
}
```

The graph is `source_search (fan-out) -> thinker_synthesize -> audit`; it skips planning. Each source operation keeps its `command_json` and disjoint writable paths. An optional `checkpoint` names the file the source script writes, relative to `cwd`, and must lie under one of the command's owned paths; it is persisted with the command. The launcher receives `command_json` unchanged as `--command-json`; the worker prompt allows read-only instruction loading, then requires that exact argv as the first execution command.

A settled `source_search` attempt is an **operational candidate**: the worker's answer, which ends with `VERDICT: DONE` or `VERDICT: BLOCKED`, plus the audited overlay changes under the owned paths (checkpoint, results, logs) staged as content. When a `checkpoint` was declared, the staged checkpoint file is parsed at settlement and its integer `jobsSaved` and string `status` are recorded as observed facts on the candidate and in the ledger; the process exit code is not observable by the supervisor and is not recorded. Artifacts reach the host through `integrate`, using the same journal as coding candidates with the Git checks switched off, so the working directory need not be a repository. `decide accepted` with `DONE` advances to synthesis; with `BLOCKED` the run parks `blocked`. Every source result is ledgered automatically by operation ID in the derived run ledger, which covers every attempt, candidate, checkpoint and decision and is materialized to later workers as evidence. Concurrent source workers cannot own the same path or SQLite database; persist or merge shared data in a separate serialized stage.

### Driving a run from an API

Call `init`, then repeat `next -> dispatch -> collect -> [integrate] -> decide | retry` (`integrate` only for a candidate with staged changes) until the run is terminal or parked. Never invent operations, dispatch work `next` did not return, or change the returned policy digest and route.

## Worker lifecycle

### Transport

Execution is ACPX-only. Headless runs without Herdr. `auto` selects Herdr only when the `herdr` executable and complete workspace and tab identity are present; explicit `herdr` fails closed without them, and explicit `headless` creates no Herdr resource. Both adapters share planning, launch, audit, cancellation, settlement, and cleanup, and both deliver the same frozen policy, model identity, role, and failover route.

### Agent selection and identity

`openai-codex/*` selects ACPX Codex, `claude-code/*` selects ACPX Claude, and every other frozen model selects ACPX Pi. Each `(runId, operationId, modelAttempt, transientAttempt)` owns one ACPX session and one AgentFS session; a retry or fallback closes the old attempt and creates a new identity.

### Credentials and configuration

Before launch, the credential store of the agent that will execute the model is preflighted:

- `openai-codex/*` checks `CODEX_HOME/auth.json` for `OPENAI_API_KEY` or `tokens.access_token`; the printed remedy is `codex logout && codex login`.
- `claude-code/*` needs a mode-600 `PI_CLAUDE_OAUTH_TOKEN_FILE` or `~/.claude/.credentials.json`.
- Every other model runs on Pi and is checked with `pi auth check --provider <p> --json --no-refresh` under the supervisor's real home.

The checks are structural and offline, so a revoked but unexpired token surfaces at runtime as a transient `worker-runtime-failure` and the chain advances. A provider is blocked with `worker preflight: provider "<p>" has no usable credential for <model> (<reason>)` only when neither the live store nor `print-api-key` can produce a credential; `dispatch` records that as a transient failure (`dispatched: false`, `blocked: "preflight"`).

The worker's private Pi settings carry only the supervisor's defaults, zero packages, and the frozen route's `thinking` level as `defaultThinkingLevel`, so a `high` tier thinks and an `off` tier does not, per role; a worker streams thoughts, which the pane and `/graph watch` show dimmed, only when its level allows. Credentials are then materialized, not linked: `providers/pi-agent/auth.json` is a real mode-600 file holding only the selected provider's entry. The live `auth.json` is never symlinked into an attempt, so a worker's refresh cannot write through and a live change cannot invalidate a running attempt. Only the executing agent's configuration is delivered, as mode-600 regular-file snapshots. Snapshots and Claude setup-token copies must keep their exact bytes, modes, and file type; Pi's private `models-store.json` is a mutable catalog copy that may refresh. An OAuth provider absent from the live store fails preflight rather than receiving a half-built credential.

Claude Code rewrites its own `settings.json` and `.claude.json` during tool use (it removed a key and bumped a counter in the live probe). Those two attempt copies are tolerated self-writes: they must remain regular, non-symlinked, mode-600 files that parse as a JSON object, and any change in bytes or key set is recorded as `configurationSelfWrites` (added keys, removed keys, digests) in the settlement result, never treated as a boundary failure. A non-JSON rewrite, a JSON array, a symlink, a mode change or a missing file still fails the attempt.

### Sandbox and staging

AgentFS runs with a repository copy-on-write base, a temporary HOME, `--no-default-allows`, and one private attempt directory. Writable operations stage only audited owned paths as content; read-only operations (including research `search`) record and discard all overlay changes and stage nothing. The graph passes its persisted access mode to the launcher, so role names never decide permissions. Worker subprocesses set `GIT_OPTIONAL_LOCKS=0` so inspection commands do not refresh the Git index. On this host a process inside the sandbox that changes into an absolute host path writes straight to the host, outside the overlay; the operational command instruction therefore names the working directory as `.`, and a declared checkpoint that appears on the host without an overlay change fails settlement.

Ignored paths default to `.git/index`: a worker that inspects its work with `git status` or `git diff` refreshes the index inside the overlay, and the live build measurement of 2026-09-12 refused every such attempt as an unowned change. Ignoring it grants no ownership: the index is never exported or staged, and integration refuses Git-internal paths regardless. Private direct launches may pass `--ignored-paths-json` to widen or empty the list; graph dispatch always uses the default. Owned `.DS_Store` and AppleDouble `._*` metadata stages with its directory; unowned platform metadata is discarded. Paths resolve through symlinks, and escaping or unresolvable ownership declarations fail the audit.

An audit refusal (an unowned overlay change) is a permanent failure of the attempt, never an automatic retry or an accepted candidate. Changed immutable configuration is retained in the private run directory in mode-600 files with expected and observed checksums; these files may contain sensitive values and are private evidence. Overlay-command and host-read failures produce distinct `audit_error` entries and may retry under the frozen budget. Comparison and staging buffer whole files in memory.

Staging reads a consistent SQLite backup of the closed delta with a 30-second budget; a failed backup fails the attempt and removes partial snapshots, with no raw DB/WAL/SHM fallback. Headless settlement waits for the worker process to exit after its result appears, bounded by `PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS` (default `30000`); a timeout fails the attempt.

### Settlement and cleanup

The answer and the audited overlay changes are retained as content-addressed private files and the settlement record is published before the worker session closes, the provider boundary is verified, or anything is cleaned up; a failure after that point is reported as a post-settlement failure and never discards the candidate. When capture is incomplete or produced no candidate, the raw worker stream is retained beside the record as private evidence.

Cancellation, focus failure, abort, retry, and cleanup all run the same persisted `acpx-cancel.ts` boundary: it validates the ACPX session, record, attempt key, and AgentFS session cwd, requires structured cancel acknowledgement and the transition to `idle` or `no-session`, then requires `session_closed` and final `no-session`.

Cleanup audits the queue owner, ACPX session files, AgentFS mount, server, database, and HOME, provider links, Herdr agent, pane, and tab, owned processes, and the attempt directory, and records that audit as `cleanup-<agent>.json` every time, including a repeat cleanup of an already torn-down attempt. Absence is the goal: a present resource is a failure, an already-absent one converges. `sessionClosed` is true only from an observed cancellation, an observed close, or a session absent from both session files and owned processes, and `sessionClosureEvidence` says which. Cleanup names credential targets by basename only.

### Watching a worker

The worker runs ACPX with `--format json --json-strict` because settlement needs the JSON-RPC stream to retain the answer and observe the session. That stream is written only to the attempt's private capture files. What the launcher prints, and therefore what a Herdr pane shows, is a rendering of it: assistant text as it streams, thoughts dimmed, one line per tool call (`\u25b8` started, `\u2713` completed, `\u2717` failed), `plan: done/total steps`, and short rules for prompt start, `end_turn`, cancellation and errors. Adapter bookkeeping (usage, commands, session info) is suppressed and non-JSON lines pass through prefixed with `|`. Nothing in the rendering is a success signal. `/graph watch` and `op=watch` apply the same renderer to the tail of each running worker's stream to produce the per-agent summary. `/graph watch --follow` is the navigable form: the summary stays on screen above the editor, a number plus Enter opens a worker's details, and it closes on `q`. `/graph focus` is the only command that brings a Herdr tab forward.

### Denials and empty turns

A denied authorization is permanent. ACPX exits with code 5 and prints `Permission request denied or cancelled` when every permission request in a turn is denied; the worker result records `permissionDenied` with `status: permission_denied`, the launcher raises `worker approval block: permission_denied …`, and the classifier resolves it to `approval-block`. The operation parks for authorization without spending the budget or switching provider.

A worker that exits without a candidate, because its capture was empty or incomplete, is a transient `worker-empty-answer` failure: `retry` spends the same-model budget and then the chain, and the raw stream is retained for diagnosis. No positive verdict is ever inferred from an exit code.

## Failure recovery

### Worker attempts

Every worker inherits its frozen tier, ordered chain, role, and exact-model lock. Infrastructure-shaped failures (HTTP 429 or 5xx, rate limit, quota, overload, timeout, connection reset or close, `ACPX worker failed`, `terminal=failed`, `QUEUE_RUNTIME_PROMPT_FAILED`, provider-link churn, AgentFS audit or snapshot errors, exit before result, exit without a candidate) are transient; `retry` applies the classification.

| Situation | Behavior |
| --- | --- |
| Transient failure, same-model budget remains | Same-model retry with full-jitter backoff; `retry_reason` set, `fallback_reason` null |
| Transient failure, budget spent, chain has another model | `model_attempt` advances, `fallback_reason` names the cause, the dead attempt's agent is marked failed, `model_fallback` logged |
| Transient failure on the last chain model | Run parks in `awaiting_user`; nothing promotes into another tier |
| Exact-model lock | Never advances; parks for a user decision |
| Semantic verdict (`FAIL`, `NOT_OK`, rejected candidate) | Never a fallback trigger; the graph's repair loop or the operator handles it |
| Denied authorization | Permanent `approval-block`; parks without spending budget |
| Worker died mid-attempt | `collect` settles the attempt `failed` and returns the diagnostic path instead of throwing; `retry` classifies it |
| Operation never dispatched | `collect` refuses without writing; `cancel` settles it with a diagnostic |
| Attempt `exited` with a candidate | Must be decided; `retry` refuses it |
| Attempt `exited` without a candidate | Transient `worker-empty-answer`; `retry` replaces it and the raw stream is retained |

When a run parks after exhausted retries, the supervisor emits an in-session warning notification. No modal dialog, speech, or sound is raised, so headless and test runs never block on a desktop prompt. In a terminal the supervisor then offers Retry now, Defer, Abort, or Escalate; in ACP clients the result reports `awaiting_user` for the client to resolve.

### Main session

`/failover` protects the interactive session, not workers, and is inactive until enabled:

| Scenario | Behavior |
| --- | --- |
| Delegated worker receives HTTP 429 | Already covered by the worker rules above; no `/failover enable` needed |
| Main session receives HTTP 429 | The model switches only if `/failover enable <tier>` was run in that session |
| Next candidate is from the failed provider | Skipped; recovery excludes the whole failed provider |
| Candidate unavailable or unauthenticated | Skipped; route-order search continues |
| Several providers return 429 | Recovery continues across distinct providers in route order |
| A fallback succeeds | The replacement stays active, exclusions clear, Pi's global `settings.json` bytes are restored |
| No provider remains | A visible `route-exhausted` blocked result; never a tier promotion |
| Manual model selection | Automatic switching locks until `/failover unlock <tier>` re-arms the route |
| Exact-model route | Automatic switching stays disabled |
| Semantic, invalid-request, refusal, context, tool, or quality error | Existing non-failover behavior |

Generic and quota-shaped 429s are both recoverable and stay distinct in diagnostics. `/failover status` and persisted evidence identify source and destination model, tier, route position, classification, and outcome. Raw provider bodies, headers, credentials, and keys never enter status, evidence, or retry messages.

## Verification tooling

### Host audit

Run the deterministic audit outside AgentFS before a final review:

```bash
node --experimental-strip-types scripts/production-audit.ts
```

It writes `agent-output/production-acpx-worker-backend/final-audit.json` with direct argv records, expected and observed counts, source and artifact hashes, cleanup inventory, and secret-scan results; unexpected counts or stale source bindings fail closed. A reviewer consumes this bundle through ACPX `--no-terminal`, so nested AgentFS, package-manager, build, test, and Git-write commands are unavailable; embed the required source and evidence text in the task.

### Live ACPX matrix

`test/acpx-real-matrix.test.ts` drives live sessions against Pi, Codex, and Claude and skips unless configured. `npm run test:acpx` refuses rather than reporting skips as passes:

```bash
cd extensions/pi-agent-wave
PI_CLAUDE_OAUTH_TOKEN_FILE=~/.config/pi/acpx-claude-token.txt npm run test:acpx
npm run test:acpx -- --dry-run
```

`RUN_REAL_ACPX_MATRIX=1` is set by the script; set it yourself only when calling `node --test` directly. `PI_CLAUDE_OAUTH_TOKEN_FILE` must name an existing mode-600 raw token file. `MATRIX_EVIDENCE_DIR` defaults to `agent-output/production-acpx-worker-backend/final-matrix`. Use `node --test`, never `bun test`, because the matrix imports `node:sqlite`. The run spends provider credits and is bounded by a fifteen-minute timeout. `test/` is not in the published package.

### Matched live measurement

`test/support/runtime-measure.ts` drives the production tool with real Pi-adapter workers through a fixed task and records phase durations, attempts, retries, fallbacks and outcomes into `agent-output/runtime-measure-<date>/`. `--graph research` (default) runs the research graph on a fixed corpus; `--graph build` runs the build graph on a temporary Git corpus with one implementation slice, integrates a coding candidate with `op=integrate` before deciding it, and reads review, test and audit verdicts from the worker's `VERDICT:` line; `--graph operations` runs a fixture source command through the operations graph. `--model` selects the model and therefore the adapter (`openai-codex/*` Codex, `claude-code/*` Claude, anything else Pi); the driver enables that adapter in its temporary store with the matching probe record and preflights that adapter's credential:

```bash
node --experimental-strip-types test/support/runtime-measure.ts --dry-run
node --experimental-strip-types test/support/runtime-measure.ts --preflight
node --experimental-strip-types test/support/runtime-measure.ts --execute --repeats 3
node --experimental-strip-types test/support/runtime-measure.ts --graph build --execute --repeats 3
```

Only `--execute` spends credits. The adapter is enabled in a temporary store only, candidates are accepted automatically by the driver (recorded as such), and cost is reported as unknown. It measures latency, turns and recovery, not quality. While workers run it samples `op=watch` every 20 s and keeps the samples as evidence. Recorded runs of 2026-09-12: research 3 + 3 repeats before the report contract was removed (runtime median 422 s), build 3 repeats (runtime median 905 s, all terminal with review PASS, test GREEN, audit PASS), operations smoke 4 (terminal, checkpoint observed), and a post-removal research smoke (terminal, 266 s), all under `agent-output/runtime-measure-*`.

### Live result probe

The runtime-v1 probe runs a text prompt and a read-only source check for each of Pi, Codex, and Claude with production provider snapshots and cleanup; `--agents` selects a subset:

```bash
python3 test/support/runtime-result-probe.py --dry-run
python3 test/support/runtime-result-probe.py --preflight
python3 test/support/runtime-result-probe.py --agents claude --dry-run
```

Its passing records are the adapter evidence cited by the PRD: `agent-output/runtime-result-probe-run3-20260912/pi.json` (Pi) and `agent-output/runtime-result-probe-run4-20260912/claude.json` (Claude, under the self-write rule). Codex's probe records show that without a terminal it issues no tool call; its evidence is the research smoke `agent-output/runtime-measure-codex-20260912/run-runtime-v1-1.json`, run with the terminal present as graph dispatch always is.

Only an explicit `--execute` spends credits. It needs a private `PI_CLAUDE_OAUTH_TOKEN_FILE` and a host that permits AgentFS loopback and mounting and process inspection. Every acpx invocation carries `--max-turns 2` because the cap is fixed at session creation. Evidence records the observed ACP session id and origin, cleanup absence, and any changed configuration keys without values. The probe does not enable `runtime-v1` and is not in the npm artifact.

## Known limitations

- **Absolute host paths escape the sandbox.** On this host a process inside `agentfs run` that changes into an absolute host path writes to the host, outside the overlay, and the ownership audit cannot see it. Workers are told to stay in `.`; the operational command instruction never names a host path; a declared checkpoint that appears on the host without an overlay change fails settlement. A general guard (an AgentFS confinement option or a post-attempt host comparison) is open.
- **Adapters.** Pi is proven end to end on build, research and operations graphs. Codex is proven on research only. Claude has passed the probe but no graph run.
- **Quality is not measured.** The measurement driver accepts candidates automatically; review, test and audit verdicts come from the workers, and independent review of a candidate remains the caller's decision.
- **Capture.** One Pi synthesis turn in the operations smokes exited with an incomplete capture and no answer; the retry replaced it and the raw stream is now retained whenever that happens, but the cause is not yet known.
- **Dispatch identity is reserved at registration, not before launch.** A crash between the launcher's start and the attempt's registration leaves a launched worker with no attempt row; it is settled through `cancel`. Reserving the identity before launch is recorded as open.
- **Live proofs need a capable host**: AgentFS loopback binding and mounting, process inspection, provider credentials, and explicit authorization to spend credits.

## Security

Pi extensions execute with your user account's full system access. Review the source before installation, especially `scripts/` and the worker-launch paths. Retained failure bundles and configuration snapshots are private evidence and may contain sensitive values; do not publish them.

## Uninstall

```bash
pi remove ./pi-agent-wave-new-design/extensions/pi-agent-wave
```

After npm publication:

```bash
pi remove npm:@dpugliese/pi-agent-wave
```

Removing pi-agent-wave does not remove Herdr, routing configuration, migration backups, or stored Delegate Graph runs. If a loose-install migration was applied, run its rollback first to restore the original files, settings, and pi-fzf configuration.

## Claude provider and header updates

`claude-code-auth.ts` registers the `claude-code` provider for the Pi supervisor. Its source is adapted from `@cgaravitoq/pi-claude-code-auth` 2.2.2 and maintained in this package. Credential discovery and refresh use the pinned `@cgaravitoq/claude-code-core` 0.1.0 dependency; the streaming adapter uses `@anthropic-ai/sdk` 0.91.1. Upstream attribution and MIT terms are in `lib/claude-auth-LICENSE`. This section is the integration reference; the upstream README is not included.

For a checkout installation, run `npm install --ignore-scripts` from this package directory before restarting Pi. If the separate auth package is already installed, remove its `npm:@cgaravitoq/pi-claude-code-auth` entry from Pi’s package list (including a source-filtered entry, if present). Do not load both providers. An existing `claude-code` login in Pi remains usable. If needed, authenticate the Claude Code CLI first, then use `/login claude-code` and choose a model with `/model`. The model catalog is inherited from the imported provider version.

This provider calls the Anthropic Messages API from Pi. Graph routes named `claude-code/*` still execute the actual Claude Code CLI through ACPX; this integration does not change worker routing or credentials. Importing the extension registers the provider and command without reading credentials or starting a refresh. Login/refresh use upstream behavior, including its CLI fallback; a fallback can invoke a model and spend usage.

Use these commands in Pi:

```text
/claude-headers status
/claude-headers update
```

`update` runs only `claude --version`, with a ten-second timeout, validates the result and atomically saves a mode-600 JSON file. The file is `$PI_CODING_AGENT_DIR/claude-code-headers.json`, defaulting to `~/.pi/agent/claude-code-headers.json`:

```json
{
  "schemaVersion": 1,
  "claudeCodeVersion": "2.1.268"
}
```

The default is 2.1.268 when the file is absent. Each request reads the file, so a successful update takes effect immediately. Invalid JSON or an unsupported schema produces an explicit error. A failed version query preserves the existing file. After installing a new Claude Code release, run `update`; there is no background polling or automatic installation of releases.

The selected version controls both User-Agent and the existing billing system block. `ANTHROPIC_CLI_VERSION` overrides the saved version, `ANTHROPIC_USER_AGENT` overrides only User-Agent, and `CLAUDE_CODE_ENTRYPOINT` retains the upstream entrypoint override (default `sdk-cli`). `status` reports the effective version and whether the User-Agent override is present. Do not include tokens or account identifiers in the JSON. Other header-rewriting extensions can override the outgoing request again; remove overlapping rules for this provider if you want this configuration to control its headers.

Version detection does not discover beta flags, billing algorithms or identity changes. Those remain tested source changes. Local request tests prove metadata construction and stream handling; they do not establish live API compatibility or that the reported “Unknown error” is fixed. Subscription acceptance remains controlled by the service.

If a Claude model stops with `refusal`, Pi displays that exact reason plus the server's category and explanation when provided, preserving any partial answer and usage. An unknown stop reason is named explicitly. `model_context_window_exceeded` is treated as a truncated response. These diagnostics do not establish why a particular live request was refused; compare the actual server explanation rather than assuming a header, quota or authentication failure.
