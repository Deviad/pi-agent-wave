# PRD: Production ACPX Final Source Hardening

## Overview

The production ACPX backend passes its host gates and real Pi/Codex/Claude matrices, but the final observable review remains blocked on five source-level acceptance gaps. This slice splits those gaps out of `tasks/prd-production-acpx-final-audit.md` so they can be implemented and reviewed without another retry against the broader historical slice.

The work makes the deterministic audit genuinely fail closed, unifies every cancellation path, proves each cleanup failure and resource absence, and strengthens direct legacy-migration preservation checks. It does not change the public delegation schemas, graph behavior, ACPX-only transport decision, or AgentFS isolation model.

## Goals

- Reject changed test/package/ledger counts and stale durable evidence in the production audit.
- Use one complete structured ACPX cancellation implementation for focus failure, abort, retry, cleanup, and normal cancellation.
- Validate focus identity against persisted ACPX attempt and record identity.
- Execute one named adversarial test for every required cleanup failure and inventory every owned resource independently.
- Prove direct v1, v2, and v3 migrations preserve complete legacy state while adding nullable v4 provenance.
- Obtain one fresh-context observable PASS review after all source and host gates pass.

## User Stories

### US-001: Fail-closed deterministic host audit

**Description:** As a release reviewer, I want the production audit to reject unexpected counts and stale evidence so that a green audit cannot silently accept a changed or outdated proof set.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/test/production-audit.test.ts` proves that changing each expected full-Node, Bun, package-file, installation, real-matrix, and ledger count makes `summariesValid` return false.
- [x] `extensions/pi-agent-wave/test/production-audit.test.ts` proves that a durable matrix or lifecycle artifact whose bound production-source digest differs from the current digest makes the audit fail closed.
- [x] `extensions/pi-agent-wave/scripts/production-audit.ts` records the expected baselines, observed summaries, current production-source digest, and every referenced artifact digest in `agent-output/production-acpx-worker-backend/final-audit.json`.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/production-audit.test.ts extensions/pi-agent-wave/test/production-review-bundle.test.ts` passes with explicit unexpected-count and stale-evidence rejection cases.

### US-002: One complete cancellation implementation

**Description:** As an operator, I want every attempt cancellation path to use the same structured routine so that focus failures, aborts, retries, cleanup, and normal cancellation cannot diverge.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/scripts/acpx-cancel.ts` is the only implementation that issues ACPX cancel, waits for a structured `cancelled` terminal event, closes the session, and verifies final `no-session`; `extensions/pi-agent-wave/scripts/acpx-worker.ts` contains no independent cancel mode or equivalent sequence.
- [x] `extensions/pi-agent-wave/scripts/herdr_delegate.py` invokes the exact persisted `cancel-acpx.sh` launcher for abort, retry, cleanup, and failure paths, and propagates any nonzero or incomplete cancellation result.
- [x] `extensions/pi-agent-wave/herdr.ts` accepts only a complete `cancel_attempt` result and validates the live focus identity against persisted ACPX session, attempt-key, record, AgentFS, Herdr agent, pane, and tab identity before retaining focus.
- [x] `extensions/pi-agent-wave/test/acpx-cancellation.test.ts`, `extensions/pi-agent-wave/test/acpx-focus-cancellation.test.ts`, and `extensions/pi-agent-wave/test/acpx-herdr-bridge.test.ts` reject cancel-result-only output, mismatched attempt keys/records, incomplete settlement, and duplicated cancellation routing.

### US-003: Adversarial cleanup and complete absence inventory

**Description:** As an operator, I want cleanup failures and every owned resource checked independently so that a partial cleanup cannot be reported as success.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/test/acpx-cleanup.test.ts` executes separately named failure cases for cancel, close, provider-link removal, Herdr agent/pane/tab release, attempt-directory removal, and cleanup-evidence persistence; every case proves a nonzero command or explicit failure result.
- [x] Cleanup evidence produced by `extensions/pi-agent-wave/scripts/herdr_delegate.py` independently records absence of the queue-owner PID, ACPX session files, AgentFS mount/server/database/HOME, provider-runtime links, report-repair child, Herdr agent/pane/tab, and attempt directory.
- [x] `extensions/pi-agent-wave/test/acpx-cleanup.test.ts` tampers or preserves each resource class in turn and proves `verify_cleanup_absence` rejects that exact remaining resource.
- [x] Repeated cleanup of an already-clean owned run remains idempotent, while no cleanup failure is suppressed; proof is the passing `ACPX AgentFS targeted cleanup` suite.

### US-004: Complete legacy migration preservation proof

**Description:** As a maintainer, I want direct legacy migrations to prove all state survives so that schema v4 provenance cannot corrupt existing graphs.

**Acceptance Criteria:**

