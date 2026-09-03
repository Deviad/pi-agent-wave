# PRD: Production ACPX Final Bundle Completeness

## Overview

The production implementation and all host gates are green, but source-hardening review attempt 3 could not return PASS because `extensions/pi-agent-wave/test/commands.test.ts` was omitted from the self-contained review bundle. This narrow split fixes only that evidence-packaging defect and performs one new source-current audit and review.

## Goals

- Include the role-registration regression test source in the hash-indexed review bundle.
- Mechanically prevent the named path from being omitted again.
- Refresh source-bound real evidence and obtain one fresh-context PASS review.

## User Stories

### US-001: Complete role-regression evidence bundle

**Description:** As a final reviewer, I want the direct role-registration regression test in the self-contained bundle so that the verified production fix is recheckable without filesystem access.

**Acceptance Criteria:**

- [x] `extensions/pi-agent-wave/scripts/production-review-bundle.ts` includes `extensions/pi-agent-wave/test/commands.test.ts` in `REVIEW_PATHS`.
- [x] `extensions/pi-agent-wave/test/production-review-bundle.test.ts` explicitly asserts that `commands.test.ts` appears in the section index with byte count and SHA-256.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/production-review-bundle.test.ts extensions/pi-agent-wave/test/commands.test.ts` passes.

### US-002: Source-current final proof

**Description:** As a release owner, I want the corrected bundle reviewed against current source so that the package can reach a truthful final decision.

**Acceptance Criteria:**

- [x] The fail-closed 14-command host audit passes with exact 326/318/0/8 Node counts, both real Pi/Codex/Claude matrices at 3/3, package/install gates, current source hashes, 20 pre-review ledger files, token deletion, secret scan, cleanup scan, and `git diff --check`.
- [x] `agent-output/production-acpx-worker-backend/final-review-bundle.md` contains `extensions/pi-agent-wave/test/commands.test.ts`, source-hardening reports from attempts 1-3, the current audit, and all referenced paths with SHA-256.
- [x] A fresh-context observable Herdr reviewer using `--no-terminal` writes a canonical report with `verdict: PASS`.
- [x] The PASS report is copied under `agent-output/production-acpx-worker-backend/`, appended to the evidence ledger, and the ledger audit reports zero findings.
- [x] Post-review cleanup proves no owned Herdr tab/pane/agent, ACPX/AgentFS process, temporary run directory, or Claude token remains.

## Functional Requirements

- FR-1: The bundle path list must contain the exact direct regression test named by attempt 3.
- FR-2: Bundle tests must fail if that path or its hash-index entry is absent.
- FR-3: Final proof must be regenerated after the bundle source change.
- FR-4: Historical failed reports remain immutable and included.

## Non-Goals

- Changing production cancellation, cleanup, migration, routing, transport, package, or public schemas.
- Rewriting historical review reports.
- Publishing, committing, pushing, or merging.

## Design / Technical Considerations

Make the smallest possible change: one `REVIEW_PATHS` entry and one explicit regression assertion. Do not refactor bundle generation.

## Success Metrics

- All eight acceptance criteria pass.
- The fresh-context reviewer returns PASS.
- The final ledger and cleanup audits are green.

## Open Questions

None. The exact omission is established by `agent-output/production-acpx-worker-backend/final-source-hardening-review-attempt-3.json`.


## Verification

- Full Node: 326 tests, 318 passed, 0 failed, 8 opt-in matrix skips.
- Host audit: PASS, 14 exact commands, source unchanged, all bound artifacts current.
- Real lifecycle and production matrices: 3/3 each, 0 failed, 0 skipped.
- Package: Bun 34/0; pack/publish 64 files, 0 external artifacts; installation rehearsal PASS.
- Final reviewer: PASS at `agent-output/production-acpx-worker-backend/final-bundle-completeness-review-pass.json`.
- Final ledger: 21 files, 0 findings. Secret scan: 52 files, 0 findings. Cleanup: no leaked resources or token.

## Decision

**PASS.** All eight criteria are complete. No commit, push, publication, or merge was performed.