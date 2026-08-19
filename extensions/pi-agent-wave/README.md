# pi-agent-wave

`@dpugliese/pi-agent-wave` packages Delegate Graph and its approved Pi companions: questionnaire, cmux session metadata, and native model failover.

## Security

Pi extensions execute with full system access. Review the source before installation, especially migration and transport scripts.

## Requirements and compatibility

- Pi `0.84.1` or `0.84.2`.
- Herdr is recommended for observable workers and remains an external prerequisite; it is not bundled.
- When Herdr is unavailable, Delegate Graph uses its visible panel transport fallback.

| Pi version | Status |
| --- | --- |
| `0.84.1` | Tested |
| `0.84.2` | Tested |

No compatibility is claimed outside this matrix.

## Install

From npm after publication:

```bash
pi install npm:@dpugliese/pi-agent-wave
```

From a Git repository supported by Pi:

```bash
pi install git:<host>/<owner>/<repo>@<ref>
```

Git installation requires a repository URL supplied by the installer; this package does not invent or claim a public repository URL.

## Contents

- `index.ts`: Delegate Graph commands and `delegate_graph` tool.
- `questionnaire.ts`: structured terminal questionnaire tool.
- `cmux-session.ts`: optional cmux session lifecycle metadata hooks.
- `model-failover.ts`: same-tier cross-provider runtime failover companion.
- `scripts/`: Delegate Graph transports, evidence tooling, and migration utility.

Herdr executables, Herdr-managed files, user settings, routing configuration, credentials, databases, and generated ledgers are not packaged.

## Configuration

Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. Route inspection and failover additionally honor:

- `PI_MODEL_ROUTING`: explicit `model-routing.jsonc` path.
- `PI_MODEL_CATALOG`: explicit `models.json` path.

Delegate Graph remains Herdr-first and falls back to a visible panel when Herdr identity is unavailable. The transport sets `PI_FAILOVER_ROUTE`, `PI_FAILOVER_TIER`, `PI_FAILOVER_ROLE`, and `PI_FAILOVER_LOCKED` for delegated workers; interactive sessions should use `/failover` instead of setting those variables manually.

## Quick start

For a new installation:

```bash
pi-agent-wave-init --agent-dir "$PI_CODING_AGENT_DIR"
pi-agent-wave-init apply --agent-dir "$PI_CODING_AGENT_DIR"
pi-agent-wave-doctor --agent-dir "$PI_CODING_AGENT_DIR"
```

The first command is a read-only plan. Review it before running `apply`. Then start Pi and use `/delegate` for graph work or enable `/failover` explicitly for a main interactive session.

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
| `/graph focus <runId> <node-or-agent>` | Focus the registered Herdr worker for a node or agent name. This command is unavailable outside Herdr. |
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
| `init` | `story` and `task`; optional `graph` (`build` or `research`) and `modelPolicy`. Returns the run plus its first pending operation. |
| `next` | `runId`. Returns only operations currently eligible for dispatch, including each frozen route, `modelPolicy`, and `policyDigest`. |
| `record` | `runId`, `operationId`, and `status`, plus status-specific dispatch or result evidence. The extension enforces transitions, joins, retries, and report gates. |
| `status` | `runId`. Returns the durable graph status without changing it. |

For `record` with `status: "running"`, pass the frozen `modelPolicy` and `policyDigest` from `next`, the selected model and zero-based model attempt, an observable transport, and its worker identity. Herdr dispatches require the Herdr agent and tab identifiers; panel dispatches require the pane identifier. A same-model retry uses `retryReason`; a cross-model fallback advances `modelAttempt` and uses `fallbackReason`.

For `status: "completed"`, provide the private JSON `reportPath`; its schema and verdict are audited before the transition is accepted. For `status: "failed"`, provide `error`. Invalid edges, premature joins, exhausted retry budgets, and unevidenced completion fail closed.

Direct initialization supports the full tagged model-policy forms used by the API: `auto`, a named preset, an explicit tier, or an exact model with a reason. `/delegate` intentionally exposes only the six picker policies listed above.

### `questionnaire`

`questionnaire` presents one or more option questions in Pi's terminal UI. Each question supplies an `id`, `prompt`, and option list, with optional `label` and `allowOther`. Use it when an agent needs structured user input; cancellation returns no submitted answer.

`cmux-session.ts` has no user command. When cmux metadata and hooks are present it forwards session, prompt, and stop metadata; otherwise it is a no-op.

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

### Observable worker transport

When complete Herdr workspace identity and the `herdr` executable are available, dispatch uses visible Herdr tabs. Otherwise it uses the visible-panel fallback. Both transports receive the same frozen policy, model identity, role, and runtime failover route. If neither observable transport can be used, delegation fails closed instead of launching a hidden worker.

