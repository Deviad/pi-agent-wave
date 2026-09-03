# PRD: Production ACPX-only worker backend with transport adapters

## Overview

Replace pi-agent-wave's current direct Pi worker launch with ACPX as the only worker execution and session-control backend and run every ACPX worker inside a Turso AgentFS copy-on-write sandbox. The implementation proven by this PRD used Herdr presentation; `tasks/prd-air-controlled-editor-independent-orchestration.md` now governs extraction of the same lifecycle into headless and optional Herdr adapters.

Every package entry point must require the externally installed, tested ACPX and AgentFS releases before registration. Headless entry points must not require Herdr; the optional Herdr adapter must require a working Herdr workspace before launch. Each graph operation attempt receives one isolated ACPX session and one isolated AgentFS overlay, presented through one dedicated Herdr tab and agent identity. The first production slice supports the ACPX `pi`, `codex`, and `claude` adapters. It preserves the public `/delegate`, `/graph`, and `delegate_graph` contracts, graph topology, frozen model policy, retries, evidence gates, and transport-aware settlement guarantees.

This PRD is the production handoff required by `tasks/prd-acpx-headless-worker-spike.md` and the safety baseline for `tasks/prd-air-controlled-editor-independent-orchestration.md`. It must be linked from the package umbrella issue `tasks/prd-package-delegate-graph.md` before implementation begins.

## Implementation Status

- Attempt 1: five disjoint Herdr implementation workers launched with `opencode-go/deepseek-v4-pro`; all settled without a report or file edit. Report repair failed, all worker tabs were closed, and the preserved working tree remained unchanged.
- Attempt 2: the same five slices were re-dispatched with `opencode-go/glm-5.2`; all again settled without a report or file edit. Report repair failed, worker tabs were closed, and the working tree remained unchanged.
- Attempt 3: circuit breaker engaged. Serial supervisor implementation completed the mandatory runtime prerequisite, typed routing/events, schema v4, AgentFS sandbox/audit/export, worker, settlement, and Herdr bridge slices with focused tests. ACPX `0.13.2` policy rules were verified to match only tool kind/name/title tokens, not filesystem paths, so the user selected Turso AgentFS as the preventative ownership boundary. Real Codex rehearsals proved Codex requires writable provider-local SQLite state and that state cannot run reliably on the AgentFS macOS NFS overlay. AgentFS therefore covers the repository copy-on-write, while the private allowed attempt directory contains disposable writable provider runtime homes whose minimal credential/config inputs are read-only symlinks to the real homes. No credential file is copied, symlink targets remain read-only, and the entire private runtime is removed.
- Codex real matrix: PASS. The third isolation design completed a real report-only turn, validated the report, produced zero substantive repository changes after filtering identical AgentFS copy-ups, exported nothing, closed the ACPX session, verified credential-link targets, removed the AgentFS attempt directory, and closed only its Herdr tab.
- Pi real matrix with revised mechanism: PASS. When the authenticated Pi ACP attempt exited 0 with structured `end_turn` and no file, the supervisor generated a canonical PASS report whose sole verified claim states only those execution facts, explicitly identifies supervisor projection, ignores assistant free text, and makes no semantic task claim. AgentFS reported zero substantive changes and cleanup passed.
- Claude real matrix with revised mechanism: PASS. The user completed `claude setup-token`; the token was extracted without entering conversation context into a mode-600 ephemeral file. Production accepted only its `PI_CLAUDE_OAUTH_TOKEN_FILE` path, passed the token only as `CLAUDE_CODE_OAUTH_TOKEN`, and the real report-only plus active-cancellation/reconnect/close matrix passed. Token containment checks found no value in argv, Herdr state, config/result files, logs, reports, or evidence, and the ephemeral file was deleted.
- Remediation is split into `tasks/prd-production-acpx-lifecycle-hardening.md`, `tasks/prd-production-acpx-final-audit.md`, and the final source slice `tasks/prd-production-acpx-final-source-hardening.md`; the parent remains blocked until all pass.
- Final review attempt count: 3 for the original review slice. Attempt 1 returned a valid FAIL report with actionable findings; those findings were addressed. Attempts 2 and 3 failed before report under tool-class restrictions. The circuit breaker split and simplified the review slice: read-only means no host export, not no overlay writes. Simplified review attempt 1 returned a valid FAIL report; its findings were addressed with complete shared identity, observed Herdr/settlement evidence, structured close results, preventative credential tests, database constraints, package/install/doc fixes, and durable matrix tests. Simplified review attempt 2 returned a valid FAIL report; its findings were addressed with the full shared attempt key, observed Herdr pane/identity evidence, structured cancel/close cleanup failures, focus-time pane cancellation, database triggers and direct v4 repair, pycache exclusion, installed runtime-gate checks, and expanded lifecycle documentation. Simplified review attempt 3 returned a valid FAIL report. The final-review circuit breaker is exhausted; stop re-attempting.

