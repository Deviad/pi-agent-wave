# pi-agent-wave — Product Description

`@dpugliese/pi-agent-wave` turns a Pi session into a **supervisor** for ordered, evidence-gated multi-agent work. It runs Pi, Codex and Claude workers through ACPX, gives each attempt its own AgentFS copy-on-write sandbox, and records every run in a durable SQLite graph that JetBrains Air or a terminal can drive and inspect. Herdr is an optional presentation layer, never a requirement.

This document describes the product and every user-facing feature. Each claim is read from the current source and cites the file and symbol it came from; where the behavior is proven only by the shipped documentation or the retained evidence, the citation says so.

---

## 1. What the product is

- The package is `@dpugliese/pi-agent-wave` version `0.2.0` (`extensions/pi-agent-wave/package.json`, fields `name`, `version`). It registers five Pi entry points in `package.json:pi.extensions`: `index.ts` (the graph extension and its commands), `questionnaire.ts`, `cmux-session.ts` (session metadata hooks that bridge Pi session lifecycle to cmux and do nothing when cmux is absent; `extensions/pi-agent-wave/README.md` "cmux hooks"), `model-failover.ts`, and `claude-code-auth.ts`.
- `index.ts:delegateGraphExtension` installs the graph extension, then `delegation-identity.ts` (a small delegation label shown in a widget and powerbar) and `route-picker.ts` (`/route`). It refuses to load unless the external runtimes are the pinned versions (`require-runtime.ts:requireRuntime` → `require-acpx.ts:requireAcpx`, `require-agentfs.ts:requireAgentFs`): ACPX `0.13.2` (`require-acpx.ts:REQUIRED_ACPX_VERSION`) and Turso AgentFS `0.6.4` (`require-agentfs.ts:REQUIRED_AGENTFS_VERSION`). It raises before registration when either is absent or mismatched, so a broken install fails loudly instead of half-running.
- The supervisor does no work itself. It reads the next pending operation from the shared `GraphStore` (`store.ts:GraphStore`, `store.ts:next`), dispatches one worker for it, collects that worker's evidence, and advances the graph only when the evidence satisfies the operation's gate. Workers never talk to one another; every hand-off flows through the supervisor and the store's event table (`store.ts:event`).
- The only result contract is `runtime-v1` (`lib/runtime-results.ts:parseResultContract`; `ResultContract = "runtime-v1"`). The retired `legacy-v1` contract is refused by name. Workers author no report; the runtime retains what happened and the supervisor decides (`contract.ts:supervisorContract`, `lib/runtime-results.ts` doc comment).
- The package ships its TypeScript entry points, `lib/`, the `scripts/*.ts|mjs|py`, `README.md` and `LICENSE` (`package.json:files`). It bundles no external runtime, credential, user setting, database or generated evidence. The package binaries are declared but, because the npm package is not yet published, the documentation describes running the scripts through `node` from the checkout (`package.json:bin`, `extensions/pi-agent-wave/README.md` "Install").

---

## 2. The supervisor contract and how a Pi session drives delegation

`/delegate` (`index.ts:pi.registerCommand("delegate", …)`) does four things: it parses `[--policy <name>] <task>` (`index.ts:parseDelegateArgs`), resolves the model policy (`index.ts:resolvePolicy` → `scripts/policy-resolver.mjs`), initializes the run (`store.ts:initRun`), and sends the supervisor contract back to the model as a user message through `pi.sendUserMessage(supervisorContract(...))` (`contract.ts:supervisorContract`). It also renames the session (`pi.setSessionName(\`delegate: ${story}\`)`) and derives a story slug with `index.ts:slug`.

`contract.ts:supervisorContract` renders the exact instruction the supervisor follows. It names the run and task, describes the graph topology, prints the frozen per-role policy preview including promotions (`contract.ts:policyPreview`), and states the per-operation loop:

1. `op=next` returns pending operations with their frozen routes.
2. `op=dispatch` launches one worker; the extension owns transport, private files, launch and registration.
3. `op=collect` waits for the worker, settles the attempt from evidence, and returns the retained answer (bounded), its `VERDICT` line when the node has one, and a `decide` template.
4. `op=decide` accepts or rejects with a reason.
5. `op=next` again; repeat until the run is terminal, blocked, deferred or awaiting the user.

The contract also fixes the important edge cases: `op=record` is refused on runtime-v1 runs, cancellation is `op=cancel`, a failed or interrupted attempt is replaced with `op=retry`, and `op=resolve` (`retry`, `defer`, `abort`, `escalate`) applies only to a parked run. It tells the supervisor to keep `modelPolicy` and `policyDigest` from `op=next` unchanged, never to invent an edge or bypass a join, and never to synthesize settlement facts or author placeholder answers. The loop is enforced by the tool, not merely described: `index.ts:pi.registerTool({name:"delegate_graph", …})` implements each branch and refuses illegal transitions (§4).

The task selects the graph in `index.ts:graphFromTask`: a task beginning with `research`, `explore` or `search` selects the read-only `research` graph and strips the prefix; everything else selects `build`. The `operations` graph is reached only by direct `delegate_graph op=init` with `graph: "operations"`; `/delegate` never selects it (`index.ts:graphFromTask`, `index.ts:delegateGraphExtension`). A direct `op=init` on the `build` or `research` graph may also set `workspaceRoot` to `$HOME` or a directory under it, making a home run: every operation works there, owns its whole working directory, and its changes are placed without Git and can be undone (`store.ts:homeWorkspaceRoot`, `tasks/handoff-home-workspace-mode.md`).

Model policy for `/delegate` is chosen by `index.ts:pickPolicy`: an explicit `--policy` wins, headless mode defaults to `auto`, and a TUI session opens `ctx.ui.select` over `POLICY_PICKER_OPTIONS` with title `POLICY_PICKER_TITLE`. The five presets are `cheap`, `balanced`, `strong`, `local`, `long-context` (`index.ts:POLICY_PRESETS`), mapped by `index.ts:policyInputFromName` into the tagged union `types.ts:ModelPolicyInput` (`auto`, `preset`, `tier`, `model`). The picker's `local` option is documented to fail closed before dispatch if a required role cannot meet its capability floor with a local model (`index.ts:POLICY_PICKER_TITLE`).

