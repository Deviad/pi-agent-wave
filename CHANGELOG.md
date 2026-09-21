# Changelog

All notable changes to `@dpugliese/pi-agent-wave` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/). Each entry names the record that carries its evidence; nothing listed here is verified by this file alone.

**The PRD set was removed on 2026-09-21.** Entries below that name a `tasks/prd-*.md` file refer to documents that are no longer in the tree; their history is in git. The plan of record is now `specification.md` with `product.md` as the product description, and open work orders live in `tasks/handoff-*.md`.

## [Unreleased]

### Fixed

- **A torn-down Herdr attempt no longer wedges a run.** When a `wait` outlived its supervisor (interrupted `op=collect`) and hit `PI_DELEGATE_WAIT_TIMEOUT_MS`, the launcher tore the attempt down (`abort_acpx_attempt`: failure bundle, tab closed, attempt directory and cancel script removed) while the store still said `running`; afterwards `op=collect` re-waited an hour, `op=retry` refused ("still running"), and `op=cancel` failed on the missing launcher. Three changes, each pinned by a test whose removal of the fix was verified to fail it: a Herdr wait fails within seconds when the attempt directory disappears or `herdr agent get` answers `agent_not_found` (`wait_for_settled_agent`, `test/herdr-worker-liveness.test.ts`); `op=collect` settles `failed` from a retained `failure-<operationId>.json` whose attempt directory is gone instead of waiting (`retainedTeardown` in `index.ts`, `test/acpx-collect-convergence.test.ts`); `cancelRegisteredAttempt` treats an absent launcher as an already converged teardown, the rule `abort_acpx_attempt` already stated (`herdr.ts`, `test/acpx-focus-cancellation.test.ts`). Observed on `run_315dce09` 2026-09-20. (`tasks/prd-orphaned-wait-convergence.md`)
- **The liveness probe asks Herdr a question it can answer.** The first cut queried `herdr agent get <agent_name>`, which returns `agent_not_found` for a worker that is alive and `working` in `herdr agent list`; `agent get` resolves pane refs only. Every Herdr worker was therefore torn down at the first probe (`run_daaa5712`, dispatched 07:51:25, aborted 07:51:41 with no worker output). The probe now takes `resource["pane"]`, and `test/herdr-worker-liveness.test.ts` pins the exact argv plus the real CLI shapes for a live pane versus its unresolvable name. (`tasks/prd-orphaned-wait-convergence.md`, story 4)

## [0.2.0] - 2026-09-13

### Added

- **Numbered agent list in the Pi terminal.** When the first worker of a Pi session registers, a list opens above the editor and later workers append with stable session-local numbers, across runs and retries. Enter opens the only running worker; with several running, Enter focuses the list and the up and down arrows choose; typing a number and Enter opens that worker directly. Details show run, node, role, transport, model, task, process state and acceptance, the rendered tail of the live stream, and the retained answer after settlement. Settled and superseded workers fold into one summary line (`s` shows or hides them). `r` refreshes, `q` navigates back and closes, `/graph agents` reopens. Keys reach the list only while the editor is empty, never depend on a Herdr tab still existing, and never focus or cancel a worker on selection. TUI only; absent in headless and ACP modes. (`tasks/prd-default-agent-list.md`, `prd-collapse-settled-rows.md`, `prd-enter-and-arrows.md`)
- **Escape cancels the run's workers, with confirmation.** In the agent list and the follow view, Escape asks to cancel every running worker of the run in view, naming them; Enter confirms, `q` or a second Escape aborts. A confirmed cancellation stops each worker through its structured cancel script, settles confirmed stops as cancelled, and records the run's running operations and the run cancelled in one transaction (`GraphStore.cancelRunningOperations`, `cancelRunWorkers`). A worker whose stop cannot be confirmed is named, never assumed stopped. (`tasks/prd-cancel-run-from-list.md`)
- **Decision brief in `op=collect`.** The collect result now carries the retained answer (bounded to 16 KiB), its final `VERDICT:` line, a template of the `op=decide` call for the node (verdict for review, test, audit and source_search; `payload.slices` for thinkers) and a note naming the next step, so the supervisor never has to find the answer on disk.
- **`/graph status --follow <runId>`** and `/graph status <runId> --follow` as aliases of `/graph watch <runId> --follow`; bare status stays a one-shot notification.
- **Real terminal end-to-end harness.** `e2e/default_agent_list_harness.py` drives a real Pi TUI inside an isolated named Herdr session sized through tmux, with a scripted zero-cost provider as the supervisor (`test/support/fake-supervisor-provider.ts`), the fake acpx fixture as the worker (`test/support/acpx-shim/`), and a fixture `HOME` so routing and credentials are deterministic. `e2e/tests/test_us008_default_agent_list.py` walks registration, append across runs, selection by Enter, arrows and number, details after the worker's Herdr tab is gone, a collected attempt, the settled fold, close and reopen, the follow view, and the confirmed cancellation, and verifies teardown against the operator's default Herdr session.
- **`claude-code` provider** (`claude-code-auth.ts`): streams Anthropic messages with the Claude Code request headers and metadata, keeps the header version current through `/claude-headers`, and surfaces API refusals and stop reasons with their server details.
- **Runtime-owned result capture foundation** (`lib/runtime-*.ts`, `scripts/runtime-settle.ts`): worker output, retained content, staging manifests and an integration journal are captured by the runtime rather than by worker-authored report files. Slice 1 of that PRD is a foundation and is not yet the public path. (`tasks/prd-runtime-owned-results.md`)
- Offline tests for the credential preflight that gates every Pi worker launch, plus an opt-in live rehearsal behind `PI_RUN_LIVE_PREFLIGHT=1`. (2026-09-10)
- `npm run test:acpx` as a loud entry point for the real ACPX lifecycle matrix: it refuses when the matrix is unconfigured instead of reporting skips as green, and supports `--dry-run`. (2026-09-10)
- Tests pinning owned-path containment for exported worker changes: relative owned paths are absolutized against the attempt workspace and an escaping path is rejected before the delta is read. (2026-09-09)