## Goals

- Make ACPX `0.13.2` and AgentFS `0.6.4` mandatory external runtime prerequisites alongside Herdr for every package entry point.
- Run every delegated worker through ACPX; retain no direct-Pi worker execution mode or rollout switch.
- Support ACPX `pi`, `codex`, and `claude` agents with deterministic frozen-route selection.
- Give every operation attempt its own persistent ACPX session, AgentFS overlay session, and complete graph/ACPX/AgentFS/Herdr provenance.
- Keep live worker progress visible and focusable in a dedicated Herdr tab throughout execution.
- Reconcile process exit, ACPX session state, Herdr visibility, report validity, graph state, and ledger state independently before settlement.
- Preserve package portability, public command/tool contracts, graph behavior, and existing installation and migration guarantees.

## User Stories

### US-001: Require and diagnose ACPX and AgentFS runtimes

**Description:** As an operator, I want package loading and diagnostics to verify the real ACPX and AgentFS runtimes so that no graph can start with a missing, incompatible, or unsandboxed execution backend.

**Acceptance Criteria:**

- [x] Every package entry point refuses registration before calling any Pi registration API when `acpx` or `agentfs` is missing, either version probe fails, ACPX is not exactly `0.13.2`, AgentFS is not exactly `0.6.4`, Herdr is missing, or Herdr workspace identity is incomplete. Proof: named cases in a new `extensions/pi-agent-wave/test/acpx-requirement.test.ts` exercise `index.ts`, `questionnaire.ts`, `cmux-session.ts`, and `model-failover.ts`.
- [x] A new package-root `require-runtime.ts` owns the combined Herdr, ACPX, and AgentFS registration gate. Its package-private ACPX and AgentFS helpers invoke `acpx --version` and `agentfs --version` through direct executable/argv boundaries with `shell: false`; package load never downloads, installs, mounts, or invokes agents. The misleading `require-herdr.ts` name is retired. Proof: executor-spy assertions in `herdr-requirement.test.ts`, `acpx-requirement.test.ts`, and `agentfs-requirement.test.ts`.
- [x] `extensions/pi-agent-wave/scripts/doctor.mjs` reports separate ACPX executable/version, AgentFS executable/version/platform-sandbox, and Pi/Codex/Claude adapter checks in human and `--json` output. Adapter checks are bounded dispatch-readiness probes and never print credentials. Proof: focused doctor assertions in a new `extensions/pi-agent-wave/test/acpx-doctor.test.ts`.
- [x] User-facing installation guidance names ACPX and AgentFS as external prerequisites, pins both tested releases, and gives install plus version-verification commands without claiming either is bundled. Proof: documentation assertions in `extensions/pi-agent-wave/test/package-docs.test.ts` against `README.md` and `extensions/pi-agent-wave/README.md`.
- [x] `cd extensions/pi-agent-wave && npm run typecheck` passes after prerequisite and doctor changes. Proof: successful command output recorded in this PRD's verification section.

### US-002: Freeze agent selection and per-attempt session identity

**Description:** As a supervisor, I want the frozen model route to determine one ACP agent and one session identity per operation attempt so that retries, fallbacks, and concurrent slices cannot leak context.

**Acceptance Criteria:**

