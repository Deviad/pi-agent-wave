# PRD: Air-Controlled, Editor-Independent Pi Orchestration

## Overview

pi-agent-wave must let JetBrains Air control Pi through `pi-acp` without requiring Herdr. Pi remains the initial supervisor process and extension host. The existing graph scheduler, GraphStore, ACPX worker lifecycle, AgentFS isolation, routing, settlement, reports, evidence ledger, and public `/delegate`, `/graph`, and `delegate_graph` contracts remain the foundation.

Delivery is phased and isolated in a sibling development copy at `/Users/spotted/projects/pi-agent-wave-new-design`. The existing `/Users/spotted/projects/pi-agent-wave` workspace remains available and read-only for the user's other work. Phase 1 extracts transport-neutral orchestration inside the copied Pi extension, adds a headless transport that works from Air, preserves Herdr as an optional presentation adapter, and proves the complete workflow in the installed JetBrains Air application. Phase 2 extracts a durable local daemon only after Phase 1 is stable. Phase 3 adds a local dashboard, secure remote/team operation, and additional client adapters.

This PRD changes the current Herdr-only product direction. Before implementation code changes, the parent scope records `tasks/prd-package-delegate-graph.md`, `tasks/prd-require-herdr.md`, and `tasks/prd-production-acpx-worker-backend.md` must be updated to make Herdr optional while preserving their already-proven safety guarantees.

## Goals

- Let Air launch Pi through `pi-acp` and control delegation without Herdr.
- Keep orchestration inside the Pi extension for the first usable release.
- Make headless and Herdr presentation adapters share one transport-neutral execution core.
- Return progress, questions, status, cancellation, recovery, and final evidence through Pi's ACP session.
- Preserve existing public contracts, stored runs, package compatibility, ACPX `0.13.2`, AgentFS `0.6.4`, Pi/Codex/Claude support, and optional Herdr workflows.
- Prove Phase 1 with a real local JetBrains Air end-to-end rehearsal.
- Establish explicit gates for later daemon, dashboard, remote/team, and adapter phases without building them prematurely.

## User Stories

### US-000: Create an isolated new-design workspace

**Description:** As the user, I want new architecture development isolated from the working pi-agent-wave folder so that I can continue using the current implementation for unrelated work.

**Acceptance Criteria:**

- [x] `/Users/spotted/projects/pi-agent-wave-new-design` is created as an independent copy of the current verified working tree, including current uncommitted and untracked implementation files required by the passing package, while excluding temporary files, credentials, caches, `node_modules`, generated package archives, and live runtime state; proof is a source-manifest comparison recorded under the new folder's `agent-output/air-headless-orchestration/`.
- [x] The new folder has independent Git metadata and reports the same base commit plus an equivalent source diff at creation time; proof records `git rev-parse HEAD`, `git status --short`, and a SHA-256 manifest from both folders without changing the existing folder.
- [x] `/Users/spotted/projects/pi-agent-wave` is excluded from new-design implementation writes after copy. Independent user/agent work may legitimately change it; the final manifest records its divergence without overwriting or restoring those changes. Proof identifies new-design artifacts only under the sibling folder and records any transient mistaken writes plus their restoration.
- [x] All subsequent commands, restore points, generated evidence, and implementation-status updates use `/Users/spotted/projects/pi-agent-wave-new-design` as their working directory; no absolute runtime import may point back to the original folder.

### US-001: Record the architecture change

**Description:** As a maintainer, I want the package scope records to agree that Air/headless is supported and Herdr is optional so that implementation is judged against one coherent plan.

**Acceptance Criteria:**

- [x] `tasks/prd-package-delegate-graph.md`, `tasks/prd-require-herdr.md`, and `tasks/prd-production-acpx-worker-backend.md` link this PRD and explicitly replace the mandatory-Herdr invariant with a transport-neutral core plus optional Herdr adapter; proof is a documentation assertion in `extensions/pi-agent-wave/test/package-docs.test.ts`.
- [x] The parent PRDs preserve ACPX-only worker execution, AgentFS attempt isolation, frozen routing, graph topology, settlement gates, public command/tool schemas, migration safety, and evidence-ledger requirements; proof is `extensions/pi-agent-wave/test/package-docs.test.ts`.
- [x] Phase boundaries and attempt counts are recorded in this PRD before each phase starts; proof is the implementation-status section added during execution.

**Implementation Status:** Phase 1 attempt 3 returned FAIL on one documentation contradiction after independently verifying every prior remediation. The attempt-2 and attempt-3 FAIL reports are persisted and ledgered; the ledger audits 3 files with zero findings. The documentation-remediation split is complete: focused docs test 8/8, full Node 349/0 with 11 opt-in skips, Bun 36/0, typecheck, cleanup, both secret scans, ledger, and diff check pass. The 86-section review bundle is rebuilt and its structural test passes. Circuit breaker remains active: no attempt 4 in this slice. Final semantic review is a separate pending slice; Phase 2 and Phase 3 remain blocked until Phase 1 PASS.

