# PRD: Default numbered agent list with in-TUI details

Status: implemented 2026-09-13 on branch `issue-worker-export-recovery`, uncommitted; every acceptance criterion below carries its evidence. Latest terminal evidence: `agent-output/default-agent-list/20260913T101932.354771Z-e3f789/` and two later passes. Parent issue: [Package Delegate Graph](prd-package-delegate-graph.md). This supersedes the watch-view requirement that number keys focus Herdr tabs; it does not change explicit `/graph focus` or worker lifecycle contracts.

## Overview

Show the interactive agent list automatically when the first Delegate Graph worker starts in the current Pi TUI session. Append additional workers as they start, with stable numbers. Selecting a number opens that attempt's details inside the TUI rather than trying to focus a Herdr agent.

User clarification: "when an agent starts. additional agents are appended to the list as they are spawned". The user accepts the existing `q` and `r` TUI controls; their use is not a defect.

Reported failure: selecting a worker produced `agent_not_found` for `dg_run-5052_thinker_d9c14f15`. Observed source behavior: `startFollow` calls `focusRegisteredAgent`; `watchRun` filters operation status, not process outcome. Consequently an exited attempt awaiting a decision can still be listed, and selection depends on a Herdr target remaining available. The exact cause of the reported missing Herdr registration has not been independently established.

The current source exposes `/graph watch <runId> --follow`. `/graph status` is presently a one-shot notification and does not parse `--follow` as the user expected.

## Goals

- Display the overview at successful worker registration, not at empty graph creation or failed launch.
- Keep one numbered list, appending subsequent attempts without changing existing numbers or selected detail.
- Make details available for running and settled attempts without a live Herdr target.
- Preserve read-only observation: opening, refreshing, selecting or closing never dispatches, cancels, settles, retries or decides work. (Amended 2026-09-13: the one exception is the operator's explicit, confirmed cancellation on Escape, specified in [prd-cancel-run-from-list.md](prd-cancel-run-from-list.md).) (Amended 2026-09-13: the one exception is the operator's explicit, confirmed cancellation on Escape, specified in [prd-cancel-run-from-list.md](prd-cancel-run-from-list.md).)

## User Stories

The test names and the new E2E artifact below are proposed deliverables, not existing verification. Existing test homes are `extensions/pi-agent-wave/test/runtime-watch.test.ts` and `e2e/tests/`.

### US-001: Open and maintain the list when workers start

**Description:** As the operator, I want the agent list to appear when a worker starts and grow as more start, without entering a follow command.

**Acceptance Criteria:**

- [x] Successful `runtime_attempt_registered` in a TUI session opens the list; graph initialization and failed dispatch do not. Proof: proposed test `agent list opens on registered dispatch only` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] Later successful registrations append distinct attempts to the existing list with stable numbers, including retries and workers from another run started in the same session; duplicate dispatch acknowledgement creates no duplicate row. A new worker does not replace selected details. Proof: proposed test `registered attempts append without renumbering or replacing selection` in that file.
- [x] Headless and ACP execution creates no widget or keyboard subscription and retains existing tool results/progress events. Proof: proposed test `automatic agent list is TUI only` in that file.
- [x] Typecheck passes. Proof: `npm run typecheck` from `extensions/pi-agent-wave/`.
- [x] Real terminal proof covers automatic opening and later append. Proof: proposed `e2e/tests/test_us008_default_agent_list.py`, with a fresh real Pi TUI transcript. See the E2E constraint below; the harness exists and the test passed three times in a row on 2026-09-13.

### US-002: Select stable numbered details without Herdr focus

**Description:** As the operator, I want to select an agent's number to inspect its task, status and output, even after its presentation tab disappears.

**Acceptance Criteria:**

