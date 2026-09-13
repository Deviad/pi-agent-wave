# pi-agent-wave development contract

This repository develops `@dpugliese/pi-agent-wave`, a Pi package whose source lives in `extensions/pi-agent-wave/`. Every agent or person working here follows this file.

## Plan of record

`tasks/prd-package-delegate-graph.md` is the canonical issue and scope record. `tasks/prd-runtime-owned-results.md` governs the `runtime-v1` result contract, and `tasks/prd-air-controlled-editor-independent-orchestration.md` governs the transport-neutral Air/headless work. Before changing behavior, architecture, approach, or acceptance criteria, update the governing PRD first, then implement only what it records. A documentation or maintenance edit the user asked for explicitly needs no separate issue.

## Product invariants

Public surface:

- Keep the `/delegate`, `/graph`, `/failover`, `delegate_graph`, and `questionnaire` contracts.
- Keep graph topology, joins, retry budgets, evidence gates, and model-policy behavior unless a PRD changes them.
- Package exactly the graph extension plus the `questionnaire`, `cmux-session`, `model-failover`, and `claude-code-auth` entry points. The Claude auth provider is adapted from upstream MIT source; preserve its license in `lib/claude-auth-LICENSE` and maintain integration documentation in this package’s READMEs. Its pinned core and SDK are declared runtime dependencies. Herdr executables, Herdr-managed files, credentials, databases, and generated evidence never enter the npm artifact.

Result contracts:

