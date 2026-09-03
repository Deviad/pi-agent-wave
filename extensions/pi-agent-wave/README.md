# pi-agent-wave

pi-agent-wave adds transport-neutral multi-agent work to Pi. JetBrains Air can control Pi through `pi-acp` while headless ACPX workers run inside AgentFS; Herdr remains an optional presentation adapter.

Use it when you want ordered implementation and review, durable status and logs, isolated Pi/Codex/Claude workers, and evidence-gated recovery without requiring a separate UI.

The package provides Delegate Graph, the `questionnaire` tool, cmux session metadata hooks, and native model failover.

## Security

Pi extensions execute with your user account's full system access. Review the source before installation, especially migration and worker-launch scripts.

## Requirements and compatibility

- Pi `0.84.1` or `0.84.2`.
- ACPX `0.13.2` is required for ACP worker execution through Pi, Codex, and Claude.
- Turso AgentFS `0.6.4` is required for one copy-on-write sandbox per operation attempt.

ACPX, AgentFS, `pi-acp`, optional Herdr, and ACP adapter packages remain external and are not bundled with pi-agent-wave.

| Pi version | Status |
| --- | --- |
| `0.84.1` | Tested |
| `0.84.2` | Tested |

No compatibility is claimed outside this matrix.

## Install

### Optional: install Herdr presentation

With Homebrew on macOS or Linux:

```bash
brew install herdr
```

Or use Herdr's official installer on macOS or Linux:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
```

Verify the installation:

```bash
herdr --version
```

See the [official Herdr installation guide](https://herdr.dev/docs/install/) for other options.

### Install ACPX and AgentFS

```bash
npm install -g acpx@0.13.2
acpx --version
agentfs --version
```

AgentFS must report `agentfs v0.6.4`. Download the matching platform archive and published checksum from https://github.com/tursodatabase/agentfs/releases/tag/v0.6.4. The package fails before registration when ACPX or AgentFS is absent or mismatched. Claude execution uses a token created by `claude setup-token` and supplied only through a mode-600 file path in `PI_CLAUDE_OAUTH_TOKEN_FILE`; `pi-agent-wave-doctor --json` reports a missing or insecure file without printing token values.

### Install pi-agent-wave

The npm package has not been published yet. Install the current source release with:

```bash
git clone https://github.com/Deviad/pi-agent-wave.git
pi install ./pi-agent-wave-new-design/extensions/pi-agent-wave
```

Keep the cloned directory in place while Pi uses this local package source.

After npm publication, the command will be:

```bash
pi install npm:@dpugliese/pi-agent-wave
```

Do not use the npm command until the package is available in the npm registry.

## Contents

- `index.ts`: Delegate Graph commands and the `delegate_graph` tool.
- `questionnaire.ts`: structured terminal questions.
- `cmux-session.ts`: optional cmux session metadata hooks.
- `model-failover.ts`: same-tier, cross-provider model recovery.
- `scripts/`: shared transport-neutral lifecycle, headless and optional Herdr adapters, ACPX worker execution, AgentFS export, evidence, configuration, and migration utilities.

Herdr, ACPX, AgentFS, `pi-acp`, ACP adapter packages, overlay databases, Herdr-managed files, user settings, routing configuration, credentials, and generated evidence are not packaged.

## Configuration

Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. Route inspection and failover also honor:

- `PI_MODEL_ROUTING`: an explicit `model-routing.jsonc` path.
- `PI_MODEL_CATALOG`: an explicit `models.json` path.

Headless is selected when complete Herdr identity is absent. A complete Herdr workspace enables optional visible tabs and focus. Delegated workers automatically receive their frozen model route and failover settings. Main interactive sessions should use `/failover` instead of setting failover environment variables manually.

## Quick start

Pi's local-path install loads the extension but does not add package commands to your shell. Run the source scripts through Node.

Preview the configuration, apply it, and run the read-only doctor:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs
```

The first command is a read-only plan. Review it before running `apply`.

After npm publication, the package binaries will be:

```bash
pi-agent-wave-init
pi-agent-wave-init apply
pi-agent-wave-doctor
```

For JetBrains Air, add a global ACP agent whose command is the absolute `npx` path and whose args are `["-y", "pi-acp@0.0.31"]`. Select Pi in a new Air task, then ask it to use `delegate_graph`. Air-owned ACP sessions use structured progress, cancellation, recovery, and awaiting-user results without Herdr.