- [x] Number selection opens a detail view bound to the selected attempt, showing run, role/node, model, task, process state and acceptance state, plus bounded rendered live output when present or retained answer after settlement. Missing output is stated explicitly. Proof: proposed test `number selection shows attempt-bound live and retained details` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] A settled candidate awaiting decision is labeled as settled rather than running. A collected or superseded attempt remains inspectable without using a replacement attempt's identity. Proof: proposed test `settled and superseded entries retain their own details` in that file.
- [x] Number selection executes no Herdr focus or cancellation command, including when a stored Herdr identity no longer exists. Proof: proposed test `missing Herdr agent cannot prevent detail inspection or mutate a run` in that file, asserting no external command and unchanged store state.
- [x] Every displayed number is selectable, including numbers beyond nine. Proof: proposed test `multi-digit selection addresses the displayed attempt` in that file; use entered digits plus Enter for every selection, including single digits, so `1` alone does not act until Enter; the view must display the pending digits as they are typed so the operator sees an in-progress selection rather than a dead key, and Escape or `q` clears a pending entry before falling through to their navigation meaning.
- [x] Typecheck passes. Proof: `npm run typecheck` from `extensions/pi-agent-wave/`.
- [x] Real terminal proof covers list-to-detail navigation, return to list, refresh and a settled attempt with no live Herdr target. Proof: proposed `e2e/tests/test_us008_default_agent_list.py` and its fresh terminal transcript; fake UI callbacks alone do not satisfy this criterion.

### US-003: Preserve controls and provide explicit reopening

**Description:** As the operator, I want the existing TUI controls and an explicit way to reopen the overview without affecting worker execution.

**Acceptance Criteria:**

- [x] `r` refreshes the current view; `q` or Escape returns from detail to list and closes when already in the list. (Escape's role was later changed by [Cancel the run's workers from the list](prd-cancel-run-from-list.md): it now asks to cancel the run's workers, and `q` alone navigates and closes.) (Escape's role was later changed by [Cancel the run's workers from the list](prd-cancel-run-from-list.md): it now asks to cancel the run's workers, and `q` alone navigates and closes.) Closing removes the widget, input subscription and timer without changing graph state. A later successful worker start reopens the list, but an ordinary refresh does not undo a manual close. Proof: proposed test `agent list navigation and closing are read-only` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] Existing `/graph watch <runId> --follow` still opens the run-scoped interactive view; `/graph status --follow <runId>` and `/graph status <runId> --follow` are aliases. Bare `/graph status <runId>` and `op=status` keep their existing one-shot contracts. Proof: proposed test `follow command aliases preserve one-shot status` in that file.
- [x] Refreshing is limited to the open view; when no tracked worker is running, automatic redraw stops while retained details remain manually accessible. Session end or view replacement removes obsolete input handlers and timers. Proof: proposed test `agent list refresh resources follow view lifetime` in that file.
- [x] Both READMEs and the project `AGENTS.md` describe automatic opening, numbering, in-TUI details and controls without claiming number selection focuses Herdr. Proof: updated files plus the relevant existing documentation tests and `git diff --check`.
- [x] Typecheck passes and real terminal navigation is verified. Proof: `npm run typecheck` and proposed `e2e/tests/test_us008_default_agent_list.py`.

## Functional Requirements

1. FR-1: The system must open or update the overview after successful attempt registration in the current TUI session, including tool-driven dispatch. It must not require `/delegate` as the entry point.
2. FR-2: The system must assign stable session-local numbers to attempt identities. Subsequent registrations append; display numbers are presentation state, not database identifiers. Do not require a schema migration or persistent UI registry.
3. FR-3: The system must keep entries distinct across runs and retries and distinguish process outcome from task acceptance. Retain settled entries for inspection while the session remains open.
4. FR-4: The system must show details locally using existing runtime state, rendered stream data and verified retained content. It must not depend on Herdr liveness or invoke focus/cancel during number selection.
5. FR-5: The system must bound output reads and keep raw protocol envelopes out of the human-facing detail view. Display unavailable data honestly; do not fabricate missing history or treat partial output as a final answer.
6. FR-6: The system must preserve `r`, `q` and Escape as intentional TUI navigation, display available controls, and support all displayed numbers.
7. FR-7: The system must retain existing explicit Herdr focus commands, noninteractive status, headless execution and ACP progress behavior.
8. FR-8: The system must keep the view read-only and tie timers/subscriptions to its lifetime, with no scheduler or worker lifecycle transitions inside rendering/input handlers.