- [x] The new `extensions/pi-agent-wave/lib/acpx-types.ts` defines `AcpAgent` as an immutable, identity-free finite Value Object derived from the readonly allowed set `pi`, `codex`, and `claude`; the type remains local to the delegation bounded context. Proof: `extensions/pi-agent-wave/test/acpx-routing.test.ts` verifies the allowed set, value equality, immutability, and rejection of unsupported agents.
- [x] Frozen models with provider prefix `openai-codex/` select ACPX `codex`; models with prefix `claude-code/` select ACPX `claude`; every other currently valid frozen model selects ACPX `pi`. Selection occurs once before launch and is stored with the frozen route rather than recomputed by the worker. Proof: table-driven assertions in `acpx-routing.test.ts` cover every provider prefix present in the real model-routing fixtures.
- [x] `AcpxAttemptIdentity` is an immutable Value Object containing graph run ID, operation ID, role, model attempt, transient attempt, selected model, ACP agent, deterministic ACPX session name, Herdr agent, and Herdr tab ID. Proof: equality, immutability, uniqueness, and serialization assertions in `acpx-routing.test.ts`.
- [x] The session name is deterministic from `(runId, operationId, modelAttempt, transientAttempt)` and distinct across operations, same-model retries, and cross-model fallbacks. Report-repair prompts within one operation attempt reuse that attempt's session. Proof: collision and reuse cases in `acpx-routing.test.ts`.
- [x] Agent and session selection do not add or change fields in the public `/delegate`, `/graph`, or `delegate_graph` schemas. Proof: existing contract assertions in `extensions/pi-agent-wave/test/commands.test.ts` remain byte-for-byte green and a schema snapshot assertion is added there.

### US-003: Execute every worker through ACPX