- `runtime-v1` is the only result contract; `legacy-v1` (worker-authored JSON reports, `op=record` settlement, the file ledger, report repair, owned-path export) was removed on 2026-09-12 and must not be reintroduced. Operations runs settle operational candidates: answer, staged owned artifacts, observed checkpoint; placement through the journal without Git checks. There is no adapter enablement gate: schema v11 dropped `runtime_adapters` and `/graph enable-adapter` on 2026-09-12; a worker runs on the adapter its frozen model selects, and provider exhaustion is the frozen chain's job (`retry.ts` transient classification, three transient attempts, then `awaiting_user`). Do not reintroduce a per-adapter switch.
- Runtime answers for `review`, `test`, `audit` and `source_search` end with one `VERDICT: <value>` line; `op=decide` takes the value the caller reads there.
- Claude's attempt copies of `settings.json` and `.claude.json` are tolerated self-writes: still a regular mode-600 JSON object, every change recorded as `configurationSelfWrites`, never a boundary failure. Every other snapshot keeps exact bytes. Codex is proven on the research, build and operations graphs with its terminal present (graph dispatch never passes `--no-terminal`); without a terminal it has no file access, which only the evidence-only review gate removes. Codex's own `sandbox-exec` can be refused inside the AgentFS overlay; a worker then reports a verification blocker and the graph recovers through its verdict edge, so an extra implement/review/test cycle is an observed cost, not a defect. A dispatch resource carries no legacy export configuration: settlement passes the AgentFS snapshot path straight into `runtime-settle.json`, and the lifecycle proof settles a real owned write through `agentfs run` from the resource `prepare_acpx_attempt` builds.
- Runtime attempts settle only through `op=collect`, which records facts: process outcome, retained candidate, observed session identity. Retention precedes session close, provider verification, and cleanup; a failure after retention is reported, never used to discard a candidate.
- Runtime attempts advance only through `op=decide` with a reason. A `failed` or `interrupted` attempt is replaced only through `op=retry` (or the operator's `op=resolve decision=retry` / `/graph resume`), which supersedes the attempt and mints the next frozen identity. `op=record` exists only for cancellation; `defer`, `abort` and `escalate` are graph transitions, and an escalated run can be resumed by the operator. Settlement evidence is published atomically (temporary file, fsync, exclusive link) and never rewritten. `/graph ledger` is derived output and is consulted by no gate. `/graph watch` and `op=watch` are likewise read-only: they render the tail of a running worker's retained ACPX stream and never decide, settle or retry anything; the worker's pane shows the same rendering (`lib/acpx-render.ts`) while the JSON stream goes only to the capture files. `/graph watch --follow` and the numbered agent list (`agent-list.ts`) are the only places a redraw timer is allowed: it runs only while the widget is open and something listed is running, stops on `q`, and one interactive view replaces the other. The agent list opens by itself when a worker registers in a TUI session (`runtime_attempt_registered`, after the registration succeeded), appends later attempts with session-local numbers that are never persisted, opens details by number plus Enter without any Herdr focus command, cancels a run's running workers only through Escape followed by an explicit Enter on a confirmation that names them (`cancelRunWorkers`: each process is stopped through its structured cancel script, its attempt settled cancelled, then the run's running operations and the run are recorded cancelled in one transaction; an unconfirmed stop is named, never assumed), reads keys only while the editor is empty, and is absent in headless and ACP modes.
- A positive semantic verdict never originates from an exit code. An attempt that exits without a candidate (empty or incomplete capture) is a transient `worker-empty-answer` failure replaced through `op=retry`, and its raw stream is retained for diagnosis.

Workers and credentials:

- Worker execution is transport-neutral and ACPX-only. Headless must load with ACPX and AgentFS alone; Herdr is an optional presentation adapter selected only with complete executable and workspace identity.
- The credential preflight checks the store of the agent that will execute the model, never another agent's store. `agent_for_model()` in `scripts/delegate_core.py`, `agentForModel()` in `scripts/doctor.mjs`, and `selectAcpAgent()` in `lib/acpx-select.ts` must agree, and a test pins all three.
- The live `~/.pi/agent/auth.json` is never linked into an attempt. Credentials are preflighted with `pi auth check --no-refresh` and materialized as a mode-600 file for the selected provider only.
- Transient failures (429/5xx, quota, timeout, connection loss, `ACPX worker failed`, provider-link churn, audit or snapshot errors, exit without a candidate) spend the three-attempt same-model budget, then advance along the frozen chain. Semantic verdicts never trigger failover, denied authorizations are permanent, and exact-model locks never advance. `op=retry` is the only path that applies this classification.
- The frozen route's `thinking` level is written into the worker's private Pi settings as `defaultThinkingLevel` at dispatch; the supervisor's own default is only the fallback. Ignored overlay paths default to `.git/index` in both the launcher and the staging library, and the two defaults must stay identical. An operational command's `checkpoint` must lie under one of its owned paths; its `cwd` must be the worker's working directory, and the instruction to the worker names it as `.`.
- Known open hazard: inside `agentfs run` on this host, a process that changes into an absolute host path writes to the host outside the overlay, invisible to the audit. Never put absolute host paths into a worker's task or instruction, and do not treat a host file that has no overlay change as audited work; settlement refuses a declared checkpoint in that state.
- A terminated attempt always settles: `op=collect` records the failure and names the retained diagnostic instead of leaving the operation running.
- User notification is in-session only (`ctx.ui.notify`). Never spawn modal dialogs, speech, or sounds; a headless gate must never block on a desktop prompt.

History:

- Do not recreate the legacy loose-install source directory; only migration code and its tests may name it.
- Do not restore retired orchestration instructions, environment aliases, fixed-role pane layouts, or generated workflow artifacts.

## Source ownership

| Path | Contents |
| --- | --- |
| `extensions/pi-agent-wave/*.ts` | Extension entry points, `GraphStore`, retry classification, route picker |
| `extensions/pi-agent-wave/lib/` | Package-private portable helpers: ACPX identity, events and stream rendering, runtime capture, process, output, content, staging, integration, results, AgentFS audit, worker transport |
| `extensions/pi-agent-wave/scripts/` | Transport-neutral worker lifecycle (Python), headless and Herdr adapters, the ACPX worker, runtime settlement, cancellation, policy resolution, route picker, init, doctor, migration, production audit and scans |
| `extensions/pi-agent-wave/test/` | All automated verification; `test/support/` holds the fake ACPX, lifecycle and cleanup drivers, the live probe, the measurement driver, and the test-only AgentFS export harness (`agentfs-export.ts`, never shipped) |
| `extensions/pi-agent-wave/README.md` | User-facing installation, configuration, and operations reference |
| `README.md` | Product overview and the install, Air, run, and uninstall journey |
| `tasks/` | PRDs and acceptance records |
| `agent-output/` | Generated evidence only; never packaged, never a substitute for a fresh run |

When parallel workers are used, assign every writable path to exactly one worker; every other path is read-only to it.

## Implementation rules

- Take a restore point before editing: the current commit covers clean tracked files; copy untracked or already-dirty files before touching them.
- Make surgical changes in the surrounding TypeScript, JavaScript, or Python style.
- Prefer types that make invalid states unconstructible. No `any`, casts, or ignore directives to silence a valid type error.
- Comments state usage or constraints the code cannot express. Remove or update stale comments in the same change.
- Keep callers, declarations, tests, both READMEs, package metadata, and migrations synchronized in one change.
- Shipped code uses package-relative imports, the declared Pi peer packages, or explicitly declared runtime dependencies. Never add `/Users/...`, Homebrew, npm-cache, or package-root escape imports.
- Configurable paths come from `PI_CODING_AGENT_DIR`, `PI_MODEL_ROUTING`, and `PI_MODEL_CATALOG`. Tests use temporary agent directories.
- Schema changes are migrations with seeded tests for every earlier version; historical rows must survive byte-for-byte. Additive changes use `ensureColumn`; a change SQLite cannot make in place (dropping a constrained column, a unique constraint) rebuilds the table the way v8 and v10 do: foreign keys off, one immediate transaction re-checked under the lock, dependent triggers dropped first and recreated after, copy, drop, rename, index recreation, `PRAGMA foreign_key_check` before commit. Repairs that run on every open (the v6 pattern) must be gated below the version that removed what they create.

## Tests and proof

Write a focused failing test before a behavioral change, then make it pass. Use real reachable dependencies: temporary Pi homes, temporary Git repositories, real SQLite, and real AgentFS where the host permits. Fixtures never stand in for installed Pi versions, npm, Git, SQLite, or the package loader. Literal ACP event inputs prove parser behavior only, never adapter compatibility.

Completion gate, from the repository root:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts
git diff --check
```

Package-focused Bun checks (single files only; Bun cannot run the whole directory because the matrix imports `node:sqlite`):

```bash
bun test \
  extensions/pi-agent-wave/test/package-manifest.test.ts \
  extensions/pi-agent-wave/test/package-portability.test.ts \
  extensions/pi-agent-wave/test/package-artifact.test.ts \
  extensions/pi-agent-wave/test/package-docs.test.ts \
  extensions/pi-agent-wave/test/package-migration.test.ts \
  extensions/pi-agent-wave/test/questionnaire.test.ts \
  extensions/pi-agent-wave/test/cmux-session.test.ts \
  extensions/pi-agent-wave/test/model-failover.test.ts
```

Node-only installation rehearsal:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/package-install-rehearsal.test.ts
```

Package checks, from `extensions/pi-agent-wave/`:

```bash
npm run typecheck
npm pack --dry-run --json --ignore-scripts
npm publish --dry-run --json --ignore-scripts
```

Live checks spend provider credits and need explicit user authorization each time:

```bash
cd extensions/pi-agent-wave
PI_CLAUDE_OAUTH_TOKEN_FILE=~/.config/pi/acpx-claude-token.txt npm run test:acpx
npm run test:acpx -- --dry-run
python3 test/support/runtime-result-probe.py --dry-run
python3 test/support/runtime-result-probe.py --preflight
python3 test/support/runtime-result-probe.py --agents claude --dry-run
node --experimental-strip-types test/support/runtime-measure.ts --preflight
node --experimental-strip-types test/support/runtime-measure.ts --graph build --dry-run
node --experimental-strip-types test/support/runtime-measure.ts --graph operations --dry-run
```

The measurement driver is the standard live proof for a launcher or worker change: one research run with `--execute --repeats 1` proves the end-to-end path in about five minutes and samples `op=watch` while workers run. The Claude token file expires within hours; refresh it from the Keychain item `Claude Code-credentials` before a Claude run.

Evidence layout under `agent-output/` (private, never packaged): `runtime-result-probe-run{1,2,3,4}-20260912/` are the adapter probes cited as adapter evidence by the PRD; `runtime-measure-20260912*/`, `runtime-measure-build-20260912*/`, `runtime-measure-operations-20260912-smoke*/`, `runtime-measure-post-removal-20260912/` and `runtime-measure-watch-20260912/` are measurement runs; `runtime-completion-20260912/` holds the gate logs named after each increment. The PRDs cite these paths; a new increment adds its own log there and cites it.

Runtime storage while developing: the graph database defaults to `~/.cache/delegate-graph/delegate-graph.db` with `runtime-content/` and `failures/` beside it; tests and drivers must set `DELEGATE_GRAPH_DB` to a temporary path before initializing a run. Private run directories are `/tmp/delegate-graph-herdr-<run>-<operation>.*`.

`test/acpx-real-matrix.test.ts` sits in the completion glob but skips unless `RUN_REAL_ACPX_MATRIX=1` and a `PI_CLAUDE_OAUTH_TOKEN_FILE` are present; the `test:acpx` guard refuses rather than reporting skips as passes.

Current Claude stop-reason gate (2026-09-13): 497 Node tests, 459 passed, 27 failed, 11 opt-in skips; preceding auth-integration Bun 46/46 and 75 packed files. Full acceptance is blocked on the restricted host (AgentFS/loopback/process inspection and installation rehearsal); see the auth increment in the package PRD and `agent-output/claude-auth-integration-20260913/`. The preceding recorded increment had 486 tests, 475 passed, 0 failed and 11 skips. Never weaken an assertion to turn a proof green. When a host prerequisite blocks a criterion, record the blocker and the fresh counts in the governing PRD. Report counts, skips, failures, and the source revision from the run you made, not from an earlier log.

## System safety

- Migration and initialization default to dry-run. Never run `apply` against the real Pi installation without explicit authorization.
- Migration tests use temporary `PI_CODING_AGENT_DIR` trees, preserve `herdr-agent-state.ts`, repair stale pi-fzf commands, validate private backup permissions, reject path-tampered manifests, and prove byte-exact settings and `fzf.json` rollback.
- Installation rehearsals may reach npm and temporary loopback Git only. They never dispatch workers.
- Development verification never modifies the real `~/.pi/agent/extensions/`, Pi settings, credentials, model routing, databases, or caches.
- Never `npm publish`, create or push a public repository, commit, push, merge, or apply a real migration unless the user explicitly asks.

## Documentation and release hygiene

- A user-facing behavior change updates `extensions/pi-agent-wave/README.md`; a workflow change updates this file and the root `README.md`.
- Compatibility claims are limited to versions proven by the real installation rehearsal.
- Do not invent `repository`, `homepage`, or `bugs` metadata.
- Do not commit `node_modules/`, tarballs, temporary files, caches, or generated installation trees.
- Before reporting completion, verify the observable files, run the relevant checks, and state partial completion plainly.

## Claude provider maintenance

The supervisor auth provider is vendored from `@cgaravitoq/pi-claude-code-auth` 2.2.2; maintain its entry point and `lib/claude-auth-*` helpers here, preserve the upstream license, and write package-specific documentation rather than copying the upstream README. Credential logic remains in the pinned core dependency. Loading the extension must not read credentials or refresh tokens. Graph workers retain their ACPX adapter selection.

`/claude-headers update` is an explicit operator command that queries `claude --version` and saves `$PI_CODING_AGENT_DIR/claude-code-headers.json` atomically with mode 600. Requests use the saved version for both HTTP and billing metadata, with upstream environment overrides taking precedence. Do not infer new beta flags from a CLI version. Tests use temporary agent directories and synthetic request tokens; they never invoke login, refresh, or paid model calls. Test failures must not print environment dictionaries or credentials.