## Non-Goals

- Fixing the unrelated Claude stream or adapter-gate documentation findings from the preceding review.
- Repairing Herdr agent registration or cleanup globally, or changing `/graph focus` behavior.
- Changing graph topology, model routing, settlement, acceptance or retry policy.
- Showing unrelated agents from other Pi sessions, or polling the global graph database for externally spawned workers.
- Persisting display numbers across Pi restarts, adding a background daemon or changing installed Pi settings.
- Paid provider probes, commits, pushes, publication or real-installation activation without separate authorization.

## Design / Technical Considerations

Reuse `watchRun`, the stream renderer and retained runtime answers, but do not derive the historical list solely from operations marked running. Use attempt identity to bind detail and number selection. The successful registration path in `extensions/pi-agent-wave/index.ts` already emits `runtime_attempt_registered`; it is the natural point to update session-local presentation state after registration succeeds. UI failure must not reclassify a successfully launched worker as a failed dispatch.

Likely affected existing components: `extensions/pi-agent-wave/index.ts`, `extensions/pi-agent-wave/test/runtime-watch.test.ts`, both READMEs and `AGENTS.md`. Read `lib/runtime-content.ts`, `lib/acpx-render.ts`, `store.ts` and `herdr.ts` as needed. Extract a small package-private view module only if keeping overview/detail state in the entry point becomes harder to follow. No transport or schema redesign is planned.

E2E constraint: the `e2e-test` skill was consulted. It assumes browser fixtures and testcontainers that this repository does not provide; the existing `e2e/tests/test_us007_air_headless_control.py` validates real Air rehearsal evidence instead. A real terminal end-to-end harness is required here, not a browser simulation or fabricated transcript. Proposed artifact: `e2e/tests/test_us008_default_agent_list.py`. The harness approach is resolved in the section below; the exact runnable command is still to be recorded once the script exists. Harmless deterministic worker launch fixtures can prove presentation mechanics without paid inference; callback-only unit tests cannot prove actual Pi terminal interaction. A missing terminal prerequisite remains a blocker, not a reason to weaken this acceptance criterion.

Take restore copies of already-dirty files before implementation. The parent issue's pre-plan copy is `agent-output/default-agent-list/restore-MUkJhw/prd-package-delegate-graph.md`; it is not a restore point for later source edits.

## Terminal Harness

Decided 2026-09-13 after probing the local herdr 0.8.0 and tmux installation. Herdr is the operator's default transport, so the primary harness drives a real Pi TUI inside a herdr pane and lets workers register as real Herdr agents. A tmux-only configuration with the headless fake worker is the fallback for machines without herdr and covers the "no widget in headless mode" criterion.

### Primary configuration: Pi TUI in an isolated herdr session