In a Pi terminal, start Pi and use the existing commands:

```text
/delegate Implement tenant-scoped API keys
```

To use optional visible tabs, start Pi inside a Herdr workspace before delegating.

## Pi command reference

### `/delegate`

```text
/delegate [--policy <auto|cheap|balanced|strong|local|long-context>] <task>
```

Starts a durable build or research graph, freezes the model route for every role, renames the Pi session, and injects the supervisor contract. The optional `--policy` must be the first argument. In TUI mode, omitting it opens the policy picker; headless mode defaults to `auto`.

A task is a build graph unless it begins with `research`, `explore`, or `search`. Those prefixes select the read-only research graph and are removed from the task text.

```text
/delegate --policy strong Implement tenant-scoped API keys
/delegate research compare SQLite replication options
/delegate --policy local search for the source of the cache invalidation bug
```

Policy behavior:

| Policy | Use case |
| --- | --- |
| `auto` | Use each role's configured default tier. |
| `cheap` | Prefer the configured economy route. |
| `balanced` | Balance capability and cost. |
| `strong` | Prefer stronger configured models. |
| `local` | Require local routes; preflight fails closed if a role cannot meet its capability floor locally. |
| `long-context` | Prefer the configured long-context route. |

Capability floors may promote a role to a stronger tier. The frozen policy preview records promotions and remains authoritative for retries and resumes.

### `/graph`

Use the run and operation identifiers returned by `/delegate` or shown in graph status.

| Command | Purpose |
| --- | --- |
| `/graph status <runId>` | Show graph state, pending work, blockers, and registered workers. |
| `/graph log <runId> [--tail <count>] [--agent <name>]` | Show the event log. The default tail is 50 entries; `--agent` filters it. |
| `/graph focus <runId> <node-or-agent>` | Focus an optional Herdr worker. Headless workers use status and log inspection. |
| `/graph resume <runId> <operationId>` | Retry an exhausted operation using its stored policy digest and frozen route; it does not reopen the picker. |
| `/graph prune [days]` | Remove settled runs older than the retention window; the default is 30 days. |

`/graph resume` is for a run waiting on an exhaustion decision. It does not bypass graph edges, joins, report validation, or retry limits.

### `/failover`

| Command | Purpose |
| --- | --- |
| `/failover enable <tier>` | Arm same-tier runtime failover for the current main session. The current model must belong to the tier route. |
| `/failover status` | Show whether failover is enabled, the current route position, lock state, and latest recovery details. |
| `/failover unlock <tier>` | Clear a persisted manual-selection lock and re-arm the named tier when the current model belongs to it. |

There is no implicit main-session activation. Exact-model locks cannot be unlocked with `/failover unlock`; they remain authoritative.

## Automation tools

These are Pi tools for agents, RPC clients, and headless orchestration rather than shell commands.

### `delegate_graph`

`delegate_graph` is the durable state-machine API behind `/delegate`.

| Operation | Required input and behavior |
| --- | --- |
| `init` | `story` and `task`; optional `graph` (`build`, `research`, or `operations`) and `modelPolicy`. An `operations` run also requires structured `commands`. Returns the run plus its first pending operation. |
| `next` | `runId`. Returns only operations currently eligible for dispatch, including each frozen route, `modelPolicy`, and `policyDigest`. |
| `record` | `runId`, `operationId`, and `status`, plus status-specific dispatch or result evidence. The extension enforces transitions, joins, retries, and report gates. |
| `status` | `runId`. Returns the durable graph status without changing it. |

For `record` with `status: "running"`, pass the frozen `modelPolicy` and `policyDigest` from `next`, the selected model and zero-based model attempt, `transport: "herdr"`, and the Herdr agent and tab identifiers. A same-model retry uses `retryReason`; a cross-model fallback advances `modelAttempt` and uses `fallbackReason`.

For `status: "completed"`, provide the private JSON `reportPath`; its schema and verdict are audited before the transition is accepted. For `status: "failed"`, provide `error`. Invalid edges, premature joins, exhausted retry budgets, and unevidenced completion fail closed.

Direct initialization supports the full tagged model-policy forms used by the API: `auto`, a named preset, an explicit tier, or an exact model with a reason. `/delegate` intentionally exposes only the six picker policies listed above.

### `questionnaire`

`questionnaire` presents one or more option questions in Pi's terminal UI. Each question supplies an `id`, `prompt`, and option list, with optional `label` and `allowOther`. Use it when an agent needs structured user input; cancellation returns no submitted answer.