**Description:** As a user, I want every worker launched through ACPX so that session control, cancellation, reconnect, and structured output use one production mechanism.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/scripts/herdr_delegate.py start` always launches a package-owned ACPX worker entry point and contains no branch that starts a direct `--kind pi` Herdr agent. Proof: source-level prohibition plus start-argv assertions in a new `extensions/pi-agent-wave/test/acpx-worker-launch.test.ts`.
- [x] A new packaged `extensions/pi-agent-wave/scripts/acpx-worker.ts` invokes the external `acpx` executable with an argv array, explicit `PATH`/Node environment, bounded timeout, strict JSON output, frozen selected model, selected `pi`/`codex`/`claude` agent, deterministic session name, task file, and report contract. It never interpolates task, model, path, or policy data into a double-quoted shell command. Proof: deterministic executable-spy cases in `acpx-worker-launch.test.ts`.
- [x] The exact persisted launcher used in production is rehearsed end to end against `extensions/pi-agent-wave/test/support/acpx-fixture.mjs`, proving launch-before-log ordering, environment assignment before launch, live stdout/stderr forwarding, separate capture files, and child exit-code propagation. Proof: named mechanism case in `extensions/pi-agent-wave/test/acpx-worker-launch.test.ts`.
- [x] Before ACPX launch, the supervisor creates one AgentFS `0.6.4` copy-on-write overlay with the repository as its base, runs through `agentfs run --session <attempt-key> --no-default-allows`, and allows host writes only to the private attempt directory containing report/config/result artifacts and disposable provider runtime homes. Minimal provider credential/config inputs are symlinked read-only from the real homes; they are never copied. ACPX tool policy still denies unknown tool classes, but AgentFS is the preventative filesystem boundary. Proof: exact argv, sandbox, and host-write denial cases in new `agentfs-sandbox.test.ts` and `acpx-permissions.test.ts`.
- [x] Pi, Codex, and Claude receive the same semantic task/report schema. Writable nodes export only declared owned paths after audit. Read-only nodes may use normal tools entirely inside AgentFS COW, but every overlay change is recorded and discarded and zero repository paths are exported; only the private report path can change on the host. When Pi exits 0 with structured `end_turn` but no file, the supervisor may generate a canonical execution-only report whose sole verified claim states the process, session, and terminal facts and identifies supervisor projection; Pi assistant free text is ignored. Agent-specific model/auth/report mechanics are confined to typed adapter functions. Proof: three adapter argv/auth/report snapshots and projection boundary cases in `acpx-worker-launch.test.ts`.
- [x] A same-model retry or cross-model fallback closes the prior ACPX session and AgentFS overlay and launches new attempt-scoped sessions; no fallback invokes the retired direct worker path or reuses a prior overlay. Proof: retry/fallback cases in `extensions/pi-agent-wave/test/acpx-failover.test.ts`.

### US-004: Preserve mandatory Herdr visibility and focus

**Description:** As a user, I want each ACPX worker represented by one stable Herdr identity so that ACPX never becomes an invisible background transport.

**Acceptance Criteria:**

- [x] The Herdr tab is created before sandboxed ACPX starts, and graph run, operation, role, policy digest, selected model, ACP agent, ACPX session, AgentFS session/database, Herdr agent, pane, and tab are persisted before the graph operation can be recorded as running. Proof: ordering assertions in a new `extensions/pi-agent-wave/test/acpx-herdr-bridge.test.ts` and persisted fields in the transport state fixture.
- [x] Live ACPX NDJSON updates are forwarded to the dedicated Herdr tab without generic text scanning deciding lifecycle or settlement. Proof: ordered progress fixtures in `acpx-herdr-bridge.test.ts` and typed event assertions in `acpx-events.test.ts`.
- [x] `focusRegisteredAgent` focuses the exact persisted Herdr agent while its ACPX session is `alive`; a missing agent, tab, pane, session identity, or identity mismatch cancels the ACPX attempt and fails the running registration closed. Proof: positive focus and each mismatch case in `acpx-herdr-bridge.test.ts`.
- [x] Closing, cancellation, failure, retry, and cleanup release only the owned Herdr agent and tab. Unrelated workspace tabs remain unchanged. Proof: targeted cleanup assertions in `acpx-herdr-bridge.test.ts` and the real three-agent matrix rehearsal.
- [x] Herdr remains the only `VisibleTransport` value and no panel, invisible-worker, or background-only fallback is introduced. Proof: `extensions/pi-agent-wave/test/herdr-requirement.test.ts`, `extensions/pi-agent-wave/test/package-artifact.test.ts`, and a repository source scan all pass.

### US-005: Map ACPX state and settle the graph fail-closed

**Description:** As a maintainer, I want structured ACPX state reconciled with existing graph and evidence state so that process success or assistant text alone can never complete work.

**Acceptance Criteria:**

- [x] New `extensions/pi-agent-wave/lib/acpx-events.ts` parses ACPX `0.13.2` strict JSON-RPC into typed started, progress, completed, cancelled, and failed events without `any`, unchecked casts, ignored type errors, or success decisions based on free text. Proof: fixture and sanitized real-transcript cases in a new `extensions/pi-agent-wave/test/acpx-events.test.ts` plus strict standalone TypeScript compilation.
- [x] ACPX client/runtime states `idle`, `alive`, and `no-session` are modeled separately from graph operation states. Unknown or version-incompatible state values block settlement with a structured diagnostic. Proof: exhaustive state-table cases in `acpx-events.test.ts`.
- [x] Process exit, terminal ACP event, ACPX status, Herdr identity/visibility, report existence and schema audit, graph operation state, and evidence-ledger audit are checked independently. Completion is recorded only when every required signal agrees. Proof: one-positive and one-negative-per-signal cases in `extensions/pi-agent-wave/test/acpx-settlement.test.ts` using a temporary GraphStore database.
- [x] GraphStore schema v4 adds nullable package-private attempt provenance columns to `agents`: `acp_agent`, `acpx_record_id`, `acpx_session_id`, `acpx_state`, `acpx_attempt_key`, `agentfs_session_id`, `agentfs_db_path`, and `herdr_pane_id`. Migration is idempotent, preserves v1-v3 databases, and rejects inconsistent partial identity. Proof: schema, upgrade, interrupted-migration, and constraint cases in a new `extensions/pi-agent-wave/test/acpx-store-migration.test.ts`.
- [x] The ACPX provenance migration changes no public tool schema and retains existing Herdr, policy, model, report, retry, and event provenance. Proof: existing `store.test.ts`, `commands.test.ts`, and new round-trip assertions all pass.
- [x] Accepted, blocked, cancelled, and failed ACPX outcomes produce evidence-bearing ledger entries; idempotent re-observation cannot settle one operation twice. Proof: `acpx-settlement.test.ts` and the existing ledger audit command pass.

### US-006: Handle retries, report repair, cancellation, and cleanup

**Description:** As an operator, I want every failure path bounded and recoverable so that ACPX sessions, child processes, and Herdr tabs cannot leak across graph attempts.

**Acceptance Criteria:**

- [x] Same-model transient retry increments the existing transient attempt, closes the old session, and creates a new session with unchanged model attempt. Cross-model fallback increments model attempt, may select a different ACP agent, and creates a new session. Proof: state and argv assertions in `acpx-failover.test.ts`.
- [x] Report-repair prompts reuse the current operation-attempt session and remain bounded by the existing repair cap; a retry or fallback never reuses that session. Proof: repair/retry boundary cases in `acpx-failover.test.ts`.
- [x] Cancellation sends ACPX cancel to the exact persisted session, waits for a structured cancelled terminal event or bounded timeout, closes the named session, releases the exact Herdr identity, and records the graph outcome. Proof: cancellation-order assertions in `acpx-settlement.test.ts`.
- [x] ACPX crash, malformed NDJSON, queue-owner death, closed Herdr tab, report-audit failure, and cleanup failure each block or fail the operation without advancing a graph join. Proof: named adversarial cases in `acpx-settlement.test.ts`.
- [x] Cleanup is idempotent and proves the ACPX process, queue owner, session files, AgentFS mount/server/database/temp HOME, report-repair child, Herdr agent, and Herdr tab are absent while unrelated resources remain. Proof: repeated-cleanup and process-audit cases in `acpx-herdr-bridge.test.ts`.
- [x] The three-attempt circuit breaker applies independently to implementation defects found during this story; retry machinery is simplified or split rather than extended after the cap. Proof: attempt count is maintained in this PRD's implementation status and final verification section.

### US-007: Prove portability, migration, documentation, and the real agent matrix

**Description:** As a package maintainer, I want production ACPX behavior proven across packaging and all three supported agents so that the release claim matches what actually runs.

**Acceptance Criteria:**

- [x] `tasks/prd-package-delegate-graph.md` links this PRD and records ACPX-only execution, mandatory external ACPX `0.13.2`, Pi/Codex/Claude scope, private schema v4, and unchanged public contracts before implementation code is written. Proof: exact link and scope assertions in `extensions/pi-agent-wave/test/package-docs.test.ts`.
- [x] A bounded real matrix executes one harmless report-only task through ACPX `pi`, `codex`, and `claude`, each inside a temporary AgentFS overlay with temporary ACPX/AgentFS HOME, one dedicated Herdr tab, structured completed transcript, validated report, owned-path-only export, targeted cleanup, and no credential value in artifacts. A missing authenticated adapter blocks the criterion rather than using a fixture. Proof: `extensions/pi-agent-wave/test/acpx-real-matrix.test.ts` and sanitized artifacts under `agent-output/production-acpx-worker-backend/`.
- [x] The real matrix proves one active cancellation and reconnect for each supported agent, or records an adapter-specific blocker that prevents completion of this PRD. Proof: named Pi, Codex, and Claude cases in `acpx-real-matrix.test.ts`.
- [x] `npm pack --dry-run --json --ignore-scripts` and `npm publish --dry-run --json --ignore-scripts` contain the production ACPX/AgentFS integration files and exclude ACPX, AgentFS, test support, overlay databases, raw transcripts, temporary homes, credentials, and generated evidence. Proof: `extensions/pi-agent-wave/test/package-artifact.test.ts`.
- [x] The npm-tarball and loopback-Git installation rehearsals load all real Pi versions already covered by `package-install-rehearsal.test.ts`, fail package registration when ACPX is absent or mismatched, and register normally when ACPX and Herdr are complete. Proof: expanded `extensions/pi-agent-wave/test/package-install-rehearsal.test.ts`.
- [x] `README.md`, `extensions/pi-agent-wave/README.md`, and doctor output document ACPX-only execution, the exact supported ACPX and adapter scope, install/upgrade/diagnosis, session ownership, cancellation, cleanup, and the absence of JetBrains Air integration. Proof: `package-docs.test.ts`.
- [x] Completion gates pass without weakened assertions: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, the package-focused Bun matrix, `cd extensions/pi-agent-wave && npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, `npm publish --dry-run --json --ignore-scripts`, the real installation rehearsal, the real Pi/Codex/Claude matrix, ledger audit, and `git diff --check`. Proof: exact outputs recorded in this PRD's final verification section.