### US-002: Define transport Value Objects and ports

**Description:** As a maintainer, I want transport identity represented explicitly so that headless and Herdr states cannot be confused.

**Acceptance Criteria:**

- [x] `WorkerTransportKind` is classified as an immutable, identity-free, value-equal finite Value Object implemented in `extensions/pi-agent-wave/lib/worker-transport.ts` as the frozen allowed set `headless | herdr`; `extensions/pi-agent-wave/test/worker-transport.test.ts` proves immutability, value equality, and rejection outside the allowed set.
- [x] `WorkerPresentationIdentity` is classified as an immutable tagged-union Value Object in `extensions/pi-agent-wave/lib/worker-transport.ts`: headless carries no Herdr fields, while Herdr requires agent, tab, and pane identity; focused tests prove invalid mixed or partial states are unconstructible.
- [x] A transport port in `extensions/pi-agent-wave/lib/worker-transport.ts` defines launch, wait, cancel, cleanup, progress observation, and optional focus capabilities without importing Herdr; `npm run typecheck` proves both adapters conform explicitly.
- [x] Transport-independent attempt identity retains graph run, operation, role, model attempt, transient attempt, ACP agent, ACPX session/record/attempt key, and AgentFS session/database; proof is `extensions/pi-agent-wave/test/worker-transport.test.ts`.

### US-003: Make runtime loading work without Herdr

