# pi-agent-wave development contract

This repository develops `@dpugliese/pi-agent-wave`, a Pi package whose source lives in `extensions/pi-agent-wave/`. Every agent or person working here follows this file.

## Plan of record

`specification.md` is the technical plan of record and `product.md` is the product record; together they replace the PRD set that was removed on 2026-09-21, whose history is in git. Open work orders live in `tasks/handoff-*.md`, and the PRD names still used elsewhere in this file refer to those removed documents. Before changing behavior, architecture, approach, or acceptance criteria, update the document that records it first, then implement only what it records. A documentation or maintenance edit the user asked for explicitly needs no separate issue.

## Product invariants

Public surface:

- Keep the `/delegate`, `/graph`, `/failover`, `delegate_graph`, and `questionnaire` contracts.
- Keep graph topology, joins, retry budgets, evidence gates, and model-policy behavior unless the plan of record changes them.
- Package exactly the graph extension plus the `questionnaire`, `cmux-session`, `model-failover`, and `claude-code-auth` entry points. The Claude auth provider is adapted from upstream MIT source; preserve its license in `lib/claude-auth-LICENSE` and maintain integration documentation in this package’s READMEs. Its pinned core and SDK are declared runtime dependencies. Herdr executables, Herdr-managed files, credentials, databases, and generated evidence never enter the npm artifact.

Result contracts:

- `runtime-v1` is the only result contract; `legacy-v1` (worker-authored JSON reports, `op=record` settlement, the file ledger, report repair, owned-path export) was removed on 2026-09-12 and must not be reintroduced. Operations runs settle operational candidates: answer, staged owned artifacts, observed checkpoint; placement through the journal without Git checks. There is no adapter enablement gate: schema v11 dropped `runtime_adapters` and `/graph enable-adapter` on 2026-09-12; a worker runs on the adapter its frozen model selects, and provider exhaustion is the frozen chain's job (`retry.ts` transient classification, three transient attempts, then `awaiting_user`). Do not reintroduce a per-adapter switch.
- Runtime answers for `review`, `test`, `audit` and `source_search` end with one `VERDICT: <value>` line (`RUNTIME_VERDICT_NODES` in `scripts/delegate_core.py`, mirrored by `VERDICT_NODES` in `index.ts`); `op=decide` takes the value the caller reads there. On the operations graph `thinker_synthesize` advances only with `verdict=DONE`, which the supervisor supplies; no VERDICT line is asked of a thinker, and the `op=collect` decision brief says so.
- Claude's attempt copies of `settings.json` and `.claude.json` are tolerated self-writes: still a regular mode-600 JSON object, every change recorded as `configurationSelfWrites`, never a boundary failure. Every other snapshot keeps exact bytes. Codex is proven on the research, build and operations graphs with its terminal present (graph dispatch never passes `--no-terminal`); without a terminal it has no file access, which only the evidence-only review gate removes. Codex's own `sandbox-exec` can be refused inside the AgentFS overlay; a worker then reports a verification blocker and the graph recovers through its verdict edge, so an extra implement/review/test cycle is an observed cost, not a defect. A dispatch resource carries no legacy export configuration: settlement passes the AgentFS snapshot path straight into `runtime-settle.json`, and the lifecycle proof settles a real owned write through `agentfs run` from the resource `prepare_acpx_attempt` builds.
- Runtime attempts settle only through `op=collect`, which records facts: process outcome, retained candidate, observed session identity. Retention precedes session close, provider verification, and cleanup; a failure after retention is reported, never used to discard a candidate.
- Runtime attempts advance only through `op=decide` with a reason. A `failed` or `interrupted` attempt is replaced only through `op=retry` (or the operator's `op=resolve decision=retry` / `/graph resume`), which supersedes the attempt and mints the next frozen identity. `op=record` is refused by the tool with a pointer to `op=cancel`, the only cancellation path (it stops the worker, then records the operation cancelled through the store's single remaining record transition); `defer`, `abort` and `escalate` are graph transitions, and an escalated run can be resumed by the operator. Settlement evidence is published atomically (temporary file, fsync, exclusive link) and never rewritten. `/graph ledger` is derived output and is consulted by no gate. `/graph watch` and `op=watch` are likewise read-only: they render the tail of a running worker's retained ACPX stream and never decide, settle or retry anything; the worker's pane shows the same rendering (`lib/acpx-render.ts`) while the JSON stream goes only to the capture files. `/graph watch --follow` and the numbered agent list (`agent-list.ts`) are the only places a redraw timer is allowed: it runs only while the widget is open and something listed is running, stops on `q`, and one interactive view replaces the other. The agent list opens by itself when a worker registers in a TUI session (`runtime_attempt_registered`, after the registration succeeded), appends later attempts with session-local numbers that are never persisted, opens details by number plus Enter without any Herdr focus command, cancels a run's running workers only through Escape followed by an explicit Enter on a confirmation that names them (`cancelRunWorkers`: each process is stopped through its structured cancel script, its attempt settled cancelled, then the run's running operations and the run are recorded cancelled in one transaction; an unconfirmed stop is named, never assumed), reads keys only while the editor is empty, and is absent in headless and ACP modes.
- A positive semantic verdict never originates from an exit code. An attempt that exits without a candidate (empty or incomplete capture) is a transient `worker-empty-answer` failure replaced through `op=retry`, and its raw stream is retained for diagnosis.

