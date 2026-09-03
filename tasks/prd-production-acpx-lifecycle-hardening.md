# PRD: Production ACPX lifecycle hardening

## Overview

Harden the implemented ACPX-only worker backend so cancellation, cleanup, focus, and settlement are proven from observed production evidence rather than caller assertions or best-effort teardown. This is the remediation slice split from `tasks/prd-production-acpx-worker-backend.md` after its final-review circuit breaker.

The existing Herdr, ACPX `0.13.2`, AgentFS `0.6.4`, Pi/Codex/Claude routing, schema-v4 provenance, report projection, setup-token containment, package contracts, and public `/delegate`, `/graph`, and `delegate_graph` schemas remain in place. This PRD changes only lifecycle mechanics and their focused proof.

## Goals

- Wait for structured cancellation before session close.
- Prove absence of every owned ACPX, AgentFS, repair, and Herdr resource after cleanup.
- Cancel the exact persisted ACPX attempt when focus identity is missing or mismatched.
- Settle graph operations from a transport-generated manifest validated against GraphStore, report, export, close, provider-link, and private-ledger evidence.
- Remove misleading read-only flags and represent host-read-only AgentFS discard semantics explicitly.
- Add direct v2 and v3 database migration fixtures and database-boundary identity constraints.

## User Stories

### US-001: Make host-read-only semantics explicit