In ACP/RPC clients with a dialog UI but no terminal (for example JetBrains Air or IntelliJ via `pi-acp`), it presents each question as a native selectable picker (`ctx.ui.select`, rendered by the client as clickable options). The tool blocks until a choice is made; multiple questions are shown one after another. Because a click is otherwise final, every picker appends a Cancel option (and, after the first question, a Back option): Cancel aborts the whole questionnaire and Back returns to the previous answer so it can be changed. Once every question is answered, a final review picker shows the collected answers and requires an explicit Submit before they are sent back to the model — so nothing is submitted until you confirm; from the review you can also go Back to change an answer or Cancel. Free-form "other" input is unavailable in ACP, so a custom answer must be typed in chat. If no dialog UI is available at all, it falls back to a structured `awaiting_user` state with a numbered Markdown table of the choices.

`cmux-session.ts` has no user command. When cmux metadata and hooks are present it forwards session, prompt, and stop metadata; otherwise it is a no-op.

## ACPX and AgentFS worker lifecycle

Worker execution is ACPX-only. Presentation transport is selected per attempt: headless runs without Herdr, while Herdr adds visible workspace tabs when explicitly selected or when `auto` detects complete Herdr identity.

- `openai-codex/*` selects ACPX Codex, `claude-code/*` selects ACPX Claude, and every other valid frozen model selects ACPX Pi through the shared TypeScript attempt planner.
- Each `(runId, operationId, modelAttempt, transientAttempt)` owns one ACPX session and one AgentFS session. Retry or fallback closes the old attempt and creates a new identity; one bounded report repair reuses the current session.
- AgentFS runs with a repository copy-on-write base, temporary HOME, `--no-default-allows`, and one private attempt directory. Writable operations export only audited owned paths. Read-only operations record and discard all overlay changes and export zero paths.
- Completion verifies the private settlement manifest against the registered ACPX/AgentFS attempt and its tagged headless or Herdr presentation identity, report hash, session close, provider-link integrity, export result, and private attempt-ledger audit.
- Cancellation, focus-identity failure, abort, retry, and cleanup all execute the same persisted `acpx-cancel.ts` attempt boundary. It validates the ACPX session, record, attempt key, and AgentFS session cwd; requires structured cancel acknowledgement and the observed transition to `idle` or `no-session`; then requires `session_closed` and final `no-session`.
- Cleanup independently audits the queue owner, ACPX session files, AgentFS mount/server/database/HOME, provider links, report-repair child, any Herdr agent/pane/tab, owned processes, and attempt directory. Any remaining resource or cleanup failure is terminal; unrelated workspace resources are never closed.
- Pi may use an execution-only supervisor projection after process exit 0 plus structured `end_turn`; the report explicitly makes no semantic task claim. Claude reads a setup token only from a mode-600 `PI_CLAUDE_OAUTH_TOKEN_FILE` path.

JetBrains Air is supported through `pi-acp`: Air launches and owns Pi as its ACP agent, and Pi dispatches ACPX/AgentFS workers through the headless transport without requiring Herdr. pi-agent-wave does not attach Air directly to an externally owned ACPX worker session.

Run the deterministic host audit outside AgentFS before final review:

```bash
node --experimental-strip-types scripts/production-audit.ts
```

It writes `agent-output/production-acpx-worker-backend/final-audit.json` with direct argv records, explicit expected and observed counts, production-source and artifact hashes, cleanup inventory, and secret-scan results. Unexpected counts or stale source bindings fail closed. The final reviewer consumes this bundle with ACPX `--no-terminal`, so nested AgentFS, package-manager, build, test, and git-write commands are unavailable.

## Runtime scenarios

### Build delegation

Use `/delegate <task>` for implementation or other state-changing work. The frozen build graph is:

```text
Thinker -> parallel Implementers -> Reviewer -> Tester -> Auditor
```

Implementers may fan out only when the graph returns multiple eligible operations. The join must complete before review. Reviewer or tester rejection returns through the graph's bounded repair path rather than creating an ad hoc retry.

### Research delegation

Prefix the task with `research`, `explore`, or `search` when the workers must stay read-only:

```text
Thinker split -> parallel Searchers -> Thinker synthesis
```

Searchers may run in parallel; synthesis waits for their join.

### Operational search delegation