1. Start a headless server for a dedicated named session, for example `herdr --session pi-wave-e2e server`, or attach a client for it inside a sized tmux session (see sizing). Never use the operator's default session.
2. Export `HERDR_SOCKET_PATH` to that session's socket, shown by `herdr session list`. This is the only variable that retargets `workspace`, `tab` and `pane` subcommands; `HERDR_SESSION` and `HERDR_CLIENT_SOCKET_PATH` were tested and still address the default session. Shells spawned inside the session inherit the same socket path, so worker tabs the delegate creates also land in the isolated session.
3. Prepend a shim directory containing an executable named `acpx` that points at `extensions/pi-agent-wave/test/support/fake-acpx.mjs` to `PATH` before launching Pi. The delegate resolves `acpx` by `PATH` lookup on the host (`scripts/delegate_core.py`, `prepare_acpx_attempt`) and writes the absolute path into the attempt's worker config; the tab only receives `PI_ACPX_CONFIG`. The worker preflight requires `acpx --version` to contain `0.13.2`, which the fixture prints. `agentfs` 0.6.4 must be the real binary. The harness must assert the fixture worker actually started, since it runs under the agentfs sandbox allowing only the run directory.
4. Create a workspace and a tab in the isolated session, then launch Pi in it with `--extension` pointing at the checked-out extension, `--no-extensions`, and `--no-session`, so installed Pi settings are never touched.
5. Drive and observe with `herdr pane run`, `herdr pane send-keys`, `herdr pane read --source visible` and `herdr pane wait-output`. Close a worker tab manually before selecting its number to reproduce the missing-Herdr-target case in US-002.
6. Write pane captures plus a SHA-256 into an evidence JSON under `agent-output/default-agent-list/`, following the `air-e2e.json` pattern, and have the pytest assert on that evidence.
7. Tear down with `herdr server stop` against the session socket, then `herdr session delete`, and kill the tmux session if one was used. Assert the default session's tab list is unchanged before and after.

### Dispatch trigger: scripted fake provider

Decided 2026-09-13 (operator chose this over a test-only slash command or real inference). No slash command reaches `op=dispatch` directly: `/delegate` initializes the run and sends the supervisor contract to the model, and `/graph resume` also hands off to the model. Worker registration therefore only happens inside a model-driven `delegate_graph` tool call. The harness must not pay for or depend on real inference, so it supplies the model.

- Pi 0.85.1 supports `pi.registerProvider(name, { api, models, streamSimple })`, and `docs/custom-provider.md` in the installed package documents `streamSimple` pushing `toolcall_start`, `toolcall_delta` and `toolcall_end` events followed by `done`. A provider can therefore return a synthetic tool call with no network request.
- Deliverable: a test-only extension file under `extensions/pi-agent-wave/test/support/` (proposed `fake-supervisor-provider.ts`) that registers a zero-cost provider and model. The harness loads it with a second `--extension` flag and selects its model with `--model`. It is never installed, never referenced from `index.ts`, and never shipped in the package.
- The provider follows a script, not a policy: on the supervisor contract it emits `delegate_graph op=next`; on that result it emits `op=dispatch` for the first pending operation; then it stops. The harness advances later steps (a second dispatch for the append case, `op=collect` for the settled case) by sending further user messages, so each observed UI change has one identified cause in the transcript.
- The script must reuse the real supervisor contract and the real tool schema, so the list opens through exactly the code path a production session uses. If the fake provider needs anything from `index.ts` beyond the public tool contract, that is a design smell to report, not to work around.
- Evidence must include the provider's emitted tool calls and the tool results so the transcript shows the worker registered before the list opened.
- Verified 2026-09-13 with a scratch extension against Pi 0.85.1: `--model fake-e2e/scripted` selects an extension-registered model at startup, the provider receives the session's tool list in `context.tools`, a pushed `toolcall_start`/`toolcall_delta`/`toolcall_end` sequence with `stopReason: "toolUse"` makes Pi execute the tool, and the `toolResult` message reaches the provider on the next turn. Probe shape: `pi -p --no-extensions -e <fake-provider.ts> --no-session --no-skills --no-prompt-templates --no-context-files --offline --model fake-e2e/scripted "<message>" < /dev/null`. Registration used a placeholder `baseUrl`, a literal `apiKey`, a private `api` name and a zero-cost model entry; no network request was made.
- Caveat from the same probe: a synthetic `bash` tool call hung indefinitely in print mode with no output, while `read` completed. The cause was not investigated because the harness only needs `delegate_graph`. Run the harness's Pi process under a hard `timeout` and treat a hang as a failure with the captured transcript.

### Fallback configuration: tmux only, headless transport

Same script, but the operator terminal is a tmux pane driven with `tmux send-keys` and `tmux capture-pane`, and the transport is headless with the same fake acpx shim. This does not require the herdr server and is what proves US-001's headless criterion.