The run files are private. `scripts/delegate_core.py:command_init` creates `/tmp/delegate-graph-herdr-<slug>.<random>/` mode `0700`, writes `state.json` and `system-prompt.txt`, and prints the directory. `scripts/delegate_core.py:require_run_dir` accepts only a directory directly under `/tmp` whose name starts with `delegate-graph-herdr-` and that contains `state.json`, so a mistyped `runId` cannot point settlement at an arbitrary path.

---

## 3. Commands

### `/delegate`

`/delegate [--policy <auto|cheap|balanced|strong|local|long-context>] <task>`. Starts a durable run, freezes the model route for every role, renames the Pi session, and injects the supervisor contract (`index.ts` `registerCommand("delegate")` handler). The only leading flag is `--policy` (`index.ts:parseDelegateArgs`); flags inside the task stay task text. A task beginning `research`/`explore`/`search` selects the research graph (`index.ts:graphFromTask`).

### `/graph`

Registered in `index.ts:pi.registerCommand("graph", …)`. The usage notice is `usage: /graph agents|status [--follow]|watch [--follow]|log|focus|resume|ledger|prune` (`index.ts:delegateGraphExtension`). Subcommands:

- **`/graph agents`** — reopens the session's numbered agent list (`index.ts` calls `agent-list.ts:reopenAgentList`). TUI only; outside the terminal it explains that the list needs the interactive terminal.
- **`/graph status <runId>`** — one-shot rendered status (`commands.ts:renderStatus`). With `--follow` before or after the run id it is an alias of `/graph watch <runId> --follow` (`index.ts` checks `subcommand === "status" && !rest.includes("--follow")`).
- **`/graph watch <runId> [--follow]`** — one-shot `renderWatch(watchRun(...))`, or the persistent follow view through `index.ts:startFollow`. ACP/headless clients receive the same summary through `op=watch` progress events (`index.ts:refreshWatchLiveViews`, `index.ts:watchRun`).
- **`/graph log <runId> [--tail <count>] [--agent <name>]`** — the event ledger (`commands.ts:renderLog`), default tail 50, filterable by agent.
- **`/graph focus <runId> <node-or-agent>`** — brings a Herdr worker tab forward (`herdr.ts:focusRegisteredAgent`). Headless workers have nothing to focus, and the command refuses focus outside Herdr.
- **`/graph resume <runId> <operationId>`** — the operator's fenced replacement of a parked operation (`store.ts:retryRuntimeAttempt` with `approved: true`), then sends a resume user message carrying the stored policy digest and instructs the model not to re-resolve routes (`index.ts:delegateGraphExtension`).
- **`/graph ledger <runId> [path]`** — derived read-only JSON view (`store.ts:runtimeLedger`), printed or written mode-600 to `path`.
- **`/graph prune [days]`** — `store.ts:prune`, default 30 days.

### `/failover`

Registered in `model-failover.ts` (`pi.registerCommand?.("failover", …)`): `/failover enable <tier>` arms same-tier failover for the current session, `/failover status` reports state and the latest recovery, and `/failover unlock <tier>` clears a manual-selection lock and re-arms the route. This is **main-session** failover for the interactive supervisor, separate from worker failover, and is off until enabled. Enabling loads the tier route and requires the current model to be in it (`model-failover.ts:loadTierRoute`, `armRoute`); an external model selection sets a manual lock and is persisted as a session entry; unlock re-arms. Exact-model locks (`PI_FAILOVER_LOCKED=1`) cannot be unlocked.

### `/route`

Registered in `route-picker.ts` (`routePicker`). `/route [role]` inspects and safely re-pins one Delegate Graph role's tier. It reads the six role routes through `route-picker.ts:loadRoleRoutes` and formats them (`formatRoleOption`, `formatRolePreview`); with a role it opens a tier picker, and `route-picker.ts:repinRole` backs up the original file (`timestampedBackup`), parses it (`lib/jsonc.mjs:parseJsonc`), replaces only the single `tier` value (`roleTierSpan`), re-validates through `lib/model-routing.mjs:resolveModel`, and atomically renames it, refusing if the file changed during the re-pin. The module also exposes `route-picker.ts --list | --preview <role>` as a CLI.

### `/claude-headers`

Registered in `lib/claude-auth-config.ts:registerClaudeHeadersCommand`. `/claude-headers status` shows the effective and saved Claude Code version; `/claude-headers update` runs `claude --version` (ten-second timeout), validates the result, and atomically saves `$PI_CODING_AGENT_DIR/claude-code-headers.json` mode 600 (`lib/claude-auth-config.ts:updateClaudeHeaders`). A failed query preserves the existing file.

---

## 4. The `delegate_graph` tool and every operation

Registered by `index.ts:pi.registerTool({name:"delegate_graph", …})`; parameters are declared in `index.ts:GraphParams` and guidance in `index.ts:promptGuidelines`. The tool is the state-machine API behind `/delegate` and the interface an ACP client such as JetBrains Air drives.