Use the `operations` graph when a visible worker must run an existing command and write explicitly owned result artifacts:

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

The graph is `Source Searchers -> Thinker synthesis -> Auditor`; it skips pre-execution planning. Each pending source operation retains `command_json` and disjoint writable paths. Pass `command_json` unchanged to `scripts/delegate.ts` as `--command-json`; the generated worker prompt allows required read-only instruction loading, then requires that exact argv as the first execution command.

A completed `source_search` report must include an `execution` object with argv, exit code, source, run ID, checkpoint path, candidate count, and source status. Candidate-producing runs also require a result path; a zero-candidate run may omit it only when the checkpoint records zero saved jobs. Budget exhaustion also requires resume argv. Accepted, blocked, and failed source results are ledgered automatically by operation ID. Concurrent source workers cannot own the same path or SQLite database; persist or merge shared data in a separate serialized stage.

### Headless and Herdr transports

Headless transport runs ACPX/AgentFS workers without creating a Herdr tab or requiring Herdr installation. Herdr is an optional visible-presentation adapter: `auto` selects it only when the `herdr` executable and complete workspace identity are available, otherwise `auto` selects headless. Explicit `herdr` fails closed when its prerequisites are missing; explicit `headless` creates no Herdr resource. Every worker receives the same frozen policy, model identity, role, and runtime failover route regardless of presentation transport.

### Inspecting a live or blocked run

Use `/graph status` for the current state and `/graph log` for recent transitions. `/graph focus` brings a registered Herdr worker forward. If the graph requests a user decision after route exhaustion, use `/graph resume <runId> <operationId>` only when retrying that stored operation is intended.

### Headless or API-driven delegation

Use `delegate_graph init`, then repeat `next -> record running -> record result` until status is terminal or blocked. Never invent operations or dispatch work not returned by `next`. Preserve the returned policy digest and route on every attempt.

## HTTP 429 failover

Delegate Graph workers automatically inherit their frozen tier, ordered model chain, role, and exact-model lock through either headless or Herdr presentation. When a provider returns HTTP 429, the interrupted operation retries on the first available authenticated model from a different provider later in that same chain.

| Runtime scenario | Behavior |
| --- | --- |
| Delegated worker receives HTTP 429 | Failover is already armed; no `/failover enable` command is needed. |
| Main interactive session receives HTTP 429 | The model does not switch unless `/failover enable <tier>` was run in that session. |
| Another model from the failed provider appears next | It is skipped; the recovery sequence excludes the whole failed provider. |
| A candidate is unavailable or unauthenticated | It is skipped and route-order search continues. |
| More than one provider returns HTTP 429 | Recovery continues across distinct providers in frozen route order. |
| A fallback succeeds | The replacement remains active for the current session or delegated run, temporary provider exclusions clear, and Pi's global `settings.json` bytes are restored. |
| No eligible provider remains | Recovery returns a visible `route-exhausted` blocked result and never promotes to another tier. |
| Manual model selection | Automatic switching locks until `/failover unlock <tier>` successfully re-arms the route. |
| Route is an exact-model lock | Automatic switching remains disabled. |
| Error is semantic, invalid-request, refusal, context-overflow, tool, review, or quality failure | It retains the existing non-failover behavior. |

Generic rate-limit 429 and quota-shaped 429 are both recoverable but remain distinct in diagnostics. `/failover status` and persisted evidence identify the source model, destination model, tier, route position, classification, and outcome. Raw provider bodies, authorization headers, credentials, and API keys are not copied into status, evidence, or substituted retry messages.

## CLI reference after npm publication

After npm publication, these three package binaries will be the public administrative commands. For the current source install, use the direct Node commands shown below.

```text
pi-agent-wave-init [dry-run|apply|rollback] [options]
pi-agent-wave-doctor [--json] [--agent-dir <path>] [--routing <path>] [--models <path>]
pi-agent-wave-migrate [preflight|dry-run|apply|rollback] [options]
```

| Binary | Modes and use cases | Options |
| --- | --- | --- |
| `pi-agent-wave-init` | `dry-run` previews configuration, `apply` writes it, and `rollback --manifest <path>` restores a force-mode backup. | `--agent-dir`, `--routing`, `--models`, `--force`, `--backup-id`, `--non-interactive`, and the tier-chain flags documented below. |
| `pi-agent-wave-doctor` | Always read-only; use the default human report for interactive diagnosis or `--json` for automation. | `--agent-dir`, `--routing`, and `--models` override path discovery. |
| `pi-agent-wave-migrate` | `preflight` and `dry-run` inspect a loose installation, `apply` moves conflicts and enables the package, and `rollback --manifest <path>` restores it. | `--agent-dir`, `--package-source`, `--backup-id`, and `--manifest`. |