## Functional Requirements

- FR-1: The system must use ACPX as the only worker execution and session-control backend; no legacy direct worker execution option may remain.
- FR-2: Herdr must remain the only visible transport and every running ACPX worker must have complete, verified Herdr identity.
- FR-3: Every package entry point must require real ACPX `0.13.2`, real AgentFS `0.6.4`, real Herdr, and complete Herdr workspace identity before registration.
- FR-4: Package load must not download ACP adapters or perform authentication; bounded adapter readiness belongs to doctor and dispatch preflight.
- FR-5: The first production slice must support exactly ACPX `pi`, `codex`, and `claude`.
- FR-6: Frozen model selection must deterministically select and persist the ACP agent before launch.
- FR-7: Every operation attempt must receive exactly one deterministic ACPX session and one deterministic AgentFS overlay session; neither may be shared across operations, retries, fallbacks, or concurrent slices.
- FR-8: Report repair within an operation attempt must reuse that attempt's session and remain bounded by the existing repair cap.
- FR-9: All subprocesses must use direct executable/argv boundaries or a persisted script executed directly; worker input must not cross an interpolated shell string.
- FR-10: ACPX must run through AgentFS copy-on-write sandboxing with explicit executable environment, bounded timeout, strict JSON output, generated tool policy, frozen model, private attempt directory, and `--no-default-allows`.
- FR-11: Worker identity must retain graph, policy, model, attempt, ACP agent, ACPX record/session, AgentFS session/database, and Herdr provenance.
- FR-12: Typed event parsing must preserve structured ACP JSON-RPC; assistant free text must not decide success, permission, or settlement. Read-only execution runs entirely inside AgentFS COW, records and discards every overlay change, exports zero repository paths, and writes only the private validated report on the host. Pi supervisor projection is allowed only after process exit 0 plus structured `end_turn`; its claim must be limited to those facts, identify supervisor projection, and use the graph node's canonical positive verdict.
- FR-13: ACPX runtime states and graph operation states must remain separate types and separate persisted evidence.
- FR-14: Completion must require agreement among process, ACPX terminal event/status, Herdr visibility, report audit, graph state, and ledger audit.
- FR-15: Unknown state, malformed output, identity mismatch, missing visibility, or failed cleanup must fail closed.
- FR-16: Cancellation, retry, fallback, crash, report repair, export, and cleanup must target only the exact operation-attempt ACPX session, AgentFS overlay, and Herdr resources.
- FR-17: Private schema v4 migration must be idempotent and backward compatible with existing package databases.
- FR-18: Public `/delegate`, `/graph`, and `delegate_graph` names, input schemas, graph topology, retry policy, evidence gates, and model-policy semantics must remain compatible.
- FR-19: ACPX, AgentFS, ACP adapter packages, overlay databases, credentials, raw transcripts, and generated evidence must remain external to the npm artifact.
- FR-20: Generated evidence must contain structured sanitized events and hashes, never credential values, provider response bodies, unnecessary prompts, or user-home transcripts.
- FR-21: JetBrains Air must remain outside production behavior and configuration.
- FR-22: The canonical package PRD must link and authorize this feature before implementation.