Workers and credentials:

- Worker execution is transport-neutral and ACPX-only. Headless must load with ACPX and AgentFS alone; Herdr is an optional presentation adapter selected only with complete executable and workspace identity.
- The credential preflight checks the store of the agent that will execute the model, never another agent's store. `agent_for_model()` in `scripts/delegate_core.py`, `agentForModel()` in `scripts/doctor.mjs`, and `selectAcpAgent()` in `lib/acpx-select.ts` must agree, and a test pins all three.
- The live `~/.pi/agent/auth.json` is never linked into an attempt. Credentials are preflighted with `pi auth check --no-refresh` and materialized as a mode-600 file for the selected provider only.
- Transient failures (429/5xx, quota, timeout, connection loss, `ACPX worker failed`, provider-link churn, audit or snapshot errors, exit without a candidate, a worker gone before its result on either transport or found orphaned at `collect`, an ACP session that could not be opened) spend the three-attempt same-model budget, then advance along the frozen chain. Semantic verdicts never trigger failover, denied authorizations are permanent, and exact-model locks never advance. `op=retry` is the only path that applies this classification.
- The frozen route's `thinking` level is written into the worker's private Pi settings as `defaultThinkingLevel` at dispatch; the supervisor's own default is only the fallback. Ignored overlay paths default to `.git/index` in both the launcher and the staging library, and the two defaults must stay identical. An operational command's `checkpoint` must lie under one of its owned paths; its `cwd` must be the worker's working directory, and the instruction to the worker names it as `.`.
- Known open hazard: inside `agentfs run` on this host, a process that changes into an absolute host path writes to the host outside the overlay, invisible to the audit. Not reproduced on 2026-10-03 for a workspace under `$HOME` (an absolute write into the workspace, with or without `cd`, was refused); presumably still live for a workspace under `/tmp`, which the sandbox passes through, though that is inferred, not exercised. Never put absolute host paths into a worker's task or instruction, and do not treat a host file that has no overlay change as audited work; settlement refuses a declared checkpoint in that state. Declared ownership is now enforced at dispatch as well: `op=dispatch` resolves every owned path against the working directory and refuses an escaping or whole-base entry with a `[dispatch_precondition]` message before `init`, so a slice that could only fail at staging never launches a worker. The containment rule has one implementation, `lib/agentfs-sandbox.ts:ownedRelativePaths`, shared by the precondition and the audit.
- Known open hazard, verified 2026-10-03 with `agentfs v0.6.4`: the sandbox confines only writes relative to the working directory. Writes to `/tmp`, `/private/tmp` and `/var/folders/<user>/T/` land on the host unaudited whatever `TMPDIR` says, and every host file is readable, including the graph database and `~/.pi/agent/auth.json`; `agentfs run` has no option that denies either. Never tell a worker to put scratch in `/tmp` as if it were sandboxed, and treat anything a worker reads as reachable by injected content. Details and the open decision: `tasks/handoff-durable-worker-record.md` §7 question 5.
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
| `tasks/` | Open work orders (`handoff-*.md`) and design notes; the plan of record is `specification.md` with `product.md` |
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

Evidence layout under `agent-output/` (private, never packaged): `runtime-result-probe-run{1,2,3,4}-20260912/` are the adapter probes cited as adapter evidence by the PRD; `runtime-measure-20260912*/`, `runtime-measure-build-20260912*/`, `runtime-measure-operations-20260912-smoke*/`, `runtime-measure-post-removal-20260912/` and `runtime-measure-watch-20260912/` are measurement runs; `runtime-completion-20260912/` holds the gate logs named after each increment. The PRDs cite these paths; a new increment adds its own log there and cites it. `live-delegation-write-slice-20260920/` holds the live proof that a settled operation removes its run directory while `collect` retains its records; reproduce it with `runtime-measure.ts --graph research --execute --repeats 1 --keep-run-root`, which spends provider credit and needs explicit authorization.