The packaged `delegate.ts`, `herdr_delegate.py`, `policy-resolver.mjs`, and `route-picker.ts` scripts support extension runtime and pi-fzf integration. They are not installed as general-purpose public binaries.

## Initial configuration

Fresh installations can bootstrap a valid routing file without hand-authoring JSONC.

The initializer defaults to dry-run and only writes when `apply` is explicit:

```bash
# Preview the plan without writing anything
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs --agent-dir "$PI_CODING_AGENT_DIR"

# Apply the plan
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply --agent-dir "$PI_CODING_AGENT_DIR"
```

The initializer reads the existing model catalog at `models.json` (via `--models`, then `PI_MODEL_CATALOG`, then the resolved agent directory) and derives selectable model ids strictly from `providers.<provider>.models[].id`. It never creates provider definitions, credentials, or `models.json`.

### Tier selection

Interactive mode prompts for one model per supported tier and covers all six public tiers plus the optional `local-fast` tier. Non-interactive automation supplies explicit tier flags and must name every required tier:

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

Each flag accepts a comma-separated chain of `provider/model-id` values; the order is preserved as the tier's fallback chain.

### Overwrite protection and backup

Apply fails closed when an existing `model-routing.jsonc` differs or a pi-fzf `route`/`delegate-model` command would be overwritten, leaving the target unchanged. Re-run with `--force` to back up the original before replacing:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply --force --agent-dir "$PI_CODING_AGENT_DIR"
```

Force mode writes a private, content-addressable backup under `migration-backups/pi-agent-wave-init/<id>/` (outside the auto-discovered extension directories) and retains enough data for a byte-exact rollback:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs rollback --manifest /path/to/migration-backups/pi-agent-wave-init/<id>/manifest.json
```

### Optional pi-fzf integration

When pi-fzf is installed (detected from `settings.json`), the initializer merges `route` and `delegate-model` list/preview commands that target the installed package's `route-picker.ts`, leaving every unrelated command and field unchanged. When pi-fzf is absent the plan reports `skipped` and does not create `fzf.json`.

## Health check

The read-only doctor diagnoses a configuration without changing it:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs --agent-dir "$PI_CODING_AGENT_DIR"
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs --agent-dir "$PI_CODING_AGENT_DIR" --json
```

It checks agent-directory resolution, catalog readability, routing JSONC parseability, the six required tiers and roles, non-empty model chains, catalog membership, local-model loopback validity, pi-fzf command targets, package entry points, and real `policy-resolver` and `route-picker` execution. It exits nonzero only when a required check fails; an absent pi-fzf is a non-fatal warning. Output redacts credential-bearing provider fields.

## Migration and rollback

The migration utility defaults to dry-run and never changes files unless `apply` is explicit:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs --agent-dir "$PI_CODING_AGENT_DIR"
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs preflight --agent-dir "$PI_CODING_AGENT_DIR"
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs apply --agent-dir "$PI_CODING_AGENT_DIR"
```

Apply moves conflicting loose extensions to `migration-backups/pi-agent-wave/`, outside Pi's auto-discovered extension directory, records a manifest, and enables the selected package source in `settings.json`. It also repairs the pi-fzf `route` and `delegate-model` list/preview commands so they execute the installed package’s `route-picker.ts` instead of the removed loose path. The original `fzf.json` bytes are retained in the private manifest for rollback.

Rollback requires the manifest printed by apply:

```bash
node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/migrate.mjs rollback --manifest /path/to/manifest.json
```

Review every dry-run plan before apply. Do not run migration against a real Pi installation unless that change is explicitly authorized.

## Uninstall

If you installed from the cloned source directory, remove the same package source:

```bash
pi remove ./pi-agent-wave-new-design/extensions/pi-agent-wave
```

After npm publication, remove an npm installation with:

```bash
pi remove npm:@dpugliese/pi-agent-wave
```

Removing pi-agent-wave does not remove Herdr, routing configuration, migration backups, or stored Delegate Graph runs. If a loose-install migration was applied, run rollback first when the original loose files, exact settings, and original pi-fzf configuration should be restored.