- [x] Each directly seeded v1, v2, and v3 case in `extensions/pi-agent-wave/test/acpx-store-migration.test.ts` asserts preserved run status/task/story, policy and model provenance when present, operation state and command, event payload/order, agent state, and legacy nullable ACPX/AgentFS/Herdr identity.
- [x] `extensions/pi-agent-wave/test/acpx-store-migration.test.ts` still proves interrupted-v4 repair, idempotent reopen, foreign-key validity, and rejection of inconsistent partial provenance.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/acpx-store-migration.test.ts extensions/pi-agent-wave/test/store.test.ts` passes without weakening schema or identity assertions.

### US-005: Source-current proof and final review

**Description:** As a release owner, I want one bounded source-current verification and fresh review so that completion is based on the remediated code rather than historical summaries.

**Acceptance Criteria:**

- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, the package-focused Bun gate, `npm run typecheck`, install rehearsal, npm pack/publish dry-runs, ledger audit, secret scan, cleanup scan, and `git diff --check` all pass and are recorded by the fail-closed 14-command host audit.
- [x] The real Pi/Codex/Claude lifecycle and production matrices pass with zero skipped tests, zero AgentFS violations, complete settlement/cleanup identity, and deletion of the mode-600 Claude token file; proof is the source-digest-bound files under `agent-output/production-acpx-worker-backend/final-matrix/`.
- [x] `agent-output/production-acpx-worker-backend/final-review-bundle.md` is regenerated from the passing source-current audit and contains every PRD, implementation path, focused test, matrix artifact, historical FAIL report, and checklist-to-evidence mapping by SHA-256.
- [x] A fresh-context observable Herdr reviewer with `--no-terminal` writes a canonical report with `verdict: PASS`; that report is copied under `agent-output/production-acpx-worker-backend/`, appended to the ledger, and the final ledger audit reports zero findings.
- [x] Cleanup after the reviewer proves no owned Herdr tab/pane/agent, ACPX/AgentFS process, temporary run directory, or Claude token file remains.

## Functional Requirements

- FR-1: The system must compare observed host-gate summaries against explicit expected baselines and reject every mismatch.
- FR-2: The system must bind durable lifecycle and production evidence to the production-source digest and reject stale bindings.
- FR-3: The system must keep exactly one structured ACPX cancellation implementation.
- FR-4: The system must validate persisted ACPX attempt-key and record identity during focus checks.
- FR-5: The system must propagate cancellation and cleanup failures instead of logging and continuing.
- FR-6: The system must inventory each owned cleanup resource independently.
- FR-7: The system must preserve complete legacy graph, policy, model, operation, event, agent, and nullable provenance state during v1-v3 to v4 migration.
- FR-8: The final review must consume only the source-current hash-indexed bundle and must not rerun host commands inside AgentFS.

## Non-Goals

- Changing `/delegate`, `/graph`, or `delegate_graph` public schemas.
- Changing graph topology, scheduling, retries, evidence gates, or model routing policy.
- Adding a transport other than Herdr or a worker backend other than ACPX.
- Changing ACPX `0.13.2`, AgentFS `0.6.4`, or provider/model compatibility claims.
- Publishing, committing, pushing, merging, or applying a real migration.
- Re-running or rewriting historical failed reviewer reports.

## Design / Technical Considerations

- Prefer a small typed audit-baseline object and a production-source digest over inferred or self-updating expectations. Baseline changes must be explicit and reviewed.
- `acpx-cancel.ts` remains the persisted executable boundary. Python and TypeScript callers should execute and validate its result rather than reimplement its protocol.
- Cleanup failure tests may introduce dependency-injection seams around command execution and filesystem removal, but must not add production-only test modes or global mutable switches.
- Resource absence evidence must retain exact attempt identity while sanitizing credentials and host-private token values.
- Keep the new slice surgical. Do not refactor unrelated graph, package, or transport code.

## Success Metrics

- All 20 acceptance criteria pass with their named proof.
- The deterministic audit rejects every mutated expected count and stale artifact fixture.
- Source search and tests demonstrate one cancellation implementation.
- Every named cleanup failure and resource class has an executed fail-closed case.
- Direct v1/v2/v3 migration tests assert complete preserved state.
- The fresh-context final reviewer returns PASS and the ledger audit remains clean.

## Open Questions

None. The five findings and required proof are fixed by `agent-output/production-acpx-worker-backend/final-review-remediated-fail.json` and the existing parent PRDs.


## Verification

- Source-hardening code and focused tests pass.
- Full Node: 326 tests, 318 passed, 0 failed, 8 opt-in matrix skips.
- Both source-current real three-agent matrices pass 3/3.
- Final bundle-completeness reviewer returned PASS in `agent-output/production-acpx-worker-backend/final-bundle-completeness-review-pass.json`.
- Final ledger audits 21 files with 0 findings; cleanup and secret scans are green.

## Decision

**PASS.** All 20 criteria are complete through the bounded bundle-completeness split.