### Changed

- **Supervisor contract and tool guidance describe the runtime-v1 loop**: next, dispatch, collect, decide, next. The contract no longer instructs `op=record status=completed`, which the tool had stopped accepting; it states the decide fields per node, that thinkers need slices, that coding and operational candidates need `op=integrate` first, that `op=record` exists only for cancellation, and that `op=resolve` applies only to a parked run. `op=decide` refuses retry, defer, abort and escalate with a message naming `op=resolve`. Found from a real session in which both runs stayed at the thinker node.
- **The follow view opens details by number** (Enter, arrows, or typed number) instead of focusing a Herdr tab, so the original `agent_not_found` failure cannot recur there and a number means the same thing in both views. `/graph focus` is the only command that brings a Herdr tab forward. (`tasks/prd-follow-view-details.md`)
- **Escape is the cancel key** in both views; `q` alone navigates back and closes. Keys in both views are matched through pi-tui's `matchesKey` and `parseKey`, so the CSI-u encodings Pi enables are recognised; key release and key repeat events are ignored.
- The production audit's cleanup probe is injectable, so the suite no longer depends on live host state while other tests run AgentFS concurrently; whole-machine semantics of a real audit are unchanged. (2026-09-09)
- Test paths for worker helper scripts and the real-matrix files resolve from `test/support/repoRoot.ts`, so the suite passes identically from the repository root and the package directory. (2026-09-09)
- `production-cleanup-scan.ts` reuses `readCleanup` from `production-audit.ts` instead of its own copy of the process and temp-path patterns. (2026-09-10)

### Removed

- The legacy worker-authored report pipeline: `lib/acpx-settlement.ts`, `lib/acpx-settlement-evidence.ts`, `lib/projected-report.ts`, `scripts/ledger.ts`, `scripts/report-audit.ts`, `scripts/report-prompt.ts`, `scripts/production-review-bundle.ts`, `scripts/agentfs-export.ts` and their tests. Runtime attempts settle through `op=collect` and advance through `op=decide`.
- `classify_launch_failure` and `TRANSIENT_LAUNCH_PATTERNS` in `delegate_core.py`, which had no caller. (2026-09-10)

### Fixed

- A confirmed cancellation could print "aborted; nothing was cancelled" if Escape or `q` arrived while it was in flight, although the cancellation went on to succeed. Keys during an in-flight cancellation now report that it is in progress, the prompt line reads "cancelling", and Enter cannot start a second one.
- One Escape press could open the cancel prompt and immediately abort it: terminals reporting key releases under the kitty keyboard protocol sent a release that still matched Escape. Release events are ignored in both views, as are repeats of Escape, Enter and `q`.
- The agent list consumed digits, `r` and `q` from a command being typed in the editor (`/graph log run_…` arrived as `/gaph log un_…`). Keys reach the views only while the editor is empty.
- Escape fell through to the editor because it arrived as a CSI-u sequence rather than the bare byte the handler compared against.
- The Claude header test failed inside Claude Code, which exports `CLAUDE_CODE_ENTRYPOINT=cli`; the test pins the entrypoint and user-agent variables for its duration.
- The ACPX matrix gate resolved its target under `test/test/` and exited 0 even when its child failed; both are covered by `test/acpx-matrix-gate.test.ts`. (2026-09-10)

### Documentation

- Both READMEs and `AGENTS.md` describe the agent list, the follow view, the cancel key, the fold and the selection model; `AGENTS.md` records where redraw timers are allowed and what the views may mutate.
- PRDs for every story above, each criterion checked against named evidence: default agent list, follow-view details, cancel from the list, collapse settled rows, Enter and arrows.
- Records of the Claude lifecycle investigation (2026-09-10): the rerun passes 2/2 against a fresh credential, credential staleness is ruled out as the cause of the September failures, the credential chain is written down, and the failover verification scope is recorded as a decision with three options rather than built. (`tasks/prd-failover-verification-scope.md`, `agent-output/`)

## [0.1.0] - 2026-09-08

Initial package: the Delegate Graph tool and commands, ACPX and AgentFS worker execution over the headless and Herdr transports, model routing with frozen per-role policies, retry and failover classification, settlement convergence, and the production audit gates. See `tasks/prd-package-delegate-graph.md` and the records it links.

[0.2.0]: https://github.com/Deviad/pi-agent-wave/compare/b1d7572...HEAD
[0.1.0]: https://github.com/Deviad/pi-agent-wave/commits/b1d7572