**Description:** As an Air user, I want Pi to load pi-agent-wave without Herdr so that Air can start the extension through `pi-acp`.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/require-runtime.ts` requires only ACPX `0.13.2` and AgentFS `0.6.4` for package registration; `extensions/pi-agent-wave/test/headless-requirement.test.ts` proves package entry points load with no `HERDR_*` variables and no Herdr executable.
- [x] Explicit Herdr selection still requires the Herdr executable plus complete workspace/tab identity and fails before worker launch when incomplete; proof is `extensions/pi-agent-wave/test/herdr-requirement.test.ts`.
- [x] `extensions/pi-agent-wave/scripts/delegate.ts` accepts `auto | headless | herdr`; `auto` selects Herdr only when complete Herdr identity is present and otherwise selects headless; proof is a table-driven transport-selection test.
- [x] Package initialization and doctor output distinguish required ACPX/AgentFS prerequisites from optional Herdr capability without weakening version checks; proof is `extensions/pi-agent-wave/test/doctor.test.ts` and `extensions/pi-agent-wave/test/package-docs.test.ts`.

### US-004: Extract one transport-neutral worker lifecycle

**Description:** As a maintainer, I want headless and Herdr execution to share one ACPX/AgentFS lifecycle so that safety fixes cannot diverge.

**Acceptance Criteria:**

- [x] Transport-neutral run preparation, ACPX planning, AgentFS launch/export, structured cancellation, report audit/repair, settlement manifest, and cleanup inventory are extracted from `extensions/pi-agent-wave/scripts/herdr_delegate.py` into a shared module under `extensions/pi-agent-wave/scripts/`; source tests prove neither adapter duplicates these mechanisms.
- [x] `extensions/pi-agent-wave/scripts/headless_delegate.py` implements launch, wait, cancel, and cleanup without calling `herdr`, reading `HERDR_*`, creating tabs/panes, or inventing synthetic visibility evidence; proof is `extensions/pi-agent-wave/test/acpx-headless-transport.test.ts`.
- [x] `extensions/pi-agent-wave/scripts/herdr_delegate.py` becomes an optional presentation adapter over the same lifecycle and preserves current visible behavior; proof is `extensions/pi-agent-wave/test/acpx-herdr-bridge.test.ts`.
- [x] Both adapters execute the persisted `acpx-cancel.ts` boundary and the same granular cleanup inventory; named cancellation and cleanup adversarial suites pass for both transport kinds.
- [x] Headless execution runs one real bounded Pi, Codex, and Claude lifecycle/report matrix with zero AgentFS violations; proof is source-bound evidence under `agent-output/air-headless-orchestration/final-matrix/`. Verified 2026-09-01: `pi-headless.json`, `codex-headless.json`, and `claude-headless.json` all PASS with empty `agentFsExport.violations`, `identityMatches` and `presentationVerified` true, transport `headless`, Herdr resources/environment absent, and source digest `54c3de4770af40401efcf8ed42df85bc08c26d77dcc551e9eb2e8deadb0479e6`.

### US-005: Generalize persistence and settlement identity

**Description:** As a user with existing runs, I want stored state to support headless workers without losing Herdr-era data or weakening completion gates.

**Acceptance Criteria:**

- [x] `GraphStore` accepts `headless | herdr`, projects every new/live row into a valid `WorkerPresentationIdentity`, rejects partial Herdr identity or Herdr fields on headless rows, and exposes `presentation_identity: null` only for preserved pre-v4 legacy Herdr rows that never had ACPX/pane identity; legacy rows remain readable but are not focusable or reusable as live attempts. Proof is `extensions/pi-agent-wave/test/store.test.ts` and `extensions/pi-agent-wave/test/worker-transport.test.ts`.
- [x] Existing schema-v4 databases and Herdr rows reopen byte-semantically unchanged; any required schema migration is direct, idempotent, foreign-key-valid, rollback-safe, and covered from every supported prior version in `extensions/pi-agent-wave/test/acpx-store-migration.test.ts`.
- [x] Settlement requires process, ACPX terminal/status, report, graph, AgentFS export, cleanup, and ledger agreement for both transports; Herdr visibility is required only for Herdr attempts and is absent rather than synthesized for headless attempts; proof is positive and negative per-signal cases in `extensions/pi-agent-wave/test/acpx-settlement.test.ts`.
- [x] Existing `/graph status` and `/graph log` render headless and Herdr attempts without null leakage or misleading visibility claims; proof is `extensions/pi-agent-wave/test/commands.test.ts`.

### US-006: Expose Air-compatible control through Pi ACP

**Description:** As an Air user, I want to start, inspect, cancel, answer, retry, and resume delegated work through the Pi session Air owns.

**Acceptance Criteria:**

- [x] `delegate_graph` preserves existing operations and adds extension-owned `dispatch` and `collect` operations so an Air-launched Pi never invokes AgentFS from the model's sandboxed bash tool. `dispatch` launches/registers one pending headless attempt through `pi.exec`; `collect` waits through `pi.exec` and returns report/settlement/cleanup evidence for the existing `record` operation. Initialization, next, status, cancellation/recovery, and resume remain supported. Proof is `extensions/pi-agent-wave/test/air-acp-control.test.ts` plus the real Air rehearsal.
- [x] Air receives bounded structured progress for run creation, operation start, awaiting-user/deferred state, retry/fallback, cancellation, failure, and terminal settlement through Pi's ACP-visible messages/tool results; proof is an ordered event transcript fixture with no provider response bodies or credentials.
- [x] Interactive questions have an ACP-safe path: no terminal-only questionnaire is opened when Pi is controlled by Air, required user input is returned as structured awaiting-user state, and a subsequent Air message resumes the frozen operation; proof is `extensions/pi-agent-wave/test/air-acp-control.test.ts`.
- [x] `/delegate` and `/graph` remain functional in Pi's terminal UI, while Air can perform equivalent flows through the preserved `delegate_graph` tool even if Air does not expose Pi slash commands; proof covers both interfaces against one GraphStore fixture.
- [x] Cancellation from Air targets the exact persisted ACPX/AgentFS attempt, returns complete structured cancellation evidence, and leaves no owned process or temporary resource; proof is a real bounded headless cancellation rehearsal. Verified 2026-09-01: the earlier Air evidence (`air-e2e.json` run `run_600a4dff`) recorded incomplete cancellation (`noSession=true` only) because of two product defects — the cancel config cwd pointed at the workspace root instead of the session's AgentFS-mount cwd, and the structured observation polled a session-history surface that never carries the stop signal; both fixed in `delegate_core.py` and `acpx-cancel.ts`. Fresh bounded rehearsal `agent-output/air-headless-orchestration/cancellation-rehearsal.json` cancels a live headless attempt mid-command and records all four structured flags true (`cancelled`, `structuredCancelled`, `closed`, `noSession`), stream `stopReason: cancelled`, zero leaked processes, source digest `54c3de47…`. The Air-originated path executes the same persisted `acpx-cancel.ts` boundary and is re-exercised by the Air rehearsal re-run.

### US-007: Prove the real JetBrains Air workflow

**Description:** As a user, I want the installed JetBrains Air application to control a real Pi delegation so that support is based on the product rather than an ACP simulation.

**Acceptance Criteria:**

- [x] Air's global `acp.json` fixture launches the verified `pi-acp` package with an absolute Node/npx path and a temporary `PI_CODING_AGENT_DIR`; the test never modifies the user's production Pi home or persists provider credentials.
- [ ] The `e2e-test` skill produces `e2e/tests/test_us007_air_headless_control.py`, which drives the installed `/Users/spotted/Applications/Air.app` through a harmless temporary project and persists screenshots/transcripts proving task start, delegation, progress, status, cancellation, resume, and final report without Herdr. Substantively met, not literal: the real Air 262.579.44 drive happened and persists `air-e2e.json` plus `air-e2e-transcript.jsonl` covering start, delegation, progress, status, cancellation, resume, and final report (pytest verifier passes), but no screenshots were persisted.
- [x] The real rehearsal proves Air starts Pi as its ACP agent rather than attaching to an externally owned ACPX worker session; evidence explicitly records the Air version, `pi-acp` version, Pi version, ACPX version, AgentFS version, and sanitized argv. Verified 2026-09-01: `air-e2e.json` records Air 262.579.44, `pi-acp` 0.0.31, Pi 0.84.1, ACPX 0.13.2, AgentFS 0.6.4, the absolute npx argv, and sanitized environment values. `runtimeEvidence.provenance` states honestly that Pi version/argv were reconstructed from the persisted staging fixture after the intentionally deleted temporary Pi home; the persistent pytest verifier passes.
- [x] The rehearsal proves no Herdr process, workspace identity, tab, pane, or environment variable is required and no Herdr resource is created.
- [x] The test restores Air configuration byte-for-byte, deletes temporary ACP/Pi homes and OAuth token files, and records a zero-finding secret scan and cleanup audit.

### US-007A: Install a permanent Air agent using the main Pi installation

**Description:** As a user, I want Air's global ACP configuration to offer Pi Wave permanently through my main Pi installation so that new Air tasks can select it without staging a temporary Pi home.

**Acceptance Criteria:**

- [x] `/Users/spotted/Library/Application Support/JetBrains/Air/acp.json` preserves every existing agent server and adds exactly one `Pi Wave` server with command `/Users/spotted/.nvm/versions/node/v22.16.0/bin/npx`, args `["-y", "pi-acp@0.0.31"]`, `PI_CODING_AGENT_DIR=/Users/spotted/.pi/agent`, and a stable minimal PATH containing the installed Node, ACPX, AgentFS, Herdr, and system binaries. Proof: `apply-manifest.json` plus post-write re-read confirms one `Pi Wave` entry and unchanged `pi-acp-jetbrain` entry.
- [x] `/Users/spotted/.pi/agent/settings.json` replaces the existing original-repository package entry with `/Users/spotted/projects/pi-agent-wave-new-design/extensions/pi-agent-wave` exactly once, preserves all other settings and package order byte-semantically, and contains no duplicate pi-agent-wave entry. Proof: `apply-manifest.json` records targeted replacement; post-write re-read reports new path count 1, old path count 0, and package order preserved.
- [x] The exact Air entry and package-path migration rehearse end-to-end against temporary copies before real writes: temporary Pi settings load the new-design package and the exact absolute npx/pi-acp argv starts against a bounded harmless target. Proof: `agent-output/air-permanent-configuration/rehearsal.json` records PASS, resolved package installation, preserved existing server, and ACP initialize protocol v1.
- [x] Both real files receive private timestamped backups before atomic replacement; the final JSON files retain their original modes, contain no credential values, and rollback paths are recorded. Proof: `apply-manifest.json`; both backups exist mode 600, live files remain mode 644, and evidence secret scan reports 3 files / 0 findings.
- [x] A bounded post-install check using the permanent `Pi Wave` entry initializes Pi ACP with the main Pi installation without changing graph data, dispatching workers, or creating Herdr resources. Proof: `agent-output/air-permanent-configuration/startup-check.json` records protocol v1, unchanged graph table counts, zero Herdr resources, and zero stderr bytes.

### US-008: Preserve optional Herdr compatibility

**Description:** As an existing user, I want Herdr presentation to remain available so that the new Air path does not remove proven workflows.

**Acceptance Criteria:**

- [x] Starting Pi inside Herdr with `auto` preserves current visible tabs, focus, identity, cancellation, cleanup, and settlement behavior; proof is the existing real Herdr production matrix plus focused presentation tests. Verified 2026-09-01 after repairing the final-plan overwrite defect: source-current Pi, Codex, and Claude Herdr artifacts all PASS with real presentation identities, `identityMatches` true, `presentationVerified` true, and zero AgentFS violations; focused presentation suites pass in the Node gate.
- [x] Explicit `headless` inside a Herdr workspace creates no worker tab and returns progress through Pi only; explicit `herdr` outside a valid workspace fails closed; proof is a transport matrix test.
- [x] Existing Herdr commands and stored runs remain readable and operable after the change; proof is package installation rehearsal and direct legacy-store fixtures. Verified 2026-09-01: canonical audit installation rehearsal passes 1/1 against a real temporary installation; legacy-store reopen and schema-v5 migration fixtures pass via `acpx-store-migration.test.ts` and `store.test.ts` in the Node gate.

### US-009: Complete Phase 1 packaging, documentation, and review

**Description:** As a package user, I want Air/headless behavior shipped and documented with the same verification standard as the current Herdr-native release.

**Acceptance Criteria:**

- [x] `README.md` and `extensions/pi-agent-wave/README.md` lead with Air/headless setup through `pi-acp`, explain optional Herdr, document exact prerequisites/configuration, and do not claim npm publication before it occurs; proof is `extensions/pi-agent-wave/test/package-docs.test.ts`.
- [x] Package manifests include transport-neutral and headless runtime files while excluding tests, evidence, databases, Herdr-managed files, credentials, and external runtimes; proof is pack/publish dry-runs and `extensions/pi-agent-wave/test/package-artifact.test.ts`.
- [x] The full Node gate, focused Bun gate, typecheck, installation rehearsal, real headless and Herdr matrices, secret scan, cleanup scan, ledger audit, and `git diff --check` pass with exact expected counts recorded in this PRD. Verified 2026-09-01 by `final-audit.json`: 15 commands PASS; Node 360 tests / 349 pass / 0 fail / 11 opt-in skips; Bun 36/0; typecheck clean; pack 68 files and publish 68 files with zero external artifacts; installation rehearsal 1/1; report evidence 2/2; real lifecycle, Herdr production, and headless matrices each 3/3; setup-token cleanup deleted the private mode-600 temp token; production secret scan 52 files / 0 findings; cleanup `{"leakedTabs":[],"agentFsProcesses":0,"temporaryDirectories":[],"tokenFilePresent":false}`; pre-review ledger 1 file / 0 findings; `git diff --check` 0 bytes. Post-audit Air evidence scan is 31 files / 0 findings; after ledgering reviewer attempt 2, interim ledger audit is `PASS: audited 2 ledger files`.
- [ ] A fresh-context observable reviewer audits a source-current hash-indexed bundle with host commands executed outside AgentFS and writes a canonical `PASS` report; the report is appended to the ledger and the final ledger audit has zero findings. Attempt 3 verified cancellation, runtime evidence, Herdr identity, and the 15-command audit, then returned FAIL solely because later `extensions/pi-agent-wave/README.md` sections still claimed Air unsupported and Herdr mandatory. Circuit breaker reached; no attempt 4 in this slice.

#### Phase 1 documentation-remediation split after review attempt 3

- [x] `package-docs.test.ts` mechanically rejects every contradictory shipped statement identified by attempt 3: Air unsupported, Herdr sole/only transport, or package-wide failure when Herdr is absent. Proof: focused test failed 7/8 before the README fix and passes 8/8 afterward.
- [x] `extensions/pi-agent-wave/README.md` consistently describes headless as available without Herdr and Herdr as optional visible presentation; root README sweep contains no contradictory transport claim. Proof: focused docs test 8/8; full Node 360 tests / 349 pass / 0 fail / 11 skips; Bun 36/0; typecheck; cleanup; production and Air secret scans (52/0 and 36/0); 3-file ledger audit; and `git diff --check` pass.
- [ ] Final semantic review is dispatched only as a separate post-remediation slice; this slice stops after focused/full verification, ledger audit, cleanup scan, and an updated review bundle. Verified stopping condition: no attempt 4 dispatched; the 86-section bundle is rebuilt and its structural test passes.

### US-010: Define the editor-neutral core boundary for Phase 2

**Description:** As a maintainer, I want a stable core API before creating a daemon so that service extraction does not fork orchestration behavior.

**Acceptance Criteria:**

- [ ] After Phase 1 PASS, an ADR under `dev-docs/` defines editor-neutral run, operation, event, question, cancellation, settlement, and evidence contracts derived from the proven extension implementation.
- [ ] Core modules import no Pi, Air, Herdr, terminal UI, or daemon implementation; an import-boundary test proves the dependency direction.
- [ ] The Pi extension is an explicit adapter over the core API and remains the production runtime until the daemon phase passes its own review.
- [ ] No daemon code starts before Phase 1's real Air rehearsal and final review are PASS.

### US-011: Add an optional durable local daemon in Phase 2

**Description:** As a user, I want runs to survive Air or Pi shutdown so that long-running work is not tied to one client process.

**Acceptance Criteria:**

- [ ] A local daemon entry point owns GraphStore, ACPX/AgentFS attempts, recovery, and cleanup while the Pi extension becomes a typed client adapter; exact executable and protocol paths are recorded in this PRD before implementation.
- [ ] Local transport uses an operating-system local IPC boundary with private permissions and authenticated client identity; it does not expose an unauthenticated TCP listener.
- [ ] Killing Air and Pi during a bounded run leaves the daemon-owned attempt recoverable; reconnecting from a new Air-launched Pi session resumes status and control without duplicate settlement.
- [ ] Daemon install, start, stop, crash recovery, upgrade, uninstall, and stale-socket cleanup are proven on a temporary user home without touching production state.
- [ ] The in-process extension remains available as a supported fallback until daemon parity and migration review return PASS.

### US-012: Support multiple local clients in Phase 2

**Description:** As a user working across tools, I want multiple local clients to observe a run safely without competing for mutation authority.

**Acceptance Criteria:**

- [ ] The daemon protocol distinguishes one mutation lease from read-only observers and rejects conflicting cancel/retry/record actions deterministically.
- [ ] Air, Pi terminal, and a test CLI can observe the same run; ownership transfer is explicit, audited, and cannot duplicate operation settlement.
- [ ] Client disconnect, stale lease expiry, reconnect, and takeover have deterministic tests with no orphaned ACPX/AgentFS resources.
- [ ] Every externally visible mutation retains actor, client, run, operation, attempt, and evidence identity in the ledger.

### US-013: Add a local dashboard in Phase 3

**Description:** As a user, I want an optional visual dashboard so that I can monitor graphs and evidence independently of any editor.

**Acceptance Criteria:**

- [ ] The dashboard is a separate optional client of the reviewed daemon protocol and contains no scheduler, ACPX, AgentFS, or settlement implementation.
- [ ] The first dashboard release is read-only and shows graph topology, operation/attempt state, model/retry history, structured reports, evidence hashes, and cleanup status.
- [ ] The `e2e-test` skill produces `e2e/tests/test_us013_local_dashboard.py` covering the browser-visible happy path, disconnected daemon state, and serious/critical accessibility violations against an isolated temporary daemon.
- [ ] Control actions are a later reviewed slice and cannot be enabled until mutation authorization and audit requirements are specified in this PRD.

### US-014: Add secure remote and team operation in Phase 3

**Description:** As a team, I want authenticated remote orchestration so that shared execution does not weaken local safety guarantees.

**Acceptance Criteria:**

- [ ] A threat model and ADR define trust boundaries, TLS, authentication, authorization, secret storage, tenancy, audit retention, rate limits, and revocation before any remote listener is implemented.
- [ ] Remote mode is disabled by default and cannot be enabled without explicit configuration plus valid credentials; local-only operation remains available.
- [ ] Role-based permissions separate view, submit, cancel/retry, approve, and administration; adversarial tests reject cross-project and cross-tenant access.
- [ ] Provider credentials remain execution-host local and are never returned to Air, dashboard, remote clients, reports, or ledgers.
- [ ] Security review, dependency audit, secret scan, and destructive-action rehearsal must return PASS before remote mode can be described as supported.

### US-015: Add additional client adapters in Phase 3

**Description:** As a user, I want other IDEs and CLIs to control the same orchestration core so that Air is the first client rather than a permanent special case.

**Acceptance Criteria:**

- [ ] A documented adapter contract covers capabilities, progress/events, questions, mutation authority, reconnect, and unsupported features without exposing daemon internals.
- [ ] One non-Air reference adapter passes the same client conformance suite against a temporary daemon.
- [ ] Client-specific presentation code cannot import or reimplement scheduler, ACPX, AgentFS, settlement, or ledger modules; proof is the import-boundary test.
- [ ] Compatibility claims name exact tested client versions and never infer shared ACP session support from protocol compatibility alone.

## Functional Requirements

- FR-1: Air must control Pi through an Air-owned `pi-acp` process; the system must not claim Air attaches to existing ACPX sessions.
- FR-2: Herdr must be optional for package loading and worker execution.
- FR-3: `auto` transport selection must be deterministic and backward-compatible.
- FR-4: Headless and Herdr adapters must share one ACPX/AgentFS lifecycle implementation.
- FR-5: No transport may synthesize evidence for capabilities it does not provide.
- FR-6: Settlement must remain fail closed and transport-aware.
- FR-7: Air-visible progress and questions must use ACP-compatible Pi surfaces rather than terminal-only UI.
- FR-8: Existing public commands, tool schemas, graph behavior, routing, stored runs, and migrations must remain compatible.
- FR-9: Phase 1 must run inside the Pi extension and one package.
- FR-10: Real Air support requires a real installed-application rehearsal, not only an ACP fixture.
- FR-11: Herdr compatibility must remain independently tested.
- FR-12: A daemon must not be introduced until the transport-neutral core and Air workflow pass Phase 1 review.
- FR-13: The daemon must own durable attempts and expose a private authenticated local IPC protocol.
- FR-14: Multi-client mutation authority must be explicit and audited.
- FR-15: The dashboard must remain a client, not a second orchestration implementation.
- FR-16: Remote/team operation must be disabled by default and security-gated.
- FR-17: Provider secrets must remain on the execution host.
- FR-18: Every phase must preserve evidence-ledger, cleanup, source-freshness, package, and review gates.

## Non-Goals

- Building the daemon, dashboard, remote/team mode, or additional adapters before Phase 1 passes.
- Making Air present or attach to individual ACPX worker sessions.
- Replacing Pi with Air as the orchestration supervisor in Phase 1.
- Rewriting graph topology, scheduling, routing policy, AgentFS isolation, settlement semantics, or report schemas without a separately recorded issue change.
- Removing Herdr compatibility.
- Publishing, committing, pushing, merging, or modifying production Pi/Air credentials or state without explicit authorization.
- Editing, testing in, or generating implementation evidence inside `/Users/spotted/projects/pi-agent-wave` after the isolated copy is created.

## Design / Technical Considerations

### Workspace isolation

The first implementation action is a reversible copy into `/Users/spotted/projects/pi-agent-wave-new-design`. Because the current verified implementation is uncommitted, a normal worktree from `HEAD` is not sufficient. The copy must preserve source changes and independent Git metadata while excluding credentials, dependencies, caches, temporary run directories, and generated archives. After its manifest is verified, the original folder becomes read-only for this PRD.

### Delivery phases

1. **Phase 1 — Air/headless extension:** US-000 through US-009. This is the implementation that begins after this PRD.
2. **Phase 2 — durable local service:** US-010 through US-012, only after Phase 1 PASS.
3. **Phase 3 — product surfaces:** US-013 through US-015, only after daemon parity and security prerequisites.

### Initial process and package boundary

Keep one package and one Pi process in Phase 1. Extract transport-neutral modules internally, not into a new published package. Air launches `pi-acp`; Pi loads pi-agent-wave; the extension launches and supervises headless ACPX/AgentFS workers. Herdr is an optional presentation adapter selected only when its complete runtime identity is available.

### Value-object classification

- `WorkerTransportKind`: Value Object; exact type and location are defined in US-002.
- `WorkerPresentationIdentity`: Value Object implemented as an immutable tagged union; exact type and location are defined in US-002.
- Graph run, operation, and ACPX/AgentFS attempt identities remain existing immutable identity-bearing records, not Value Objects that collapse distinct attempts by value.

### Air integration constraint

Current evidence establishes that Air launches configured ACP agents but does not establish an API for attaching to externally owned ACPX processes or sessions. Phase 1 therefore uses Air only as the ACP client for Pi. Worker progress is projected through Pi rather than attached into separate Air agent sessions.

The first real Air dispatch proved Pi's model-facing bash tool is already sandboxed; invoking AgentFS from that tool fails with nested macOS `sandbox-exec` exit 71. Headless launch/wait/cancel must therefore be owned by the `delegate_graph` extension tool and executed through `pi.exec`, outside model-authored shell execution. The model may choose operations and supply graph results, but it must not render or execute the worker launcher argv itself in Air mode.

### State and compatibility

GraphStore requires schema v5 because the existing v4 triggers require `herdr_pane_id` for every ACPX identity. V5 adds no columns: it replaces the provenance insert/update triggers so ACPX/AgentFS/cancel identity remains all-or-none for every transport, every new/live `transport='herdr'` registration requires `herdr_agent`, `tab_id`, and `herdr_pane_id`, and `transport='headless'` requires those three columns to be null. Preserved pre-v4 Herdr rows with no ACPX identity may retain a null pane and project `presentation_identity: null`; they remain historical/read-only and cannot be focused or resumed as live attempts. Migration is direct from v1-v4, idempotent, foreign-key-valid, preserves every existing v4 Herdr row byte-semantically, and rollback restores the prior database from the existing private backup mechanism before any real apply.

### UI proof

The repository currently has no established Air E2E harness. US-007 creates the persistent `e2e/tests/test_us007_air_headless_control.py` artifact required by the `e2e-test` skill and must document any justified adaptation needed for the installed macOS Air application rather than silently substituting an ACP fixture.

## Success Metrics

- Every Phase 1 criterion in US-000 through US-009 passes.
- The original pi-agent-wave workspace remains available for independent work and receives no retained new-design implementation artifact.
- Air controls a real harmless delegation, cancellation, question/resume, and completed report with no Herdr runtime.
- Existing Herdr workflows and stored runs remain compatible.
- Pi, Codex, and Claude real matrices pass in both headless and Herdr modes with zero AgentFS violations.
- Package, installation, secret, cleanup, source-freshness, ledger, and semantic-review gates return PASS.
- No Phase 2 implementation begins before Phase 1 PASS.
- Later daemon and product phases meet their own explicit gates without duplicating the orchestration core.

## Open Questions

- The exact ACP progress and question primitives exposed by the tested `pi-acp` and Air versions must be observed during Phase 1; the implementation may select among Pi messages, tool results, and structured awaiting-user state only after that rehearsal is recorded.
- The exact local daemon IPC technology and executable/package split remain intentionally unresolved until Phase 1 supplies a stable editor-neutral core contract.
- Remote identity provider and deployment topology remain intentionally unresolved until the Phase 3 threat model.

## Implementation Status

**Phase 1 attempt 1: proofs complete (2026-08-31), ready for final review.** All previously blocking proofs now pass; the completion gate is green (360 tests, 349 passed, 0 failed, 11 skipped), and bun package tests, the installation rehearsal, typecheck, pack/publish dry-runs, and `git diff --check` all pass at the final source digest.

Original attempt record: US-000 through US-003 and US-005 are complete. The shared headless/Herdr lifecycle, extension-owned Air dispatch/collect, schema-v5 transport identity, ACP progress/questions, docs, package artifacts, and focused tests are implemented. Real Air 262.579.44 launched `pi-acp` 0.0.31, created seven headless agents with zero Herdr identity, settled three operations, resumed a run across Air tasks, and restored configuration byte-for-byte.

Remaining Phase 1 blockers (updated 2026-08-31 after root-cause work):

1. **RESOLVED IN SOURCE — real Pi proof pending.** The detached Pi ensure failure was never a stdio/PTY/AgentFS/detachment defect: the worker Pi loaded the supervisor's symlinked `settings.json`, whose `packages` list loads the original-workspace pi-agent-wave extension, which fails closed without Herdr identity and kills the worker's ACP server; acpx then reported `Cannot call write after a stream was destroyed`. Proven by bisection (`agent-output/air-headless-orchestration/pi-stdio/root-cause-bisection.json`) and fixed by synthesizing execution-only worker settings (`packages: []`, supervisor defaults) in `delegate_core.provider_runtime_environment`; see `tasks/prd-headless-pi-stdio-lifecycle.md` US-004. The full previously-failing stack now returns `session_ensured` exit 0. The one authorized real Pi matrix attempt (US-003 there) remains to be executed.
2. **RESOLVED (2026-08-31 re-run).** The original failure was rehearsal misconfiguration: operations declared `ownedPaths` in the real repository while `baseDir` was the temporary workspace, so `agentfs-export.ts` correctly failed closed (`owned path escapes base directory`) and `workflow.cancelled` stayed false; the same misconfiguration produced the sandbox-exec exit-71 block. The corrected re-run staged a fresh temporary workspace as the Air project and kept every cwd and ownedPaths inside it. Real Air 262.579.44 drove three runs through `pi-acp` 0.0.31 without Herdr: a mid-flight `/bin/sleep 300` cancellation settled `CANCELLED` with `noSession=true` and no live worker; a completion run settled `terminal` with an audit-tier report `valid=true, PASS`; a deliberately failing run reached `awaiting_user` and was resolved with decision `abort` (recovery path). A second Air task resumed status control of the first session's run, proving cross-session resume. Air config was restored byte-exact, the temporary Pi home and all attempt directories were removed, and zero owned processes remained. Evidence: `agent-output/air-headless-orchestration/air-e2e.json`, `air-e2e-transcript.jsonl`, and `air-e2e-artifacts/v2/`; `uv run --with pytest pytest -q e2e/tests/test_us007_air_headless_control.py` passes.
3. **RESOLVED (2026-08-31).** All three real matrices (lifecycle cancel/reconnect, production, headless) passed for Pi, Codex, and Claude and were re-bound to the final production source digest after the last source change; `lifecycle-hardening-report.json` was re-stamped with its proofs green at the same digest; the story implementation report was written at `agent-output/air-headless-orchestration/implementation-report.json`; two stale audit-test fixtures were repaired (ledger command classifier, headless-matrix classifier, and the 14→15 command-count and 359→360 full-node baselines). The Claude setup token was supplied through a mode-600 file, used only via `PI_CLAUDE_OAUTH_TOKEN_FILE`, and deleted after the final run; the secret scan reports zero findings. Final full Node result: 360 tests, 349 passed, 0 failed, 11 skipped.

Phase 2 and Phase 3 did not start because this PRD prohibits daemon/dashboard/remote/client work before Phase 1 PASS. Evidence: `agent-output/air-headless-orchestration/implementation-blocked-report.json`. Ledger audit and cleanup must be re-run after blocker resolution.