### Sizing

Herdr has no absolute resize command; `pane resize` only moves splits. Pane size is inherited from the attached client's terminal, so the harness attaches the client inside `tmux new-session -x <cols> -y <rows>` and takes the size as a parameter. Measured with a 200x60 client: herdr reports the pane area as 174x59 and the shell sees 173x59; the missing columns are the sidebar, which is what a real operator sees. A headless server with no attached client produced panes about fifty columns wide, which wraps agent names and breaks substring assertions. Default to 200x60, which matches a maximized terminal on a typical display in 2026, and keep a narrow 120x40 case to prove the list still renders when space is tight. 300x100 is larger than almost any single window and is not a realistic default.

### Verified behaviours and gotchas

- Verified 2026-09-13 in the restricted harness run: `herdr status` fails with `PermissionDenied: Operation not permitted`; `herdr session list` lists only `default` as stopped, while `tmux ls` also fails with `Operation not permitted`. The harness skips before creating a session; default-tab equality and tmux cleanup cannot be verified on this host. Package typecheck excludes `test/support`; the provider is checked separately with the same ES2022 compiler options and `--ignoreConfig`.

- Nested launch: when the harness itself runs inside a herdr pane, `herdr --session <name>` fails with `nested herdr is disabled by default`. Clear `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` for the client process instead of enabling the experimental `allow_nested` config, which would change installed configuration. The harness must detect this case, not assume it.
- `herdr pane run <pane> <command>` is reliable immediately after a tab opens; `send-text` followed by `send-keys enter` lost input twice while the shell was still starting.
- `herdr pane read --source visible` returned the screen correctly; `--source recent-unwrapped` returned nothing at the same moments. Assert on `visible` with a wide enough viewport rather than relying on unwrapped output.
- `herdr pane process-info` does not accept a positional pane id like the other pane commands; use `herdr pane get <pane>` for liveness, which also reports `viewport_rows`.
- `herdr pane wait-output` takes `--match` or `--regex` and defaults to the `recent` source; pass `--source visible` for consistency with reads.
- Pane creation returns JSON with `result.root_pane.pane_id`; read identifiers from responses rather than predicting them.
- Missing prerequisites (`herdr`, `tmux`, `agentfs` 0.6.4, or the Pi binary) must make the test report a skip with the reason, never a pass.
- The first slice is implemented: `extensions/pi-agent-wave/test/support/fake-supervisor-provider.ts` (scripted provider), `extensions/pi-agent-wave/test/support/acpx-shim/acpx` (PATH shim to the fake acpx), `e2e/default_agent_list_harness.py`, and `e2e/tests/test_us008_default_agent_list.py`. The package typecheck excludes `test/support`; the provider is checked separately with `./node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --allowImportingTsExtensions --skipLibCheck --types node test/support/fake-supervisor-provider.ts` from the package directory.
- A pane input line longer than the macOS tty canonical limit (1024 bytes) is silently never executed; the prompt simply reappears. The harness writes the Pi launch (environment plus long argv) to a private script and runs only its short path with `herdr pane run`.
- `/delegate --policy` takes the lowercase CLI alias (`auto`, `cheap`, `balanced`, `strong`, `local`, `long-context`), not the picker label; `Auto` fails with an extension command error.
- Pi clears its input line on submit and tool output scrolls the run message off a 60-row screen quickly, so readiness must be detected from what the fake provider prints (`FAKE_SUPERVISOR_DISPATCHED` / `FAKE_SUPERVISOR_BLOCKED`) or the command error line, not from the echoed command.
- `herdr pane send-keys` names Control-C `ctrl+c` (`ctrl-c` is rejected as an unsupported key).
- Private run directories live under `/private/tmp/delegate-graph-herdr-<slug>` where the slug lowercases and hyphenates the run and operation ids, so `run_...` does not appear literally in the name. The harness derives the directory from the agent row's `acpx_cancel_script` path and cleans up by that exact path.
- A sandboxed subprocess (the Codex runtime here) gets `Operation not permitted` on the Herdr socket and tmux; the harness reports that as a prerequisite skip. Run the E2E from an interactive session with socket access.
- Amended 2026-09-13 by [Enter and arrows select workers](prd-enter-and-arrows.md): Enter alone opens the only running worker, or focuses the list so the arrows choose; numbers stay as labels and typed selection still works.
- Amended 2026-09-13 by [Collapse settled rows](prd-collapse-settled-rows.md): settled and superseded workers fold into one summary line naming their numbers; `s` shows or hides them. Numbers stay stable and selectable, as FR-2 requires.
- The terminal proof caught a defect the unit tests could not: with the list open, its input handler consumed digits, `r` and `q` from a command the operator was typing (`/graph log run_…` arrived as `/gaph log un_…`). The list now reads keys only while `ctx.ui.getEditorText()` is empty, and a unit test covers it. Consequence worth knowing: a message that starts with `q`, `r` or a digit while the list is open and the editor is empty is taken by the list; the follow view has always behaved this way.
- Pi's status bar names the model before startup completes; a command submitted while "Startup is still in progress" is on screen stays in the editor unsubmitted. The harness waits for that banner to disappear and retries Enter once.
- The default session's tab list changes `focused` while the operator keeps working; the harness compares workspace id, tab id and label only.
- Settlement in the terminal proof goes through the real `op=collect` (the fake supervisor accepts `collect <runId> <operationId>`), so the "settled" label is produced by the production path, not by writing the database.
- Decided 2026-09-13 after the first implementation: the explicit `/graph watch --follow` view also opens details by number plus Enter (same renderer, same empty-editor gating) rather than focusing a Herdr tab, because the original `agent_not_found` failure would otherwise survive in that view and a digit would mean different things in the two views. `/graph focus` remains the only tab-focusing path (FR-7). Both READMEs describe it.
- Running the full unit suite leaves headless `delegate-graph-herdr-*` run directories under `/private/tmp` from pre-existing tests; they are not created by the harness.
- The Pi under test runs with a fixture `HOME` (under the harness temp directory) so dispatch is deterministic and never reads the operator's credential stores. The delegate takes its credential home from `HOME`, the policy resolver reads `model-routing.jsonc` and `models.json` from `PI_CODING_AGENT_DIR`, and a model outside `openai-codex/` and `claude-code/` routes to the `pi` agent whose credential preflight is `pi auth check` plus an `auth.json` entry. The fixture home therefore holds a catalog with provider `fake-e2e-worker` and model `fixture-worker`, a mode-600 `auth.json` entry for it, a routing config whose every tier lists that model, and a copy of the operator's installed `herdr-agent-state.ts` so `herdr integration status` reports `pi: current` without installing anything. Verified 2026-09-13: the attempt key names `fake-e2e-worker/fixture-worker`, the harness asserts it (`selectedModelIsFixture`), and the test passed twice in a row. The only remaining machine dependency is that the Herdr Pi integration file exists to be copied; its absence is a prerequisite skip.

## Success Metrics

All acceptance criteria above are literally satisfied with named fresh evidence. Completion also requires the repository Node gate, typecheck and whitespace check, with failures and opt-in skips reported separately. No existing test count or earlier review result constitutes verification of this feature.

## Open Questions

- None. The harness command is `python3 -m pytest e2e/tests/test_us008_default_agent_list.py -x -s` from the repository root; it skips with the reason when Herdr, tmux, Pi 0.85.1, agentfs 0.6.4 or the installed Herdr Pi integration file is missing, and needs a session with Herdr socket access (a sandboxed subprocess reports a skip). On 2026-09-13 it passed three times in a row.
- Resolved 2026-09-13: the operator confirmed digits followed by Enter for number selection, rejecting a short inter-digit timeout. Session-wide stable numbering stands as specified.