Runtime storage: the graph database defaults to `~/.local/share/delegate-graph/delegate-graph.db` with `runtime-content/` and `failures/` beside it; tests and drivers must set `DELEGATE_GRAPH_DB` to a temporary path before initializing a run. The home is durable rather than a cache directory because the store is the single source of truth for a story's execution record while `prune` cascades. Schema v12 puts that record in `ledger_entries`, `ledger_claims` and `ledger_aggregates`, and v13 adds `runs.workspace_root` for home runs (`tasks/handoff-home-workspace-mode.md`); those tables hold no foreign key to `runs`, so `prune` deletes a settled run and never its record, and a recorded aggregate is recomputed from its components when a story is read. `CURRENT_SCHEMA_VERSION` in `store.ts` is the version the build migrates to and `migrate()` refuses a store that stops short of it, so tests pin that constant rather than a version literal. Private run directories are `<graph home>/runs/delegate-graph-herdr-<run>-<operation>.*` (moved out of `/tmp` on 2026-10-04 so a reboot cannot erase an unsettled attempt; `/tmp` run directories from earlier versions are still accepted), one per operation, and are removed once that operation settles: the store retains settlement evidence, cleanup evidence, the capture stream and any failure bundle under `<graph home>/evidence/<runId>/` before the removal, so a path named at settle time resolves at settle time. That guarantee is bounded by retention: `/graph prune` reclaims `evidence/<runId>/`, `failures/<runId>/` and the run's transient directories along with the run, so an outcome recorded months ago names a path that has since been reclaimed. The story's ledger entries are unaffected, which is what carries the record past the evidence. `init` runs before the launch, so a dispatch that never registers a worker removes the directory it created: a preflight block, a start failure, or a throw while writing the task each discard it, because no `collect` will ever reach those operations and nothing else could reclaim them. A `collect` that throws leaves its directory in place until its run is pruned, which is the case where a directory outlives its operation; the run must reach a terminal state before prune can reach it.

`test/acpx-real-matrix.test.ts` sits in the completion glob but skips unless `RUN_REAL_ACPX_MATRIX=1` and a `PI_CLAUDE_OAUTH_TOKEN_FILE` are present; the `test:acpx` guard refuses rather than reporting skips as passes.

Current gate (2026-09-20, after the live-stream and ledger-retirement work, its review fixes, US-006 wiring the headless live view to the published stream, and three authorized live measurements): 582 Node tests, 571 passed, 0 failed, 11 opt-in skips; typecheck and `git diff --check` clean; Bun package checks 46/46; 80 packed files (re-measured 2026-09-20; the earlier 79 was the count of files the package's `files` patterns select and omitted `package.json`, which npm always adds - the patterns select 75 at `main`, this branch adds `lib/live-stream.ts`, `lib/pane-read.ts`, `scripts/story-ledger.mjs` and `scripts/stream_endpoint.py`, and npm's own count is the 80); installation rehearsal 1/1 (recorded before US-006, which adds no packaged manifest entry). Live runs, all terminal with 0 failures: headless at `e0d9575` (156150 ms, opened the finding that `op=watch` sampled 0 activity for headless workers), headless after US-006 (211752 ms, 10 of 10 agent rows carrying activity, evidence `agent-output/runtime-measure-2026-09-20-headless-liveview/`), and Herdr via the driver's new `--transport herdr` (164725 ms, 4 of 4 view-vs-pane lines matching byte-exactly, evidence `/tmp/dg-herdr-proof-evidence/`). A cleanup pass the operator asked for removed 91 stale `/tmp/delegate-graph-*` run directories, 9 leftover Delegate Graph worker tabs, and this increment's own 21 orphaned supervisor processes and 22 scratch directories; the issue-first contract's process-leak fix is that the drivers now stop their supervisor's process group and the tests remove the driver's scratch root, so repeated suite runs leave 0 orphans and 0 scratch. The Herdr run opened an OPEN, pre-existing High finding this increment does not fix: a happily settled Herdr worker's tab is never closed before the cleanup absence audit that requires it absent, so every such settlement reports a post-settlement failure and leaves its tab open; verified unchanged at `e7528b3`. The measurement driver also hides it, because it records collect errors and capture retention only, never `postSettlementFailures`. Live research run (research graph, 1 repeat, alibaba/qwen3.8-flash, headless): exit 0, terminal, 156150 ms, 4 dispatches, 4 completions, 0 retries, 0 fallbacks, 0 failures; evidence `agent-output/runtime-measure-2026-09-20/`, run root `/tmp/pi-wave-measure-runtime-v1-Zm2a74`. That run also opened a High finding this file's increment does not close: `op=watch` samples 0 activity for headless workers (6 samples, 0 with `lastActivity`), where earlier headless runs sampled 30/30 and 12/12, because the US-003 endpoint has no in-product consumer yet. See the PRD's sections 3c and 3d. The preceding recorded increment (2026-09-13, after the agent list, cancel and contract work) had 521 Node tests, 510 passed, 0 failed, 11 opt-in skips. The Claude stop-reason increment earlier that day recorded 497 Node tests, 459 passed, 27 failed, 11 opt-in skips; preceding auth-integration Bun 46/46 and 75 packed files. Full acceptance is blocked on the restricted host (AgentFS/loopback/process inspection and installation rehearsal); see the auth increment in the package PRD and `agent-output/claude-auth-integration-20260913/`. The preceding recorded increment had 486 tests, 475 passed, 0 failed and 11 skips. Never weaken an assertion to turn a proof green. When a host prerequisite blocks a criterion, record the blocker and the fresh counts in the governing PRD. Report counts, skips, failures, and the source revision from the run you made, not from an earlier log.

