# PRD: Validate ACPX as a headless worker backend with Herdr presentation

**Status:** Planned technical validation spike. This issue authorizes research, isolated test support, and a bounded local rehearsal only. It does not authorize production integration.

## Overview

pi-agent-wave currently launches every delegated worker in a visible Herdr tab and treats Herdr as its only worker transport. The proposed architecture keeps that visibility contract while introducing [ACPX](https://github.com/openclaw/acpx) as a headless ACP execution and session-control layer beneath a presentation adapter.

The spike must determine whether pi-agent-wave can start and control a persistent ACPX worker, expose its live activity in a dedicated Herdr tab, cancel and reconnect it safely, and retain the existing worker identity and evidence guarantees. JetBrains Air is an investigation target only: the spike must verify its ACP process and session-attachment model before any integration is proposed.

The selected topology is:

```text
Agent mesh / pi-agent-wave graph
              |
              v
     ACPX execution control
              |
              v
   presentation adapter boundary
        |                 |
        v                 v
Herdr worker tab    JetBrains Air feasibility only
```

ACPX is an execution backend in this spike, not a replacement for Herdr and not a second pi-agent-wave transport. Every running worker must still have a verifiable Herdr tab.

## Goals

- Prove a real ACPX session can execute a harmless worker task in an isolated temporary environment.
- Prove persistent session lifecycle operations needed by pi-agent-wave: start, observe, queue without blocking, cancel, reconnect, settle, and clean up.
- Prove every running ACPX worker has a dedicated, focusable Herdr tab with stable graph, role, worker, and session identity.
- Determine whether ACPX's machine-readable event stream can drive the existing graph state and evidence lifecycle without weakening fail-closed gates.
- Establish, from current authoritative evidence, whether JetBrains Air can attach to or present an externally controlled ACP session.
- End with an evidence-backed advance, revise, or reject decision before any production runtime is changed.

## User Stories

### US-001: Establish a reproducible spike baseline

**Description:** As a maintainer, I want the spike to identify its real ACPX, Herdr, and ACP-agent dependencies so that later results are reproducible and do not rely on assumed commands or configuration paths.

**Acceptance Criteria:**

- [x] A preflight invokes the real reachable `acpx` and `herdr` executables without a shell, records their exact versions, and identifies the real ACP-compatible agent command used by the rehearsal. Proof: `agent-output/acpx-headless-worker-spike/baseline.json` plus passing assertions in `extensions/pi-agent-wave/test/acpx-spike-preflight.test.ts`.
- [x] The preflight records the ACPX configuration and session-storage locations reported by the tested version instead of assuming the sketch's `~/.acpx/config.json` path. Proof: explicit `configPath` and `sessionStorePath` evidence fields in `agent-output/acpx-headless-worker-spike/baseline.json`, each carrying the command or source that established it.
- [x] Missing ACPX, missing Herdr, incomplete Herdr workspace identity, and a missing ACP agent each fail before a worker or graph operation is registered. Proof: named negative cases in `acpx-spike-preflight.test.ts`.
- [x] The tested ACPX release is checked against its current README, release, session guide, CLI reference, and ACP coverage document; pre-1.0 behavior is treated as version-specific. Proof: source URLs, retrieval dates, and observed capability fields in `baseline.json`.

### US-002: Prove the headless ACPX lifecycle

**Description:** As an orchestrator, I want to control a persistent ACPX session non-interactively so that a graph worker can continue without an interactive terminal protocol.

**Acceptance Criteria:**

- [x] A deterministic fixture rehearsal proves the launch mechanism end to end: one direct executable/argv boundary, environment assignment before launch, stdout/stderr separation, NDJSON parsing, and propagation of the ACPX process exit status. Proof: `extensions/pi-agent-wave/test/acpx-headless-lifecycle.test.ts` passes its named fixture-mechanism case.
- [x] A bounded real rehearsal creates a persistent ACPX session, submits a harmless read-only prompt using the tested version's machine-readable mode, observes a live or queued state, and reaches a settled result. Proof: `agent-output/acpx-headless-worker-spike/rehearsal.json`, the sanitized completed transcript `agent-output/acpx-headless-worker-spike/acpx-session.ndjson`, and the real rehearsal ledger entry.
- [x] The real rehearsal proves cancellation of an in-flight harmless prompt and reconnection to the same persisted ACP session after the controlling invocation exits. If the tested ACP agent cannot support either operation, the criterion fails rather than being replaced by a fixture. Proof: the common named session and record/session identifiers in `rehearsal.json`, plus the independently sanitized cancelled and completed transcript outcomes.
- [x] The rehearsal uses a temporary home and working directory, permits read-only operations only, and removes its ACPX sessions and child processes on success or failure. Proof: cleanup assertions verify the temporary paths and recorded child processes are absent after the test; the real user ACPX store is never selected.
- [x] Any credential, token, provider response body, or user prompt content not needed for proof is excluded from committed and generated evidence. Proof: focused secret-pattern assertions over `agent-output/acpx-headless-worker-spike/`.

### US-003: Keep every ACPX worker visible in Herdr

**Description:** As a user, I want every running headless worker represented by a dedicated Herdr tab so that ACPX does not reintroduce invisible background delegation.

**Acceptance Criteria:**

- [x] The spike creates a stable mapping among graph run, operation, role, ACPX session, Herdr agent, and Herdr tab before the worker can be reported as running. Proof: typed mapping assertions in `extensions/pi-agent-wave/test/acpx-herdr-presentation.test.ts` and the mapping recorded in `agent-output/acpx-headless-worker-spike/rehearsal.json`.
- [x] A bounded local rehearsal starts one harmless ACPX worker and presents its live NDJSON-derived progress or a live session monitor in its dedicated Herdr tab. If neither presentation mechanism can remain attached after a non-waiting invocation, the criterion fails and the decision records the limitation. Proof: `acpx-herdr-presentation.test.ts`, the Herdr tab/agent/focus identity and live-byte observation in `rehearsal.json`, and the sanitized cancelled ACPX transcript.
- [x] The worker tab uses the existing role-bearing Herdr naming and remains focusable through the package's current focus path while the worker is running. Proof: assertions in `acpx-herdr-presentation.test.ts` exercise `herdrAgentName`, `herdrTabLabel`, and `focusRegisteredAgent` against the rehearsal identity.
- [x] A missing, closed, or identity-mismatched Herdr tab prevents or terminates the running registration rather than allowing an unobservable worker to continue as healthy. Proof: named fail-closed cases in `acpx-herdr-presentation.test.ts`.
- [x] The rehearsal removes its temporary Herdr tab and worker process without closing or altering unrelated tabs in the user's workspace. Proof: before/after workspace identity evidence and targeted cleanup assertions in `rehearsal.json`.

### US-004: Map ACPX events into graph and evidence state

**Description:** As a pi-agent-wave maintainer, I want to know whether ACPX events contain enough lifecycle information to preserve graph settlement and evidence auditing before changing production code.

**Acceptance Criteria:**

- [x] Test-only prototype code under `extensions/pi-agent-wave/test/support/` parses the tested ACPX NDJSON event shapes into typed started, progress, completed, cancelled, and failed outcomes without `any`, unchecked casts, or ignored type errors. Proof: `extensions/pi-agent-wave/test/acpx-event-mapping.test.ts` and `npm run typecheck`.
- [x] Event mapping is exercised against both deterministic fixtures and the sanitized real transcript from US-002; fixtures prove branch behavior and the real transcript proves compatibility with the reachable dependency. Proof: named fixture and real-transcript cases in `acpx-event-mapping.test.ts`.
- [x] The prototype settles a temporary graph operation only after the ACPX result, Herdr identity, worker report, and existing evidence requirements agree. Partial output, process exit alone, or an idle session must not be treated as completed work. Proof: fail-closed settlement cases in `acpx-event-mapping.test.ts` using a temporary Delegate Graph database.
- [x] The rehearsal report enters `agent-output/acpx-headless-worker-spike/delegate-ledger/` and passes the existing ledger audit command. Proof: successful output from `node --experimental-strip-types extensions/pi-agent-wave/scripts/ledger.ts audit acpx-headless-worker-spike --base agent-output` recorded in this issue's verification section.
- [x] No prototype file is shipped in the npm artifact and no public command, tool schema, database schema, or production runtime behavior changes during the spike. Proof: `npm pack --dry-run --json --ignore-scripts`, package-artifact assertions, and `git diff` restricted to this PRD, test support, tests, and generated evidence.

### US-005: Determine JetBrains Air compatibility

**Description:** As an architect, I want verified information about JetBrains Air's ACP ownership and attachment model so that the design does not assume it can display an ACPX-owned session.

**Acceptance Criteria:**

- [x] The investigation identifies the exact JetBrains product and version meant by "JetBrains Air" and cites authoritative product documentation, local product help, or a reproducible installed-product observation. Proof: `agent-output/acpx-headless-worker-spike/jetbrains-air-compatibility.md`.
- [x] The report determines whether the product launches its own ACP agent, can attach to an already-running ACP agent, can attach to an existing ACP session, and can consume an external ACP event stream. Each conclusion includes evidence or is marked `unverified`; absence of evidence is stated as `I don't know`. Proof: a four-capability matrix in `jetbrains-air-compatibility.md`.
- [x] No JetBrains integration code or configuration is changed during the spike. Proof: changed-path inspection contains no JetBrains product or user-configuration path outside generated research evidence.
- [x] The report recommends one of sibling ACP client, presentation adapter, unsupported, or deferred, with the recommendation explicitly separated from observed facts. Proof: decision section in `jetbrains-air-compatibility.md`.

### US-006: Make an evidence-backed architecture decision

**Description:** As the feature owner, I want a clear decision at the end of the spike so that implementation begins only if the proposed architecture is technically supportable and preserves the product contract.

**Acceptance Criteria:**

- [x] This PRD gains a verification section containing the exact dependency versions, proof commands, artifact paths, pass/fail results, blockers, and cleanup outcome. Proof: completed `## Verification` section in this file.
- [x] This PRD gains one decision—advance, revise, or reject—with explicit reasons tied to the acceptance evidence. An advance decision names the production components and acceptance criteria that require a subsequent implementation PRD. Proof: completed `## Decision` section in this file.
- [x] A fresh-context semantic reviewer runs in an observable Herdr worker, checks the decision against the artifacts, and contributes an evidence-bearing ledger entry. Proof: reviewer report in `agent-output/acpx-headless-worker-spike/delegate-ledger/` and a passing ledger audit.
- [x] The repository completion checks pass without weakening existing assertions. Proof: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, `cd extensions/pi-agent-wave && npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, and `git diff --check` all exit successfully.

## Functional Requirements

- FR-1: The spike must treat ACPX as an execution and session-control backend, not as a replacement visible transport.
- FR-2: Every running spike worker must have complete, verifiable Herdr workspace, agent, and tab identity.
- FR-3: The spike must not add an invisible-worker fallback.
- FR-4: The real ACPX and Herdr dependencies must be exercised when reachable; fixtures may prove failure paths but cannot replace the bounded real rehearsal.
- FR-5: All subprocesses must use direct executable and argv boundaries or a persisted script. The spike must not interpolate worker input into a double-quoted shell command.
- FR-6: The real rehearsal must use temporary ACPX storage and a harmless temporary working directory, with read-only permissions and bounded runtime.
- FR-7: Worker identity must retain graph run, operation, role, selected model policy, ACP agent, ACPX session, Herdr agent, and Herdr tab provenance where each value is available.
- FR-8: ACPX machine-readable output must remain structured through parsing; generic text scanning must not decide success, permission, or evidence settlement.
- FR-9: Process exit, ACP session state, Herdr visibility, graph state, and evidence state must be checked independently and reconciled fail-closed.
- FR-10: Cancellation, reconnect, crash, and cleanup behavior must be explicitly proven or recorded as a blocker.
- FR-11: JetBrains Air must remain research-only until its exact product identity and attachment capabilities are verified.
- FR-12: The spike must not change public commands, tool schemas, production transport types, persistent database schemas, package contents, or user configuration.
- FR-13: If the architecture advances, the production approach and acceptance criteria must first be written into a subsequent implementation PRD and linked from `tasks/prd-package-delegate-graph.md` before implementation.
- FR-14: Generated reports must distinguish observed evidence from inference and must not contain credentials or unnecessary user data.

## Non-Goals

- Implement production ACPX dispatch in `/delegate`, `/graph`, or `delegate_graph`.
- Replace Herdr, weaken the mandatory-Herdr prerequisite, or permit invisible background workers.
- Make JetBrains Air a required delivery surface or modify its configuration.
- Share one live session concurrently across ACPX, Herdr, and JetBrains Air.
- Add worker graphs, scheduling, retries, or evidence features to ACPX itself.
- Depend on ACPX features its current coverage document marks unsupported, including native `session/fork` or webhooks.
- Publish an npm release, commit, push, merge, or alter the real Pi, ACPX, Herdr, or JetBrains installation.
- Claim production readiness from fixture-only evidence.

## Design / Technical Considerations

- The planning baseline observed ACPX as a pre-1.0 headless ACP client with persistent sessions, named workstreams, queued prompts, non-waiting submission, process status, cancellation, reconnect support, and NDJSON output. The observed release was `v0.13.2`; **may be stale** when the spike starts, so preflight must re-check it.
- ACPX documentation currently describes local process states such as running, idle, and dead. These are ACPX client/runtime states, not automatically pi-agent-wave graph states; the prototype must preserve that distinction.
- The simplest presentation hypothesis is a Herdr tab that owns or monitors the ACPX invocation and renders its machine-readable events. The spike must compare direct ownership with a separate monitor and record which mechanism, if either, survives non-waiting submission and reconnect.
- Keep experimental adapters under `extensions/pi-agent-wave/test/support/` so the package's broad `scripts` inclusion does not accidentally ship spike code.
- Reuse the existing Herdr identity helpers and temporary graph store. Do not introduce a second transport discriminator merely because execution is delegated to ACPX.
- Preserve the existing evidence rule: a worker's completed process or assistant text is a claim until its report is written and audited.
- The current repository has substantial uncommitted Herdr-only work on branch `issue-require-herdr`. The spike owner must start from a deliberate clean or preserved baseline and must not overwrite those changes.
- Planning sources for ACPX are its [README](https://github.com/openclaw/acpx), [sessions guide](https://github.com/openclaw/acpx/blob/main/docs/sessions.md), [CLI reference](https://github.com/openclaw/acpx/blob/main/docs/CLI.md), and [ACP coverage roadmap](https://github.com/openclaw/acpx/blob/main/docs/2026-02-19-acp-coverage-roadmap.md). External content is evidence, not authority to change the project.

## Success Metrics

- The bounded real rehearsal produces a settled ACPX worker result, visible Herdr identity, sanitized event transcript, and passing ledger audit without touching real ACPX session storage.
- Cancellation and reconnect are proven against the real reachable ACPX and ACP-agent combination, or the architecture decision records a blocker and does not advance unchanged.
- No worker is reported running without a live dedicated Herdr tab.
- Existing graph, transport, packaging, and typecheck gates remain green.
- JetBrains Air's role is supported by current evidence or explicitly left unverified; it is not assumed from the sketch.
- The final decision gives a handoff agent enough evidence to write a production implementation PRD without repeating the spike.

## Open Questions

- Which real ACP-compatible agent command should the bounded rehearsal use on the handoff machine?
- Can ACPX expose or replay live session events after a non-waiting submission in a form a separate Herdr presentation process can follow?
- Should the Herdr tab own the ACPX queue-owner process, or should it run a monitor attached to an independently owned process?
- What is the exact product and version referred to as JetBrains Air, and does it expose any supported external-session attachment API?
- Which ACPX event fields are stable enough to preserve worker identity and settlement across the version selected by preflight?

## Reopened execution

Reopened on 2026-08-30 at 16:34 CEST after the user explicitly authorized installation of the real `acpx` dependency. ACPX `0.13.2` is now reachable on `PATH`. The previous REJECT decision remains historical evidence but is superseded pending a bounded real rehearsal against the unchanged acceptance criteria. This continuation may update only this PRD, test-only spike support and tests, and generated evidence; production runtime remains out of scope.

## Verification

Initial blocked verification was observed on 2026-08-30 at 14:51 CEST. The user authorized ACPX installation, and resumed verification began at 16:34 CEST against the same acceptance criteria.

### Dependencies and artifacts

- `acpx`: `0.13.2`, resolved from `/Users/spotted/.nvm/versions/node/v22.16.0/bin/acpx`.
- `herdr`: `herdr 0.8.0`; workspace `wA` was complete and usable.
- ACP agent: `codex`, version `codex-cli 0.137.0`; the real session reported model `gpt-5.5`.
- JetBrains Air: local bundle `/Users/spotted/Applications/Air.app`, version `262.579.44`.
- Baseline with command-attributed config and session paths: `agent-output/acpx-headless-worker-spike/baseline.json`.
- Real lifecycle, identity, state reconciliation, attempt, and cleanup evidence: `agent-output/acpx-headless-worker-spike/rehearsal.json`.
- Sanitized completed transcript: `agent-output/acpx-headless-worker-spike/acpx-session.ndjson`.
- Sanitized cancelled transcript: `agent-output/acpx-headless-worker-spike/acpx-cancel-session.ndjson`.
- Validated real rehearsal report: `agent-output/acpx-headless-worker-spike/real-rehearsal-report.json`.
- JetBrains Air report: `agent-output/acpx-headless-worker-spike/jetbrains-air-compatibility.md`.
- Evidence ledger: `agent-output/acpx-headless-worker-spike/delegate-ledger/`.

### Real rehearsal results

- A real named ACPX Codex session was created in a temporary `HOME`, temporary working directory, and temporary npm cache. The real user ACPX store was never selected.
- A dedicated Herdr tab `wA:t2P`, pane `wA:p2P`, and agent `dg-acpx-headless-worker-spike-codex-1` were mapped to the graph run, operation, role, ACPX record, and ACP session before the worker was reported as working.
- The Herdr-visible persisted runner emitted 315 bytes of strict NDJSON before active cancellation. `herdr agent focus dg-acpx-headless-worker-spike-codex-1` exited successfully while the prompt was active.
- `--no-wait` returned `prompt_queued`. Active cancellation returned `cancelled: true` and the visible transcript ended with `stopReason: cancelled`.
- Reconnection to the same named session exited 0, returned the expected harmless token, and ended with `stopReason: end_turn` and empty stderr.
- Session close exited 0; post-close status was `no-session`; the observed queue-owner PID was absent afterward.
- The Herdr agent was released and only tab `wA:t2P` was closed. Unrelated tabs `wA:t1`, `wA:t0`, `wA:t2H`, and `wA:t2J` remained present.
- The temporary rehearsal root was removed. Structured sanitization removed metadata, paths, free text, and raw identifiers. A final credential/private-key/bearer-token/email pattern scan covered 15 generated evidence files and found 0 matches.
- The first Herdr presentation attempt failed because the tab environment lacked the NVM Node path. That tab and its empty output were removed before retry. The persisted launcher then exported the verified Node bin path and passed. Production design must bind the executable environment explicitly.
- ACPX `status` reported `idle`, `alive`, and `no-session` in the tested flows. A production adapter must treat those tested client/runtime states separately from graph operation states rather than assume the planning sketch's `running`, `idle`, and `dead` vocabulary.

### Proof results

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/acpx-spike-preflight.test.ts extensions/pi-agent-wave/test/acpx-headless-lifecycle.test.ts extensions/pi-agent-wave/test/acpx-herdr-presentation.test.ts extensions/pi-agent-wave/test/acpx-event-mapping.test.ts`: PASS, 13 passed, 0 failed, 0 skipped.
- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`: PASS, 204 passed, 0 failed, 2 skipped across 206 tests.
- `bun test extensions/pi-agent-wave/test/package-manifest.test.ts extensions/pi-agent-wave/test/package-portability.test.ts extensions/pi-agent-wave/test/package-artifact.test.ts extensions/pi-agent-wave/test/package-docs.test.ts extensions/pi-agent-wave/test/package-migration.test.ts extensions/pi-agent-wave/test/questionnaire.test.ts extensions/pi-agent-wave/test/cmux-session.test.ts extensions/pi-agent-wave/test/model-failover.test.ts`: PASS, 33 passed and 0 failed.
- `node --experimental-strip-types --test extensions/pi-agent-wave/test/package-install-rehearsal.test.ts`: PASS, 1 passed and 0 failed.
- `cd extensions/pi-agent-wave && npm run typecheck`: PASS.
- Strict standalone TypeScript check for `test/support/acpx-spike.ts`: PASS with `--strict`; the unsafe-type scan found no `any`, unchecked cast, or ignore directive.
- `npm pack --dry-run --json --ignore-scripts` and `npm publish --dry-run --json --ignore-scripts`: PASS, 46 files each; neither artifact contains ACPX spike or `test/support` files.
- `node --experimental-strip-types extensions/pi-agent-wave/scripts/ledger.ts audit acpx-headless-worker-spike --base agent-output`: PASS after final decision review; 5 evidence ledger files, 0 findings.
- The final fresh-context reviewer ran in observable Herdr tab `wA:t2Q`, returned `PASS` for the ADVANCE decision, and its validated report is `agent-output/acpx-headless-worker-spike/advance-decision-reviewer-report.json`. Its temporary tab and run directory were removed.
- `git diff --check`: PASS. The resumed slice did not modify production runtime files.

### Residual uncertainty

The existing authenticated `CODEX_HOME` was referenced while ACPX itself used a temporary `HOME`. No credential value or provider response body entered repository evidence. I don't know whether Codex updated provider-owned local metadata because no pre-run snapshot was taken. JetBrains Air attachment to an externally owned ACP process, ACP session, or event stream remains `unverified`; Air is not part of the production recommendation.

## Decision

**ADVANCE to a separate production ACPX integration PRD.**

The spike now proves the real dependency, persistent session lifecycle, non-waiting queue, active cancellation, reconnect, strict machine-readable output, dedicated focusable Herdr presentation, typed completed/cancelled event mapping, fail-closed graph settlement, evidence handling, and targeted cleanup. This decision authorizes planning, not production implementation in this spike.

The subsequent production PRD must name and prove these components and criteria:

1. A package-private ACPX executable and session adapter with direct argv boundaries, explicit executable environment, bounded timeouts, tested `idle`/`alive`/`no-session` state mapping, and targeted cleanup.
2. A Herdr presentation bridge that binds graph run, operation, role, model policy, ACP agent, ACPX record/session, Herdr agent, and tab before recording a running operation; missing or mismatched visibility must fail closed.
3. A typed ACP JSON-RPC event adapter that preserves structured updates and reconciles process exit, ACPX state, Herdr visibility, validated worker report, graph state, and ledger audit independently before settlement.
4. Preflight, doctor, documentation, migration, package-artifact, and real-dependency tests that preserve the public `/delegate`, `/graph`, and `delegate_graph` contracts and the mandatory-Herdr invariant.
5. No JetBrains Air integration unless a later issue proves a supported externally owned process/session attachment API.

Production runtime files remain unchanged by this spike.