- **`init`** — `story`, `task`; optional `graph` (`build|research|operations`), `modelPolicy`, and `commands` for operations runs. It resolves the policy (`index.ts:resolvePolicy`) and calls `store.ts:initRun`, returning the run state and `next`. Direct init accepts every tagged policy form; `/delegate` exposes only the six picker policies.
- **`next`** — `store.ts:next`: current-phase operations, each with its frozen `route`, `modelPolicy`, `policyDigest`, attempt counters, `retry_not_before`, and active attempt. `index.ts` overlays `lib/liveness.ts:runLiveness`: a `running` operation whose worker is provably gone is returned with `status: "orphaned"`, `storedStatus`, `orphanReason` and `recovery`; the store is not written.
- **`status`** — `commands.ts:renderStatus`, read-only. Each task is reduced to `commands.ts:taskSummary` (SHA-256 of the stored text, byte size, 120-character preview), a failed or blocked operation shows its `last_error` as `blocker=`, and an `operationId` appends that operation's full task; `op=next` still returns full task rows.
- **`watch`** — `index.ts:refreshWatchLiveViews` then `index.ts:watchRun`, emitting a `watch` progress event so ACP clients see the same summary. Read-only; consulted by no gate. An orphaned worker's process state reads `orphaned (<reason>)` (`lib/liveness.ts`).
- **`dispatch`** — resolves the selected model from the frozen route, selects the transport (an explicit `transport` parameter wins; otherwise `scripts/delegate.ts:selectTransport` with `headless` outside the TUI and `auto` inside it), computes the dispatch working directory from `command_json` when the operation is an operational command, refuses an `implement` operation whose working directory has no Git `HEAD` before anything is created (a permanent `[dispatch_precondition]` failure through `store.ts:retryRuntimeAttempt`, reported as `dispatched: false`, `blocked: "precondition"`), calls `scripts/delegate.ts … init` to create the private run directory, materializes run evidence (`index.ts:materializeRuntimeEvidence`), writes `task.md`, then calls `… start`. On a preflight block (`scripts/delegate_core.py:preflight_agent_credentials`, text `worker preflight:`) it classifies the launch failure through `store.ts:retryRuntimeAttempt`, fenced to the dispatched counters, discards the unlaunched directory (`index.ts:discardUnlaunchedRunDirectory`), and reports `dispatched: false`. On success it re-derives the worker identity with `scripts/acpx-plan.ts:resolveAcpxPlan`, verifies it matches the launched attempt key, registers the agent (`store.ts:registerAgent`) and the attempt (`store.ts:beginRuntimeAttempt`), and then opens the agent list (`agent-list.ts:noteRegisteredAttempt`).
- **`collect`** — `index.ts:collectRuntimeAttempt`: when the attempt is unsettled and its private run directory no longer exists, settles it `failed` with `worker orphaned: private run directory … no longer exists` without waiting and closes that worker's Herdr tab (`herdr.ts:closeRunTabs`, evidence `tab-cleanup-<operationId>.json`); otherwise waits through `scripts/delegate.ts … wait`, settles from durable evidence (`index.ts:settlementFromEvidence` / `store.ts:settleRuntimeAttempt`), then `index.ts:finalizeRunDirectory` retains records and removes the transient run directory. The result carries `index.ts:decisionBrief`: a bounded answer prefix (first 16 KiB, `ANSWER_PREVIEW_BYTES`), `answerBytes`, `answerTruncated`, the answer's final `VERDICT:` line when the node carries one, a `decide` template, and a `note`. Collecting again returns the same settlement.
- **`integrate`** — `store.ts:applyRuntimeIntegration(attemptKey, manifest, direction)`, `apply` or `rollback`, through the journal (`lib/runtime-integration.ts:RuntimeIntegration`). Required before accepting a coding or operational candidate that staged file changes. A `rollback` of a placement already applied without Git checks (operational candidates, and coding candidates of a home run) is an undo (`store.ts:undoRuntimeIntegration`), available after the run moved on or ended; with Git checks an applied integration is reverted with Git.
- **`decide`** — `store.ts:decideRuntimeCandidate` with `accepted|rejected`, a required reason, and optional `verdict` and `payload`. This is the only way an operation completes. `retry`, `defer`, `abort` and `escalate` are refused here with a message naming `resolve`.
- **`retry`** — `store.ts:retryRuntimeAttempt`, applying `retry.ts:classifyFailure` and the frozen chain. For a launch failure with no registered attempt, pass `error` plus the exact `modelAttempt` and `transientAttempt` the launch used; a replayed or stale failure is refused.
- **`resolve`** — `retry` (the operator's fenced replacement), `defer` with `deferredUntil`, `abort`, `escalate`. It applies only to a parked run (`awaiting_user`, `deferred` or `blocked`) and is refused while the run is active (`store.ts:resolveExhaustion`).
- **`cancel`** — cancellation of one operation. With a registered worker it stops the exact worker through its structured cancel script (`herdr.ts:cancelRegisteredAgent`); an operation whose worker was never registered is settled as cancelled with an `unlaunched-<operationId>.json` diagnostic (`index.ts:settleUnlaunchedOperation`). It then records `cancelled` (`store.ts:record`).
- **`record`** — refused. The tool has no record branch; every `op=record` call falls through to the final refusal naming `op=cancel` (`index.ts:delegateGraphExtension`). There is no record transition on runtime-v1 runs.

The `dispatch` result names the agent, ACPX session, attempt key, AgentFS session and database, the cancel script, the transport, and the Herdr tab/pane identity when one exists (`index.ts` dispatch return value). A run-scoped cancel-all is not a tool operation: it belongs to the interactive agent list and follow view (§7).

---

## 5. The three graphs

Graph definitions live in `graph-core.ts` (`BUILD_GRAPH`, `RESEARCH_GRAPH`, `OPERATIONS_GRAPH`, `graphDefinition`). Each node is `{name, role, fanOut, readOnly}` (`types.ts:GraphNodeDefinition`, `types.ts:NodeName`). The chosen definition is frozen into the run by `store.ts:initRun` as `graphs.definition_json` with a sha256 (`store.ts:graphHash`), and transitions are computed by the pure function `graph-core.ts:decideTransition`.

### Build — `graph-core.ts:BUILD_GRAPH`

`thinker_plan` (thinker, read-only) → `implement` (implementer, fan-out, writable) → `review` (reviewer, read-only) → `test` (tester, read-only) → `audit` (auditor, read-only) → terminal. `graph-core.ts:decideTransition`:

- `thinker_plan` → `implement` ("plan accepted").
- `implement` → `review` when every implementer at the current round/fix has completed, gated by the join check `store.ts:allCurrentComplete`.
- `review` `PASS` → `test`; `FAIL` → back to `implement` with `fixIteration + 1`, capped at `fixIteration >= 2` (blocked, "review fix-iteration cap reached"); any other verdict → blocked.
- `test` `GREEN` → `audit`; `NOT_OK` → back to `implement` with `round + 1` and `fixIteration` reset to 0, capped at `round >= 3` (blocked, "semantic implementation-round cap reached").
- `audit` `PASS` → terminal; otherwise blocked.

So the build graph allows at most two review fix-iterations per round and at most three implementation rounds, and those limits are graph edges, never ad hoc retries. The topology is restated for the supervisor in `contract.ts:supervisorContract`.

### Research — `graph-core.ts:RESEARCH_GRAPH`

`thinker_split` (thinker, read-only) → `search` (searcher, fan-out, read-only) → `thinker_synthesize` (thinker, read-only) → terminal. Transitions: split → search; search → synthesize once all searchers complete; synthesize → terminal. `store.ts:createNextOperations` forces search slices read-only with empty owned paths (`slices.map((slice) => ({ ...slice, readOnly: true, ownedPaths: [] }))`).

### Operations — `graph-core.ts:OPERATIONS_GRAPH`

`source_search` (searcher, fan-out, writable) → `thinker_synthesize` (thinker, read-only) → `audit` (auditor, read-only) → terminal. Transitions: `source_search` advances only on `verdict === "DONE"`, otherwise blocked; `thinker_synthesize` advances to `audit` only on `DONE`, otherwise blocked; `audit` is terminal on `PASS`, otherwise blocked. The synthesis verdict is supplied by the supervisor, not asked of the worker: `thinker_synthesize` has no `VERDICT` requirement, and `index.ts:decisionBrief` sets `decide.verdict = verdict ?? "DONE"` for `operationsSynthesis`. The "supply DONE" rule is also stated in the `op=collect` decision brief note.

The operations graph requires at least one structured command and complete, disjoint ownership: `store.ts:validateOperationalCommands` requires `id`, `name`, `executable`, string `args`, and `cwd`, and `store.ts:assertDisjointOwnership` refuses overlapping writable paths. A declared `checkpoint` must lie under one of the command's owned paths (`store.ts:validateOperationalCommands`; `scripts/delegate_core.py:operational_checkpoint_path`), and the command's `cwd` must equal the worker's working directory (`scripts/delegate_core.py:operational_instruction`).

Roles map to nodes in `store.ts:roleForNode` (`thinker`, `implementer`, `reviewer`, `tester`, `auditor`, `searcher`; `route-picker.ts:DELEGATE_GRAPH_ROLES`). Fan-out slices come from a thinker's `payload.slices` (`store.ts:slicesFromPayload`) or, on a rework cycle, from the previous implementation's slices (`store.ts:previousSlices`). `thinker_plan` and `thinker_split` decisions must carry `payload.slices`, and build slices must have disjoint `ownedPaths` (`store.ts:createNextOperations`, `index.ts:decisionBrief`).

`RUNTIME_VERDICT_NODES` in `scripts/delegate_core.py` and its mirror `VERDICT_NODES` in `index.ts` state that `review`, `test`, `audit` and `source_search` answers must end in one `VERDICT:` line (`PASS`/`FAIL`, `GREEN`/`NOT_OK`, `PASS`/`FAIL`, `DONE`/`BLOCKED`). A positive verdict is never inferred from an exit code: it is read from the answer's final line, or rejected when absent (`index.ts:decisionBrief`, `scripts/delegate_core.py:RUNTIME_VERDICT_NODES`).

---

## 6. Questions and answers through the questionnaire tool

`questionnaire.ts` registers the `questionnaire` tool (`questionnaire.ts:pi.registerTool`). It accepts one or more questions, each `{id, label?, prompt, options[], allowOther?}` (`questionnaire.ts:QuestionnaireParams`), normalizes missing labels to `Q1`, `Q2`, … and `allowOther` to true, and renders through three paths:

- **TUI (`ctx.mode === "tui"`)**: a custom `ctx.ui.custom` component with a tab bar for multiple questions, arrow navigation, `Space` to select the highlighted option, a `Type something.` editor, and a `Submit` tab; `Escape` cancels. On a single question, selecting an option submits immediately; with several questions, selecting advances and the final Submit tab requires `Enter`.
- **Non-TUI with a dialog UI (`ctx.hasUI`)**: `questionnaire.ts:runAcpPicker` presents each question through `ctx.ui.select`, appending `← Back` after the first question and ` Cancel questionnaire` to every picker; after all questions it shows a review picker requiring `✓ Submit answers`, so nothing is sent before confirmation. Free-form answers are typed in chat because input dialogs are cancelled in ACP.
- **Non-TUI without a dialog UI**: returns an `awaiting_user` details state with a Markdown table (`questionnaire.ts:renderAwaitingUser`), numbered so the user can reply with a number, or letter-plus-number for multiple questions.

The tool exists so a supervisor can ask structured questions instead of printing numbered prose (`questionnaire.ts` tool description), and it is what renders as native pickers in JetBrains Air (`questionnaire.ts:runAcpPicker`).

---

## 7. Cancellation from the agent list and the follow view

Cancellation is the only mutation either interactive view may trigger, and it is always confirmed.

- **Agent list** (`agent-list.ts`): `Escape` asks to cancel every running worker of the run in view (`agent-list.ts:handleInput`, `agent-list.ts:runningWorkerNames`); `Enter` confirms (`agent-list.ts:confirmCancellation`); `q`/`Escape` aborts. Keys reach the list only while the editor is empty (`ctx.ui.getEditorText?.()`), key releases are ignored (`isKeyRelease` imported by `agent-list.ts:handleInput` from `@earendil-works/pi-tui`), and non-arrow key repeats are consumed (`agent-list.ts:isKeyRepeat`).
- **Follow view** (`index.ts:startFollow`): the same `Escape`-then-`Enter` confirmation, rendered by `agent-list.ts:renderCancelConfirmation`, and the same editor-empty guard and key-release handling.

Both run `index.ts:cancelRunWorkers`: for each running operation it cancels through the structured cancel script (`herdr.ts:cancelRegisteredAgent`), settles the attempt as cancelled (`store.ts:settleRuntimeAttempt` with `{kind:"cancelled"}`), then calls `store.ts:cancelRunningOperations`, which marks the running operations and the run `cancelled` in one transaction. A worker whose stop cannot be confirmed is named in the returned `CancelRunReport.failed` and in the in-session notice; the run is still recorded cancelled because that is what the operator asked for. An unconfirmed stop is never assumed. Cancellation of a single operation through the tool is `op=cancel` (§4).

---

## 8. Retry, model-chain fallback and parking

Worker retry is `store.ts:retryRuntimeAttempt`, using `retry.ts:classifyFailure`, `retry.ts:selectModelFallback` and `retry.ts:retryDelayMs`.

- A **transient** failure (`retry.ts:TRANSIENT_PATTERNS`: 429/500/502/503/504, rate-limit, quota, overload, timeout, connection reset/close, `ACPX worker failed`, `terminal=failed`, `QUEUE_RUNTIME_PROMPT_FAILED`, provider credential target churn, report-missing, worker preflight/no usable credential, `REPORT_UNAVAILABLE`, exited before result, a worker gone before its result (Herdr attempt directory removed or agent no longer registered, or `worker orphaned:` at `collect`), exited without a candidate, runtime snapshot churn, AgentFS audit or snapshot errors, result-present-but-process-did-not-exit) spends the three-attempt same-model budget (`operation.transient_attempts < 3`) with full-jitter exponential backoff up to 300 s (`retry.ts:retryDelayMs`), recorded as `retry_not_before`.
- When the budget is spent and the frozen chain has another entry, `retry.ts:selectModelFallback` advances `model_attempt` by exactly one and records a `fallback_reason`; the store logs a `model_fallback` event (`store.ts:retryRuntimeAttempt`). An **exact-model lock** never advances (`options.exactLock`, `store.ts:modelFallbackFor`).
- When the budget is spent and there is no further model, the run parks in `awaiting_user` and emits a `retry_exhausted` event (`store.ts:retryRuntimeAttempt`).
- A **permanent** failure parks immediately. `retry.ts:APPROVAL_BLOCK_PATTERN` is checked before the transient scan, so a denied authorization is permanent and never spends the budget. `retry.ts:NEVER_LAUNCHED_PATTERN` is checked after the transient patterns, so a genuine infrastructure failure still falls across the chain. An ownership failure (`[owned_path_escape]`, unowned AgentFS changes) is permanent.
- An `exited` attempt **with** a candidate must be decided, not retried; an `exited` attempt **without** a candidate is a transient `worker-empty-answer` failure and its raw stream is retained (`store.ts:retryRuntimeAttempt`, `scripts/delegate_core.py:retain_incomplete_capture`).
- A cancelled attempt cannot be retried, and a failed coding/operational attempt with an outstanding integration cannot be replaced until the integration is rolled back (`store.ts:outstandingIntegrationFor`).
- Dispatch preflight failures with no registered attempt are fenced to the exact counters that were dispatched, so one failure can never spend the budget twice (`index.ts` dispatch preflight branch, `store.ts:retryRuntimeAttempt`).

Parking and recovery: `store.ts:resolveExhaustion` applies `defer` (records `deferred` and the requested `deferredUntil`), `abort` (operation and run cancelled) or `escalate` (operation and run `blocked`). An operator-approved `retry` or `/graph resume` supersedes the parked attempt and advances the transient counter so the new identity is fresh, without restoring the same-model budget (`store.ts:retryRuntimeAttempt` approved branch). The `delegate_graph` tool exposes these as `op=resolve` and `op=retry`; `/graph resume` is the terminal command. A launchd job that resumes a deferred operation exactly once exists in `scheduler.ts:writeDeferredJob` / `installDeferredJob`, but the interactive picker that would install it (`index.ts:resolveUserDecision`) is not wired to a command or tool path.

Main-session failover is `model-failover.ts`, backed by `lib/model-failover-native.mjs` (`classifyFailoverError`, `findNextFailoverCandidate`, `parseFailoverRoute`, `loadTierRoute`, `sanitizeAssistantError`). It switches model on ordinary, quota and connection-closed failures within a tier route, excludes the whole failed provider, skips candidates with no registered model or configured auth, captures Pi's global `settings.json` and always restores the exact bytes after `pi.setModel` (`model-failover.ts:captureSettings`, `restoreSettings`), and records receipts and events as session entries (`model-failover-ready-v1`, `model-failover-event-v1`). Semantic, terminal, exact-lock and manual-lock conditions stop it; a successful fallback clears exclusions and keeps the replacement.

---

## 9. The numbered agent list and worker detail views

The session-local numbered agent list is `agent-list.ts`. It opens by itself when the first worker of the Pi session registers (`agent-list.ts:noteRegisteredAttempt`, called from `op=dispatch` after `store.ts:beginRuntimeAttempt` succeeded with a `runtime_attempt_registered` progress event), and later registrations append with stable numbers. Numbers are session-local presentation state, never persisted (`agent-list.ts:agentListState` exposes them read-only). Nothing in the list dispatches, settles, retries or decides work, and nothing depends on a Herdr tab.

`agent-list.ts:listRows` renders one row per entry: number, agent name, node, process/acceptance label (`agent-list.ts:processLabel`), short model, and last activity. Settled or superseded workers fold into one summary line (`agent-list.ts:renderSettledSummary`); `s` toggles showing them, their numbers never change, and a folded number still opens details.

`agent-list.ts:attemptDetail` and `renderAgentDetail` show run and status, operation, node, role, transport, model, process state, acceptance, task, the rendered tail of the live output, and the retained answer after settlement (bounded to the first 4 KiB, `ANSWER_LIMIT_BYTES`). Live output comes from the worker's terminal (`lib/pane-read.ts:paneLines`) or its published stream (`lib/live-stream.ts:liveViewFor`); a missing pane or stream is stated, never faked (`agent-list.ts:liveViewForAgent`).

Keyboard model (shared with the follow view): `Enter` alone opens the only running worker or focuses the list for the arrows (the header says `focused` and the marked row is the cursor); up/down move over the visible rows including the folded summary; a number followed by `Enter` opens that attempt directly; `r` refreshes; `q` clears a pending number, returns from details to the list, and closes; `s` toggles settled rows. The redraw timer exists only while the view is open and something listed is running, and it unrefs so it cannot hold the process open (`agent-list.ts:ensureTimer`, `draw`).

The **follow view** (`index.ts:startFollow` / `renderFollow`) is the run-scoped persistent form of `/graph watch --follow`. It redraws every `PI_GRAPH_WATCH_INTERVAL_MS` (default 2000, floor 50, `index.ts:watchIntervalMs`), stops when the run leaves `active`, and accepts the same number-plus-Enter detail opening, arrow navigation and Escape cancellation. `index.ts:refreshWatchLiveViews` is the place the tool waits to read the live views; the renderers stay synchronous so a worker, socket or `herdr` process cannot stall the terminal.

---

## 10. Worker transports

Execution is transport-neutral and ACPX-only. `scripts/delegate.ts:selectTransport` picks `headless` by default and `herdr` only when `HERDR_ENV=1`, `HERDR_WORKSPACE_ID` and `HERDR_TAB_ID` are present and the `herdr` executable exists (`scripts/delegate.ts:completeHerdrIdentity`). An explicit `herdr` fails closed outside a complete workspace; an explicit `headless` never creates a tab. `lib/worker-transport.ts` defines the transport kind and the presentation identity, and `store.ts:registerAgent` rejects a Herdr row without agent/tab/pane identity and a headless row that carries Herdr identity.

- **Headless** (the default, and what any caller gets unless it passes an explicit transport): `scripts/headless_delegate.py` enters `scripts/delegate_core.py:main("headless")`. The worker runs under `scripts/headless_supervisor.py`, a detached process that owns the worker's PTY, its capture files and its loopback live stream (`scripts/delegate_core.py:launch_headless_worker`). The worker is launched as `agentfs run --session <sessionName> --no-default-allows --allow <run-dir> … node --experimental-strip-types scripts/acpx-worker.ts` (`scripts/delegate_core.py:prepare_acpx_attempt`), where `<sessionName>` is the ACPX/AgentFS session minted for the attempt, so the copy-on-write overlay exists before ACPX starts and the agent CLI never runs outside it.
- **Herdr** (optional presentation): `scripts/herdr_delegate.py` enters `main("herdr")`. It creates one Herdr tab per worker (`scripts/delegate_core.py:tab_create_argv`, `herdr tab create`), runs the worker launcher in the tab's pane, and the pane shows the rendered worker stream (`lib/acpx-render.ts:AcpxRenderer`, used by `scripts/acpx-worker.ts`). It requires `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID` and the `herdr` command (`scripts/delegate_core.py:require_herdr`). The tab is named after the story and role (`herdr.ts:herdrAgentName`, `herdrTabLabel`). `herdr.ts:focusRegisteredAgent` brings a tab forward and verifies the pane identity first; a settled Herdr worker's tab is closed after its ACPX session closes and before the cleanup absence audit (`scripts/delegate_core.py:close_settled_tab`).

Both transports share planning, launch, audit, cancellation, settlement and cleanup in `scripts/delegate_core.py`. Every attempt gets one ACPX session and one AgentFS session keyed by run, operation, model attempt and transient attempt (`lib/acpx-types.ts:createAcpxAttemptIdentity`, `acpxAttemptKey`); a retry or fallback mints a new identity rather than reusing a closed session (`store.ts:beginRuntimeAttempt`). The frozen model selects the adapter: `openai-codex/*` → Codex, `claude-code/*` → Claude, everything else → Pi (`lib/acpx-select.ts:selectAcpAgent`).

The worker's provider environment is private: the credential store of the agent that will execute the model is preflighted (`scripts/delegate_core.py:preflight_agent_credentials`), a mode-600 credential is materialized for the selected provider (`materialize_pi_credentials`, `copy_credential_file`), and only the executing agent's configuration is copied in as mode-600 regular-file snapshots (`copy_runtime_file`). The private Pi settings carry zero packages and the frozen route's thinking level as `defaultThinkingLevel` (`scripts/delegate_core.py:worker_pi_settings`).

---

## 11. JetBrains Air integration through `pi-acp`

Air drives Pi as an ACP agent via `pi-acp`: Air owns a `pi-acp` session whose command is an absolute `npx` path and whose args are `["-y","pi-acp@0.0.31"]` (root `README.md` "Add Pi to JetBrains Air"). There is no Herdr process, workspace, tab, pane or environment variable in this path, and no Herdr resource is created (root `README.md` "Compatibility"). `pi-acp` `0.0.31` and Air `262.834.44` / `262.579.44` are the rehearsed versions (`extensions/pi-agent-wave/README.md` "Requirements and compatibility").

The extension emits structured tool progress through `onUpdate` (`index.ts` `progress`) for each phase: `run_created`, `operations_ready`, `status`, `watch`, `runtime_evidence_materialized`, `runtime_attempt_registered`, `runtime_attempt_settled`, `runtime_candidate_decided`, `runtime_retry_exhausted`, `runtime_attempt_replaced`, `runtime_integration`, `recovery_resolved`, `dispatch_blocked_by_preflight`, `dispatch_refused_by_precondition`, `unlaunched_operation_settled`, `runtime_attempt_failed`, `cancel_of_dead_attempt`, and `cancelled`. Air receives the same run state as the terminal. Because not every ACP client exposes Pi slash commands, Air workflows use the equivalent `delegate_graph` operations (`op=init`, `op=status`, `op=watch`, `op=cancel`, `op=retry`, `op=resolve`, `op=next`) directly (root `README.md` "Run from Air"). The `questionnaire` tool renders as native pickers in Air (`questionnaire.ts:runAcpPicker`, gated on `ctx.hasUI`). Outside a TUI the default dispatch transport is `headless`, so Air needs no Herdr (`index.ts` dispatch branch).

---

## 12. The Claude provider and header handling

`claude-code-auth.ts` registers the `claude-code` provider (`pi.registerProvider`) using `@cgaravitoq/claude-code-core` for credential discovery and refresh (`readClaudeCodeCreds`, `refreshClaudeCodeCreds`) and `lib/claude-auth-stream.ts:streamClaudeCodeAnthropic` for streaming. It also registers `/claude-headers` (`lib/claude-auth-config.ts:registerClaudeHeadersCommand`). Loading the extension does not read credentials or refresh tokens; login and refresh happen on demand.

Request metadata is built by `lib/claude-auth-headers.ts:buildClaudeRequestMetadata`: the version comes from `ANTHROPIC_CLI_VERSION` or the saved config, `CLAUDE_CODE_ENTRYPOINT` defaults to `sdk-cli`, beta flags come from `computeBetas`, and the `user-agent` is `claude-cli/<version> (external, <entrypoint>)` unless `ANTHROPIC_USER_AGENT` overrides it. `lib/claude-auth-headers.ts:transformClaudeRequest` computes the billing block with `buildBillingHeaderValue` before `applyClaudeCodeTransforms` can move system text, and rewrites the `x-anthropic-billing-header` block.

The saved file is `$PI_CODING_AGENT_DIR/claude-code-headers.json` (schemaVersion 1, `claudeCodeVersion`; default `2.1.268` at `lib/claude-auth-config.ts:CLAUDE_CODE_VERSION`), so a successful `/claude-headers update` takes effect on the next request without a restart. `update` only queries `claude --version`; it does not discover new beta flags, billing algorithms or identity changes (`lib/claude-auth-config.ts:updateClaudeHeaders`). Graph workers named `claude-code/*` still execute the actual Claude Code CLI through ACPX; this provider is for the Pi supervisor.

---

## 13. Install, initializer, doctor, migration and uninstall

- **Install** (`extensions/pi-agent-wave/README.md` "Install"): install ACPX `0.13.2` and AgentFS `0.6.4`, then `pi install <source path>` for the retained checkout; after npm publication it will be `pi install npm:@dpugliese/pi-agent-wave`. Restart Pi after installing. There is no enablement step: a worker runs on the adapter its frozen model selects. Herdr is optional. The package binaries declared in `package.json:bin` are `pi-agent-wave-init`, `pi-agent-wave-doctor` and `pi-agent-wave-migrate`; for a checkout they are run through `node`.
- **Initializer** (`scripts/init.mjs:runInit`): writes a valid `model-routing.jsonc` from the models already in the catalog. It defaults to dry-run and `apply` is the only write mode (`scripts/init.mjs:parseArgs`). It reads `models.json` (`lib/catalog.mjs:loadCatalog`), offers only ids found under `providers.<provider>.models[].id`, and never creates providers, credentials or `models.json`. Interactive mode prompts per required tier (`tools`, `coding`, `test`, `review`, `reasoning`, `long-context`) plus the optional `local-fast` tier; `--non-interactive` requires explicit tier flags. Apply validates the generated routing through the real `policy-resolver.mjs` and `route-picker.ts` before committing, backs conflicting originals up under `migration-backups/`, and `rollback --manifest` restores them byte-for-byte (`scripts/init.mjs:runInit`, `runRollback`, `validateViaResolver`, `validateViaRoutePicker`).
- **Ledger installer** (`scripts/install-ledger.mjs:runInstallLedger`, bin `pi-agent-wave-install-ledger`): installs `<agent dir>/scripts/delegate-ledger`, a mode-755 launcher (`launcherText`) that `exec`s the shipped `scripts/delegate-ledger`, which runs `scripts/story-ledger.mjs` beside it. Dry-run by default; `apply` creates, reports `no-change` for identical bytes and mode, refuses a differing file without `--force`, and records a `lib/safe-write.mjs` backup before every write; `rollback --manifest` restores the previous file or removes a created launcher. Separate from the initializer because the initializer's `--force` also rewrites `model-routing.jsonc`.
- **Doctor** (`scripts/doctor.mjs:runDoctor`): read-only. It checks agent-directory resolution, catalog readability, routing JSONC, the six required tiers and roles, non-empty chains, catalog membership, local-model loopback validity, pi-fzf targets, package entry points, and real `policy-resolver` / `route-picker` execution. Its `route-credentials` section names the executing agent for every routed model and whether that agent's credential store is structurally usable (`scripts/doctor.mjs:agentForModel`, `inspectRouteCredential`). It exits nonzero only on a required failure; absent pi-fzf is a warning. Output redacts credential-bearing fields.
- **Migration from a loose install** (`scripts/migrate.mjs:runMigration`): defaults to dry-run and moves conflicting loose extensions to `migration-backups/pi-agent-wave/`, records a manifest, enables the package source in `settings.json` (`scripts/migrate.mjs:settingsWithPackage`), and repairs the pi-fzf `route` / `delegate-model` commands to the installed `route-picker.ts` (`scripts/migrate.mjs:rewriteFzf`). Rollback restores byte-for-byte (`validateRollbackManifest`, `rollback`). The Herdr-managed file `extensions/herdr-agent-state.ts` is deliberately excluded from the conflict set (`scripts/migrate.mjs:HERDR_MANAGED_PATH`).
- **Uninstall** (`extensions/pi-agent-wave/README.md` "Uninstall"): `pi remove <source>`. Removing the package does not remove Herdr, routing configuration, migration backups, or stored Delegate Graph runs. If a loose-install migration was applied, run its rollback first.

---

## 14. Storage and retention

`store.ts:DEFAULT_GRAPH_HOME` / `DEFAULT_DB_PATH` place the store at `~/.local/share/delegate-graph/delegate-graph.db`; `DELEGATE_GRAPH_DB` overrides it. The home is deliberately not a cache directory (`store.ts` comment): the store is the single source of truth for a story's execution record while `prune` cascades, so a reclamable location would make the trail deletable as scratch. The store is created mode 600 with WAL and a busy timeout (`store.ts:GraphStore` constructor, `ensurePrivatePath`), and `CURRENT_SCHEMA_VERSION` is 12 (`store.ts:CURRENT_SCHEMA_VERSION`).

- `runtime-content/` beside the database holds content-addressed copies of retained answers, staged files and manifests (`lib/runtime-content.ts:RuntimeContentStore`). It is not reclaimed by `prune` (`store.ts:prune` deliberately leaves it).
- `evidence/<runId>/` holds the records `collect` retains before removing the transient run directory: settlement evidence, cleanup evidence, the capture stream, and a failure bundle found during collection (`store.ts:retainRunEvidence`, `index.ts:finalizeRunDirectory`). The reported paths resolve while the run exists.
- `failures/<runId>/` holds `unlaunched-<operationId>.json` diagnostics for operations that were never dispatched (`store.ts:retainRunDiagnostic`, `index.ts:settleUnlaunchedOperation`).
- `/tmp/delegate-graph-herdr-<run>-<operation>.*/` is one operation's private run directory, mode 700, removed when that operation settles (`index.ts:finalizeRunDirectory`). A dispatch that never registers a worker removes the directory it created (`index.ts:discardUnlaunchedRunDirectory`). Private run directories are pinned under `/tmp` on purpose and never use `TMPDIR`.
- `runtime-integration-staging/` holds journal staging on the same filesystem as the workspace (`lib/runtime-integration.ts:RuntimeIntegration`).

`/graph prune <days>` (`store.ts:prune`) deletes `terminal`, `blocked` and `cancelled` runs older than the cutoff and reclaims their evidence, never-dispatched diagnostics, and the transient run directory of every operation that registered a worker (resolved exactly from `agents.acpx_cancel_script`, before the rows are deleted). The story ledger tables (`ledger_entries`, `ledger_claims`, `ledger_aggregates`) hold **no foreign key to `runs`**, so the story's record survives the run; a settled outcome in the database may name a path that stops resolving once its run is pruned. `store.ts:recordLedgerEntry` computes the sequence inside the insert transaction and the unique index refuses a duplicate rather than allowing a gap; `store.ts:auditStoryLedger` recomputes each aggregate's percentage and reports `AGGREGATE_MISMATCH` (plus `LEDGER_EMPTY`, `SEQUENCE_GAP`, `AGGREGATE_INVALID`). `/graph ledger` is a derived read-only view of one run (`store.ts:runtimeLedger`) and is consulted by no gate.

---

## 15. Security and credential handling

Pi extensions run with the user's full system access (`extensions/pi-agent-wave/README.md` "Security"; root `README.md` "Security"). The package bundles no external runtimes, credentials, user settings, databases or generated evidence (`package.json:files`).

- **Credential preflight** (`scripts/delegate_core.py:preflight_agent_credentials`) checks the store of the agent that will execute the model, never another agent's. The three copies of that mapping must agree: `scripts/delegate_core.py:agent_for_model`, `scripts/doctor.mjs:agentForModel` and `lib/acpx-select.ts:selectAcpAgent`. Pi providers are checked with `pi auth check --provider <p> --json --no-refresh`; Codex with `CODEX_HOME/auth.json` (`OPENAI_API_KEY` or `tokens.access_token`); Claude with a mode-600 `PI_CLAUDE_OAUTH_TOKEN_FILE` or `~/.claude/.credentials.json`.
- **Materialization**: `scripts/delegate_core.py:materialize_pi_credentials` writes an attempt-private mode-600 `auth.json` holding only the selected provider's entry (`materialize_credential_file`, `write_private_bytes`). The live `~/.pi/agent/auth.json` is never linked into an attempt; Codex and Claude credentials are copied the same way (`copy_credential_file`). Only the executing agent's configuration is delivered, as mode-600 regular-file snapshots (`copy_runtime_file`); Pi's `models-store.json` is a mutable catalog copy, and nothing is delivered as a symlink.
- **Claude self-writes**: Claude's attempt copies of `settings.json` and `.claude.json` are tolerated self-writes; `scripts/delegate_core.py:verify_provider_links` requires them still to be a mode-600 JSON object and records every change as `configurationSelfWrites`, never a boundary failure. Every other snapshot keeps exact bytes.
- **Failure redaction**: `scripts/delegate_core.py:redact_failure_text` masks credential-shaped material in failure bundles, and `without_target_paths` reduces absolute paths to basenames. The doctor's `route-credentials` output names the agent and remedy, never a token value.
- **Private files**: settlement evidence, results, captures, tokens and run directories are created mode 600/700 (`write_private_bytes`, `lib/runtime-content.ts:RuntimeContentStore`, `scripts/runtime-settle.ts:publishEvidence`). `publishEvidence` writes a private temporary file, fsyncs it, and links it into place exclusively, so a crash leaves a replayable absence rather than a truncated record.
- **Headless notifications**: user notification is in-session only (`ctx.ui.notify`); no modal dialogs, speech or sounds. `index.ts:notifyExhausted` returns early outside the TUI, and a retry-exhausted run parks for an operator decision instead of blocking on a desktop prompt.

---

## 16. Known limitations

These are recorded in `extensions/pi-agent-wave/README.md` "Known limitations" and reproducible from the code:

- **Absolute host paths escape the sandbox.** Inside `agentfs run` on this host, a process that changes into an absolute host path writes to the host outside the overlay, invisible to the ownership audit (`scripts/delegate_core.py:operational_instruction` doc comment; `AGENTS.md`). Workers are told to stay in `.`; a declared checkpoint that exists on the host with no overlay change fails settlement (`scripts/runtime-settle.ts:observeCheckpoint`). A general confinement guard is open.
- **Adapter provenance.** Pi is proven end to end on the build, research and operations graphs; Codex is proven on the research, build and operations graphs; Claude has passed the adapter probe but has not run a graph (`extensions/pi-agent-wave/README.md` "Adapters"). Codex without a terminal has no file access, which only the evidence-only review gate removes (`AGENTS.md`).
- **Quality is not measured.** The measurement driver accepts candidates automatically; independent review of a candidate remains the caller's decision (`extensions/pi-agent-wave/README.md` "Verification tooling", "Known limitations").
- **Empty captures.** A worker that exits without a candidate is a transient `worker-empty-answer` failure replaced by `op=retry`, and its raw stream is retained for diagnosis (`retry.ts:TRANSIENT_PATTERNS`; `scripts/delegate_core.py:retain_incomplete_capture`). The underlying cause is not always known.
- **Dispatch identity is reserved at registration, not before launch.** A crash between the launcher's start and the attempt's registration leaves a launched worker with no attempt row, settled through `cancel` (`store.ts:beginRuntimeAttempt`; `extensions/pi-agent-wave/README.md` "Known limitations").
- **Live proofs need a capable host**: AgentFS loopback binding and mounting, process inspection, provider credentials, and explicit authorization to spend credits (`extensions/pi-agent-wave/README.md` "Known limitations").
- **Windows is unsupported.** `scripts/headless_supervisor.py` requires the private PTY executable `script`; `scripts/doctor.mjs` fails `agentfs-platform-sandbox` outside `darwin`/`linux` (`scripts/doctor.mjs` platform check); and AgentFS `0.6.4`, a hard requirement, needs FUSE and Linux mount namespaces (`extensions/pi-agent-wave/README.md` "Watching a worker").

---

## How this document was sourced

Every claim above was read from the current tree at git `50f05b5` and cites the file and symbol it came from. The primary sources read in full or in the cited regions were `types.ts`, `graph-core.ts`, `retry.ts`, `contract.ts`, `commands.ts`, `index.ts`, `store.ts`, `agent-list.ts`, `questionnaire.ts`, `herdr.ts`, `model-failover.ts`, `claude-code-auth.ts`, `route-picker.ts`, `scheduler.ts`, `delegation-identity.ts`, `cmux-session.ts`, the `require-*.ts` guards, `lib/` (`acpx-types`, `acpx-select`, `worker-transport`, `live-stream`, `pane-read`, `runtime-results`, `claude-auth-config`, `claude-auth-headers`, `model-failover-native`, `routing-template`), `scripts/` (`delegate.ts`, `delegate_core.py`, `headless_supervisor.py`, `stream_endpoint.py`, `runtime-settle.ts`, `init.mjs`, `doctor.mjs`, `migrate.mjs`, `policy-resolver.mjs`, `acpx-plan.ts`), `package.json`, and both READMEs. The retained plan answer and the PRD tree were treated as a checklist, not as a source; neither was modified. `specification.md`, `AGENTS.md`, the READMEs and all code were left untouched.