Increment in progress (2026-09-20, US-007 and US-008 of the live-worker-stream PRD). US-007: a settled Herdr worker's tab is closed after its ACPX session closes and before the cleanup absence audit, a close that fails is recorded beside the audit's own failure, and the measurement driver records each collect's `postSettlementFailures` under a `post-settle` column. US-008: the supervisor's drain reads whatever is available rather than waiting for a line ending, so output with no newline reaches both the capture file and the live channel as the worker writes it, and the channel's window is bounded in bytes as well as entries. Automated gate on this tree: 584 Node tests, 573 passed, 0 failed, 11 opt-in skips; `npm run typecheck` and `git diff --check` clean; Bun package checks 46/46. Neither change adds a packed entry: `test/` is not in the package `files` list, so the new `test/support/herdr-shim/herdr`, `test/support/herdr-settle-mutation-proof.sh` and `test/support/partial-line-driver.py` do not ship, and `headless_supervisor.py` and `stream_endpoint.py` were already packed. Both changes are proven by mutation as well as by the gate: reverting the settled-tab close fails the Herdr lifecycle case, and reverting the drain to `readline` fails the new endpoint case on its first assertion. The live `--transport herdr` re-proof of US-007 ran as an authorized mutation pair, driven by `test/support/herdr-settle-mutation-proof.sh`: with the close reverted the run reported 4 post-settlement failures and retained 4 settlement records with 0 cleanup records while `herdr tab list` still held the 4 tabs of its run; with the close restored it reported 0, retained 4 cleanup records beside its 4 settlements, and left no tab. Evidence `agent-output/runtime-measure-2026-09-20-herdr-defect/` and `agent-output/runtime-measure-2026-09-20-herdr-fixed/`. The four tabs the reverted phase left were closed, both run roots were removed after their records were copied, and `delegate_core.py` was restored byte-for-byte from a verified copy. Both user stories are fully checked in the PRD; the live evidence is section 3f there and the drain's gate is section 3g.

Air rehearsal rerun (2026-09-20, on the installed Air `262.834.44`, Pi `0.85.1`, `pi-acp` `0.0.31`, ACPX `0.13.2`, AgentFS `0.6.4`): the maintainer typed the prompts in their own Air window while the automation staged a temporary ACP agent entry (temp Pi home, temp graph, routing frozen to `alibaba/deepseek-v4.1-flash`), captured evidence and restored the config. Coverage: a research run to terminal with three dispatched workers, a mid-flight cancellation, a recovery through `retry` x3 -> `retry_exhausted` -> operator `op=resolve decision=abort`, a build run to `review PASS` -> `test GREEN` -> `audit PASS` with both implement operations integrated and the integrated workspace passing `test_widget.py`, and a second Air task (agent session `94256513`) reading the first task's run. Every fact is read from the run's graph, retained with the screenshots under `agent-output/air-headless-orchestration/air-e2e-artifacts/v3-20260920/`; `air-e2e.json` and `air-e2e-transcript.jsonl` were regenerated from it and `e2e/tests/test_us007_air_headless_control.py` passes on the fresh file, including the screenshots the 2026-09-01 drive never persisted. `acp.json` was restored byte-for-byte (`669833efe8c94e223000ee2bbe3abec2ddf14cf3850b10c6a267e2d14e1a91b7`), the temporary Pi home removed, and no process referencing the fixture survived. Three findings are recorded in the Air PRD's US-007 section and not fixed: credential-preflight failures are transient so a run whose only model cannot authenticate stays active across the backoff budget (`retry.ts:28` against `retry.ts:67`); an operation that was never dispatched has no collect path, leaving `op=cancel` as its only disposal (`index.ts:992`, `index.ts:1046`); and a cancelled or superseded attempt's private run directory outlives the operation because the removal lives in `collect`.


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