## Non-Goals

- Add a rollout switch, legacy worker opt-out, direct-Pi execution fallback, panel transport, or invisible background worker path.
- Support ACPX agents other than Pi, Codex, and Claude in this slice.
- Share an ACPX session across operation attempts, graph operations, roles, or concurrent slices.
- Bundle ACPX, AgentFS, or ACP adapter packages inside `@dpugliese/pi-agent-wave`.
- Add or rename public commands, change the public `delegate_graph` tool schema, alter graph topology, or weaken retries and evidence gates.
- Integrate JetBrains Air or claim external-session attachment support.
- Publish npm, apply a real migration, alter the real Pi installation, commit, push, or merge without explicit authorization.
- Treat fixtures as proof that a reachable Pi, Codex, Claude, ACPX, Herdr, npm, Git, SQLite, or Pi loader dependency works.

## Design / Technical Considerations

- Centralize mandatory external runtime registration checks in new `extensions/pi-agent-wave/require-runtime.ts`; every entry point imports it, while `require-acpx.ts` and `require-agentfs.ts` remain focused version probes. Remove `require-herdr.ts` and update package-artifact/docs tests in the same change.
- Keep Herdr transport ownership in `extensions/pi-agent-wave/scripts/herdr_delegate.py`; replace its `herdr agent start --kind pi` execution seam with the package-owned `scripts/acpx-worker.ts` entry point while retaining tab creation, identity, wait, report audit, repair, and cleanup responsibilities.
- Put ACPX and AgentFS Value Objects, state types, provider-to-agent selection, attempt naming, sandbox argv construction, diff validation, and owned-path export in new package-private modules under `extensions/pi-agent-wave/lib/`. `AcpAgent` and `AcpxAttemptIdentity` are delegation-context Value Objects, not shared-kernel types.
- Invoke only the stable ACPX commands `acpx pi`, `acpx codex`, and `acpx claude`, and only through AgentFS `0.6.4` `run` with an attempt-scoped `--session` and `--no-default-allows`. ACPX `0.13.2` currently owns adapter package ranges `pi-acp@^0.0.31`, `@agentclientprotocol/codex-acp@^1.1.5`, and `@agentclientprotocol/claude-agent-acp@^0.60.0`; pi-agent-wave must not duplicate or launch those underlying package commands directly.
- Use provider prefixes already present in frozen routes for the initial internal agent mapping: `openai-codex/` to Codex, `claude-code/` to Claude, and other valid routes to Pi. Any future configurable mapping requires a separate issue.
- Extend `extensions/pi-agent-wave/store.ts` with schema v4 nullable ACPX and AgentFS provenance columns using the existing idempotent `ensureColumn` migration pattern. Require all-or-none identity at the running boundary even though legacy rows remain nullable.
- Preserve current report generation and audit in `scripts/report-prompt.ts`, `scripts/report-audit.ts`, and `scripts/ledger.ts`. ACPX completion is an input to those gates, not a replacement.
- The spike observed ACPX states `idle`, `alive`, and `no-session`; production code must model the tested vocabulary and block unknown values. It must not copy the spike's earlier unverified `running`/`idle`/`dead` sketch.
- The first spike Herdr launch failed because the GUI tab environment lacked the NVM Node path. Production launch must resolve and pass the executable environment before tab start, and the exact production launcher must be fixture-rehearsed before real dispatch.
- AgentFS itself must run with temporary `HOME` so `.agentfs/run/<attempt>` state is bounded and removable. Its COW base is the repository. `PI_CODING_AGENT_DIR`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` point to disposable writable homes under the private attempt directory. Only minimal credential/config files are read-only symlinks to real provider homes; hash/mode/target checks prove they are unchanged before cleanup. The only host-write allowlist is the private attempt directory, and export may apply only graph-owned repository paths. Credential values must never be copied into temporary homes or evidence.
- Update root and package README files in the same change. If this feature is later merged, update all applicable `dev-docs/` documentation as required by the repository workflow.

## Success Metrics

- All package entry points fail before registration when ACPX, AgentFS, or Herdr prerequisites are incomplete and register when all are valid.
- One real bounded report-only task, active cancellation, reconnect, report audit, graph settlement, and cleanup pass for each of Pi, Codex, and Claude.
- No operation is recorded running without complete graph/ACPX/AgentFS/Herdr attempt identity.
- No operation is recorded completed from process exit, ACPX status, assistant text, or report existence alone.
- No ACPX session, AgentFS mount/server/database/temp HOME, queue owner, child process, Herdr agent, or Herdr tab remains after targeted cleanup.
- No unsupported agent, legacy worker execution path, panel fallback, or JetBrains Air configuration ships.
- Public command/tool schemas and all existing graph, retry, model-policy, package, migration, and evidence tests remain green.
- Package dry-runs contain every production ACPX/AgentFS integration module and no ACPX or AgentFS dependency, overlay database, test support, raw transcript, credential, or generated evidence.

## Open Questions

- Which Pi roles require a later independent semantic reviewer because the supervisor projection proves execution only, not the semantic correctness of the assigned task?
- How should Claude setup-token expiry or revocation be surfaced when the long-lived token format exposes no local expiry timestamp?
- Do Pi, Codex, and Claude expose identical cancellation terminal events under ACPX `0.13.2`, or must the typed adapter normalize agent-specific structured variants?
- Which provider-local metadata files may legitimately change during the bounded real matrix, and what pre/post evidence is sufficient to distinguish authentication refresh from an unintended user-state mutation?

## Verification

### Implemented and proven

- Combined `require-runtime.ts` now owns Herdr, ACPX `0.13.2`, and AgentFS `0.6.4` load-time gates; the misleading `require-herdr.ts` path is removed. Focused prerequisite and doctor tests pass.
- ACPX agent/attempt/state Value Objects, provider routing, deterministic per-attempt ACPX and AgentFS session names, strict JSON-RPC parsing/sanitization, tool policy, settlement, and retry/repair boundaries are implemented and typechecked.
- AgentFS sandboxing uses `run --session <attempt> --no-default-allows`, a temporary AgentFS HOME, repository COW base, a private host-write directory, machine-readable schema `0.4` delta queries, identical-copy filtering, unowned-path rejection, and owned-only export. Real AgentFS tests prove host isolation and export.
- GraphStore schema v4 persists complete ACPX and AgentFS provenance and migrates legacy databases idempotently.
- Herdr transport no longer contains the direct `--kind pi` worker launch. The exact fake-ACPX/real-AgentFS/fake-Herdr bridge passes start ordering, identity persistence, report audit/repair, zero-violation export, session close, credential-link verification, and targeted cleanup.
- Public completion records require ACPX settlement summary through the existing payload object; public command and tool schemas remain unchanged.
- Final host audit full Node gate: 318 passed, 0 failed, 8 skipped across 326 tests. Six skips are the opt-in real lifecycle and production matrices; both separate real commands pass 3/3 with the mode-600 Claude token file.
- Package-focused Bun gate: 34 passed, 0 failed.
- `npm run typecheck`, npm pack and publish dry-runs, real package installation rehearsal, ledger audit, and `git diff --check` pass. Dry-runs contain 64 files and no bundled external runtime, test tree, database, or generated evidence.
- Final production evidence ledger: 21 files, 0 findings. Final secret scan: 52 files, 0 matches.
- All implementation, review, real-matrix, and failed-attempt Herdr tabs, AgentFS processes, and temporary matrix directories were removed; unrelated workspace tabs remained.

### Real matrix

- Codex: PASS. A real ACPX/AgentFS/Herdr report-only turn validated and settled with zero substantive repository changes, zero export violations, successful ACPX close, credential-link integrity, AgentFS cleanup, and targeted Herdr cleanup.
- Pi: PASS with user-authorized supervisor projection limited to structured process/session/end-turn evidence and explicit non-semantic provenance. Real AgentFS export and cleanup returned zero changes and zero violations.
- Claude: PASS. The contained setup-token report turn and active cancellation/reconnect/close lifecycle matrix completed with zero AgentFS owned changes or violations; the mode-600 token file and all raw captures were deleted afterward.
- Fresh observable Codex review verdict: PASS. The final bundle-completeness review verified all source-hardening fixes, both real three-agent matrices, package/install gates, source freshness, cleanup, and parent invariants.

## Decision

**PASS.**

All parent and remediation criteria pass. Final review evidence is `agent-output/production-acpx-worker-backend/final-bundle-completeness-review-pass.json`; the 21-file ledger, cleanup scan, secret scan, and `git diff --check` are green. No commit, push, publication, or pull request was performed.