### Inspecting a live or blocked run

Use `/graph status` for the current state and `/graph log` for recent transitions. For a Herdr-backed run, `/graph focus` brings a registered worker forward; panel-backed runs do not support this focus command. If the graph requests a user decision after route exhaustion, use `/graph resume <runId> <operationId>` only when retrying that stored operation is intended.

### Headless or API-driven delegation

Use `delegate_graph init`, then repeat `next -> record running -> record result` until status is terminal or blocked. Never invent operations or dispatch work not returned by `next`. Preserve the returned policy digest and route on every attempt.

## HTTP 429 failover

Delegate Graph workers automatically inherit their frozen tier, ordered model chain, role, and exact-model lock through either visible transport. When a provider returns HTTP 429, the interrupted operation retries on the first available authenticated model from a different provider later in that same chain.

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

## Installed CLI reference

Only these three package binaries are public administrative commands:

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

The packaged `delegate.ts`, `panel.ts`, `herdr_delegate.py`, `policy-resolver.mjs`, and `route-picker.ts` scripts support extension runtime and pi-fzf integration. They are not installed as general-purpose public binaries.

## Initial configuration

Fresh installations can bootstrap a valid routing file without hand-authoring JSONC.

The initializer defaults to dry-run and only writes when `apply` is explicit:

```bash
# Preview the plan without writing anything
pi-agent-wave-init --agent-dir "$PI_CODING_AGENT_DIR"

# Apply the plan
pi-agent-wave-init apply --agent-dir "$PI_CODING_AGENT_DIR"
```

The initializer reads the existing model catalog at `models.json` (via `--models`, then `PI_MODEL_CATALOG`, then the resolved agent directory) and derives selectable model ids strictly from `providers.<provider>.models[].id`. It never creates provider definitions, credentials, or `models.json`.

### Tier selection

Interactive mode prompts for one model per supported tier and covers all six public tiers plus the optional `local-fast` tier. Non-interactive automation supplies explicit tier flags and must name every required tier:

```bash
pi-agent-wave-init apply --non-interactive \
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
pi-agent-wave-init apply --force --agent-dir "$PI_CODING_AGENT_DIR"
```

Force mode writes a private, content-addressable backup under `migration-backups/pi-agent-wave-init/<id>/` (outside the auto-discovered extension directories) and retains enough data for a byte-exact rollback:

```bash
pi-agent-wave-init rollback --manifest /path/to/migration-backups/pi-agent-wave-init/<id>/manifest.json
```

### Optional pi-fzf integration

When pi-fzf is installed (detected from `settings.json`), the initializer merges `route` and `delegate-model` list/preview commands that target the installed package's `route-picker.ts`, leaving every unrelated command and field unchanged. When pi-fzf is absent the plan reports `skipped` and does not create `fzf.json`.

## Health check

The read-only doctor diagnoses a configuration without changing it:

```bash
pi-agent-wave-doctor --agent-dir "$PI_CODING_AGENT_DIR"
pi-agent-wave-doctor --agent-dir "$PI_CODING_AGENT_DIR" --json
```

It checks agent-directory resolution, catalog readability, routing JSONC parseability, the six required tiers and roles, non-empty model chains, catalog membership, local-model loopback validity, pi-fzf command targets, package entry points, and real `policy-resolver` and `route-picker` execution. It exits nonzero only when a required check fails; an absent pi-fzf is a non-fatal warning. Output redacts credential-bearing provider fields.

## Migration and rollback

The migration utility defaults to dry-run and never changes files unless `apply` is explicit:

```bash
pi-agent-wave-migrate --agent-dir "$PI_CODING_AGENT_DIR"
pi-agent-wave-migrate preflight --agent-dir "$PI_CODING_AGENT_DIR"
pi-agent-wave-migrate apply --agent-dir "$PI_CODING_AGENT_DIR"
```

Apply moves conflicting loose extensions to `migration-backups/pi-agent-wave/`, outside Pi's auto-discovered extension directory, records a manifest, and enables the selected package source in `settings.json`. It also repairs the pi-fzf `route` and `delegate-model` list/preview commands so they execute the installed package’s `route-picker.ts` instead of the removed loose path. The original `fzf.json` bytes are retained in the private manifest for rollback.

Rollback requires the manifest printed by apply:

```bash
pi-agent-wave-migrate rollback --manifest /path/to/manifest.json
```

Review every dry-run plan before apply. Do not run migration against a real Pi installation unless that change is explicitly authorized.

## Uninstall

Remove the npm package registration with:

```bash
pi remove npm:@dpugliese/pi-agent-wave
```

If a loose-install migration was applied, run rollback first when the original loose files, exact settings, and original pi-fzf configuration should be restored.