**Description:** As a maintainer, I want read-only graph roles represented as discard-all AgentFS attempts so that tool capability and host mutation policy cannot be confused.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/scripts/herdr_delegate.py` emits explicit `hostReadOnly` and `discardAllChanges` fields instead of hard-coded `readOnly: false` / `projectAssistantReport: false` ambiguity. Proof: production config assertions in `extensions/pi-agent-wave/test/acpx-herdr-bridge.test.ts`.
- [x] Read-only roles may use tools inside AgentFS COW, export zero repository paths, record every discarded overlay change, and write only the private report path on the host. Proof: real AgentFS cases in `agentfs-sandbox.test.ts` and bridge result assertions.
- [x] Writable roles continue to export only audited owned paths and reject every unowned substantive change. Proof: positive and negative export cases in `agentfs-sandbox.test.ts`.
- [x] `cd extensions/pi-agent-wave && npm run typecheck` passes. Proof: command output recorded in this PRD's verification section.

### US-002: Cancel and clean one exact operation attempt

**Description:** As an operator, I want cancellation and cleanup to prove terminal state and resource absence so that no session or sandbox leaks after failure, retry, or user cancellation.

**Acceptance Criteria:**

- [x] ACPX cancel mode sends cancel to the persisted agent/session, waits for a structured cancelled terminal event or bounded timeout, then closes and verifies structured `session_closed` plus `no-session`. Proof: fixture and real Pi/Codex/Claude cases in `extensions/pi-agent-wave/test/acpx-cancellation.test.ts`.
- [x] Failure and abort paths surface cancel, close, provider-link, Herdr release, and removal failures rather than suppressing them. Proof: one named adversarial case per failure in `acpx-cleanup.test.ts`.
- [x] Cleanup inventories and proves absence of the ACPX process, queue-owner PID, session files, AgentFS mount/server/database/HOME, report-repair child, Herdr agent, pane, tab, and attempt directory while unrelated resources remain. Proof: `acpx-cleanup.test.ts` plus sanitized real artifacts under `agent-output/production-acpx-lifecycle-hardening/`.
- [x] Cleanup is idempotent; a second targeted cleanup succeeds without touching unrelated resources. Proof: repeated cleanup case in `acpx-cleanup.test.ts`.

### US-003: Cancel on focus identity failure

**Description:** As a user, I want focus to validate and cancel the exact attempt so that a mismatched or invisible worker cannot remain healthy.

**Acceptance Criteria:**

- [x] Persisted focus identity includes Herdr agent/tab/pane, ACP agent, ACPX session/attempt, AgentFS session/database, and current ACPX state. Proof: GraphStore round-trip and focus fixture assertions.
- [x] Missing, unavailable, malformed, stale, or mismatched pane/tab identity invokes the same structured ACPX cancellation routine for the exact persisted session before any terminal key fallback. Proof: named cases in `extensions/pi-agent-wave/test/acpx-focus-cancellation.test.ts`.
- [x] A non-`alive` ACPX state blocks focus and performs bounded cleanup when owned resources still exist. Proof: state-table cases in `acpx-focus-cancellation.test.ts`.
- [x] Successful focus observes the live pane/tab and focuses the persisted Herdr agent without changing operation state. Proof: positive focus case and event assertions.

### US-004: Verify settlement from observed evidence

**Description:** As a maintainer, I want completion validated against a transport-produced manifest so that caller-provided booleans cannot advance the graph.

**Acceptance Criteria:**

- [x] `herdr_delegate.py` writes a private settlement manifest from observed worker result, structured terminal/status, live Herdr pane/tab, complete shared attempt identity, report hash/audit, AgentFS export, parsed close result, provider-link verification, and private attempt-ledger audit. No required boolean is hard-coded. Proof: bridge manifest assertions.
- [x] `sessionClosed` derives from parsed `session_closed` and final status derives from an observed allowed transition such as registered `alive` to terminal `alive`/`idle`/`no-session`. Proof: transition table in `extensions/pi-agent-wave/test/acpx-settlement-manifest.test.ts`.
- [x] `index.ts` verifies manifest run, operation, agent, pane/tab, ACPX/AgentFS identity, attempt key, report path/hash, export, close, provider, ledger, and current GraphStore status before completion. Proof: one success and one independent tamper rejection per field in `acpx-settlement-manifest.test.ts`.
- [x] The end-to-end test consumes a manifest generated by the production Herdr bridge rather than an all-true handwritten fixture. Proof: production bridge → tool completion case in `acpx-settlement-manifest.test.ts`.
- [x] Idempotent re-observation cannot settle an operation twice. Proof: duplicate-manifest case.

### US-005: Complete schema-v4 migration proof

**Description:** As an operator, I want every supported historical schema upgraded safely so that ACPX provenance cannot corrupt existing graph databases.

**Acceptance Criteria:**

- [x] Seeded v1, v2, and v3 database fixtures each migrate to v4 preserving rows, policy/model provenance, operations, events, and legacy nullable agents. Proof: direct fixture cases in `acpx-store-migration.test.ts`.
- [x] Interrupted v4 column/trigger migration repairs idempotently. Proof: existing interrupted case remains green.
- [x] Existing and new insert/update database triggers reject every partial ACPX/AgentFS/Herdr identity combination. Proof: generated partial-set cases at the SQLite boundary.
- [x] Complete identity round-trips with Herdr pane provenance and supported ACPX state. Proof: schema-v4 round-trip case.

## Functional Requirements

- FR-1: Read-only must mean no host repository export, not an ambiguous tool flag.
- FR-2: Cancellation must observe a structured cancelled result before close.
- FR-3: Close must observe `session_closed` and final `no-session` before success.
- FR-4: Cleanup must inventory and prove absence of every owned process, session, sandbox, provider-link, and Herdr resource.
- FR-5: Cleanup failures must be returned and block graph advancement.
- FR-6: Focus identity failure must call the exact persisted session cancellation routine.
- FR-7: Settlement inputs must originate from transport observations and private audits, not caller booleans.
- FR-8: Settlement evidence must be private, mode `0600`, report-adjacent, and hash-bound.
- FR-9: GraphStore must verify current running state and complete attempt identity before completion.
- FR-10: Schema v4 must support direct v1, v2, v3, and interrupted-v4 upgrades.
- FR-11: Public command/tool schemas, graph topology, retries, model policy, and mandatory Herdr/ACPX/AgentFS prerequisites must remain unchanged.

## Non-Goals

- Change supported ACP agents, model routing, report semantics, or setup-token handling.
- Add new public commands or `delegate_graph` fields.
- Change AgentFS, ACPX, or Herdr versions.
- Rework packaging, documentation, or the real matrix beyond artifacts needed for lifecycle proof.
- Commit, push, publish, merge, or apply a real database migration without explicit authorization.

## Design / Technical Considerations

- Reuse `lib/acpx-types.ts`, `lib/acpx-events.ts`, `lib/acpx-settlement.ts`, `lib/agentfs-sandbox.ts`, `scripts/acpx-worker.ts`, `scripts/agentfs-export.ts`, and `scripts/herdr_delegate.py`.
- Keep one cancellation implementation callable from normal cancellation, focus failure, abort, retry, and cleanup.
- Record PIDs and resource paths before launch so absence checks do not depend on text scanning.
- Keep settlement manifest production in Python transport and verification in TypeScript; share exact field names through a typed declaration or generated fixture.
- Use temporary GraphStore databases and temporary AgentFS homes for all migration and lifecycle tests.

## Success Metrics

- Every focused lifecycle, focus, settlement-tamper, and migration test passes.
- No cleanup path reports success while an owned resource remains.
- No tampered manifest field can complete an operation.
- Direct v1/v2/v3 and interrupted-v4 migrations pass.
- Full Node, typecheck, package, installation, ledger, and whitespace gates remain green.

## Open Questions

- Which ACPX status/stream command is the most stable source for the post-cancel terminal event in version `0.13.2`?
- Which process inventory is portable across macOS and Linux for queue-owner and AgentFS server absence proof?

## Verification

- Focused lifecycle-hardening suite: 53 passed, 0 failed.
- Final host audit full Node gate: 318 passed, 0 failed, 8 skipped across 326 tests; both opt-in real matrices pass separately with 3/3 each.
- Direct seeded v1, v2, and v3 plus interrupted-v4 migrations pass.
- Cancellation/close records structured cancel_result, session_closed, and no-session; abort surfaces cleanup failures and waits for cancelled terminal evidence when active cancellation is observed.
- Focus mismatch invokes the persisted exact ACPX cancel script before terminal-key fallback.
- Settlement manifest binds observed Herdr pane/identity, full attempt key, report hash, AgentFS export, structured close, provider links, private ledger, and cleanup inventory; independent tamper cases pass.
- Typecheck, package-focused Bun, npm dry-runs, installation rehearsal, ledger audit, and git diff check pass.

## Decision

**PASS.** Lifecycle hardening is complete and hands off to `tasks/prd-production-acpx-final-audit.md`.
