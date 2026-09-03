# PRD: Production ACPX deterministic final audit

## Overview

Create a deterministic, durable final-audit workflow for the ACPX/AgentFS worker backend after `tasks/prd-production-acpx-lifecycle-hardening.md` passes. The current final reviewer ran the canonical suite from inside AgentFS; tests that themselves launch AgentFS attempted nested macOS NFS mounts and failed with environment-induced `Operation not permitted` errors even though the host suite passed.

This slice separates host execution proof from fresh-context semantic review. A host tester produces a sanitized hash-bound evidence bundle. A fresh observable Herdr reviewer inspects source plus that bundle and is mechanically prevented from rerunning nested AgentFS/package tests. Story completion requires a validated `PASS` review and a clean evidence ledger.

## Goals

- Produce one durable machine-readable bundle for every required host, package, real-agent, cleanup, and security gate.
- Make the three-agent production matrix recheckable without retained credentials or `/private/tmp` dependencies.
- Prevent the final reviewer from launching nested AgentFS, package-manager, build, or test commands.
- Reconcile exact PRD checklist, test, package, artifact, and ledger counts before review.
- Obtain one fresh observable evidence-bearing `PASS` review.

## User Stories

### US-001: Capture deterministic host gate evidence

**Description:** As a reviewer, I want exact host test evidence so that nested sandbox failures cannot be confused with product failures.

**Acceptance Criteria:**

- [x] A package-owned audit script runs the exact full Node, package-focused Bun, typecheck, npm pack/publish dry-runs, installation rehearsal, real Pi/Codex/Claude matrix, ledger audit, secret scan, cleanup scan, and `git diff --check` commands on the host. Proof: new `extensions/pi-agent-wave/scripts/production-audit.ts` and focused argv tests.
- [x] Each command record contains direct argv, cwd, sanitized environment keys, exit code, test counts, artifact paths, SHA-256, and timestamp, never credential values or provider responses. Proof: schema tests in `production-audit.test.ts`.
- [x] The bundle fails closed when any command fails, expected count differs, an external artifact ships, evidence is stale, or cleanup finds a resource. Proof: one negative fixture per condition.
- [x] Final output is `agent-output/production-acpx-worker-backend/final-audit.json` plus referenced sanitized artifacts, all mode `0600`. Proof: artifact/mode assertions.

### US-002: Preserve recheckable real-agent proof

**Description:** As a maintainer, I want the real matrix evidence retained safely so that reviewers can verify production behavior without credentials.

**Acceptance Criteria:**

- [x] The real matrix executes the production `herdr_delegate.py` and `acpx-worker.ts` report path plus active cancellation/reconnect/close for Pi, Codex, and Claude. Proof: persistent `acpx-real-production-matrix.test.ts`.
- [x] Per-agent sanitized evidence includes runtime versions, direct argv with secret values removed, Herdr agent/tab/pane identity, attempt key, ACPX and AgentFS sessions, terminal/cancel/close states, settlement manifest, report audit, export inventory, cleanup inventory, and transcript/report hashes. Proof: per-agent JSON artifacts under `agent-output/production-acpx-worker-backend/final-matrix/`.
- [x] Claude token proof records only mode, path classification, injection destination, absence scans, and deletion; no token or token hash persists. Proof: containment assertions and secret scan.
- [x] Pi supervisor projection remains explicitly execution-only and non-semantic. Proof: canonical claim assertion.
- [x] Every artifact references only durable repository evidence; no claim depends on a deleted `/private/tmp` path. Proof: path scan.

### US-003: Prevent nested verification in the semantic reviewer

**Description:** As a supervisor, I want final review restricted to source and evidence inspection so that the reviewer cannot invalidate proof by nesting AgentFS.

**Acceptance Criteria:**

- [x] A dedicated final-review launcher passes ACPX `--no-terminal`, so the reviewer has ACP filesystem read/search/report capabilities but no terminal tool and cannot launch Node tests, Bun, package managers, AgentFS, builds, formatters, or git writes. Proof: argv and capability tests in `production-review-gate.test.ts`.
- [x] The reviewer runs in an observable Herdr tab with zero owned repository paths and AgentFS discard-all/no-export semantics. Proof: launcher identity and export assertions.
- [x] The reviewer receives one self-contained, hash-indexed review bundle containing the final audit JSON, all three PRDs, relevant production source/tests/docs, durable reports, and ledger inventory; it is not asked to access the filesystem or regenerate host proof. Proof: `production-review-bundle.test.ts` and task-contract snapshot.
- [x] The reviewer task and worker result record `noTerminal: true`; a fixture that requests terminal execution receives no terminal capability and cannot launch a subprocess. Proof: adversarial reviewer fixture.

### US-004: Reconcile the plan of record

**Description:** As a feature owner, I want issue state to match observable proof so that completion claims are internally consistent.

**Acceptance Criteria:**

- [x] `tasks/prd-production-acpx-worker-backend.md` links both remediation PRDs and records exact current full/Bun/package/matrix/ledger counts from the final audit bundle. Proof: documentation assertions.
- [x] Every parent acceptance checkbox is supported by a concrete bundle record or remains unchecked with a blocker. Proof: checklist-to-evidence map in `final-audit.json`.
- [x] `tasks/prd-package-delegate-graph.md` links both remediation PRDs and preserves public compatibility decisions. Proof: package-docs assertions.
- [x] Historical failed reviews remain in the ledger and are not rewritten; the final PASS entry explicitly supersedes them only after fixes. Proof: ordered ledger entries and audit.

### US-005: Complete the fresh-context audit

**Description:** As a user, I want an independent observable PASS review so that the production implementation can proceed to commit and pull request.

**Acceptance Criteria:**

- [x] A fresh-context reviewer validates every production and lifecycle-hardening criterion against source and the final audit bundle. Proof: schema-valid review report under `agent-output/production-acpx-worker-backend/`.
- [x] Reviewer verdict is `PASS`; any `FAIL` or missing report blocks completion. Proof: report audit command.
- [x] Final production ledger audit passes with zero findings and contains architecture, implementation, matrix, lifecycle hardening, host audit, and final review evidence. Proof: exact ledger audit output.
- [x] Reviewer tab, ACPX session, AgentFS state, temporary evidence, and credential/token files are absent after cleanup. Proof: final cleanup inventory in the audit bundle.

## Functional Requirements

- FR-1: Host gates must run outside an AgentFS worker to avoid nested NFS/FUSE sandboxing.
- FR-2: Every host command must use direct executable/argv boundaries and produce a sanitized structured record.
- FR-3: Evidence bundle hashes and counts must be recomputed from current files immediately before review.
- FR-4: Real-matrix evidence must use production launch, report, settlement, export, and cleanup paths.
- FR-5: No durable evidence may contain a credential, OAuth token, provider response body, raw user prompt, or user-home transcript.
- FR-6: Final reviewer tooling must mechanically remove the terminal capability with ACPX `--no-terminal`, preventing nested tests, builds, package managers, AgentFS launch, and git writes.
- FR-7: Final reviewer remains observable through Herdr and runs with zero owned paths plus discard-all AgentFS semantics.
- FR-8: Historical failed evidence remains immutable.
- FR-9: Parent and umbrella PRDs must match exact final proof.
- FR-10: Commit, push, pull request, publication, merge, and real migration remain forbidden until the final review is PASS.

## Non-Goals

- Change production worker behavior beyond lifecycle-hardening prerequisites.
- Re-run final review blindly under the previous unrestricted environment.
- Retain Claude setup tokens or raw matrix transcripts.
- Rewrite failed review history.
- Publish, merge, or apply real migrations.

## Design / Technical Considerations

- Use one host-side TypeScript audit runner and one review-bundle builder under `extensions/pi-agent-wave/scripts/`. The review bundle must fit in the ACP prompt, identify every section by path and SHA-256, and contain no credential material.
- Store large raw command output only in sanitized referenced files; keep the bundle concise and hash-bound.
- Implement reviewer command denial through the ACPX `--no-terminal` capability boundary, not prompt instructions or PATH wrappers.
- The final reviewer consumes the self-contained prompt bundle with `--no-terminal`; it does not require filesystem or shell capabilities.
- Let `scripts/ledger.ts` remain the final evidence authority.

## Success Metrics

- Host audit bundle reports every required command green with exact counts.
- Real Pi/Codex/Claude production evidence is durable and token-free.
- Reviewer cannot execute a nested AgentFS/test/package command.
- Parent PRD, umbrella PRD, bundle, package artifact, and ledger counts agree.
- Final fresh-context reviewer returns `PASS` and final ledger audit has zero findings.

## Open Questions

- Which minimal read-only command set is sufficient for semantic source review without enabling nested test execution?
- Should raw sanitized host logs remain in `agent-output/` or be reduced to per-command extracts plus hashes?


## Verification

- Deterministic host audit: PASS, 14 direct-argv command records, source unchanged during audit.
- Full Node: 318 passed, 0 failed, 8 skipped across 326 tests.
- Real lifecycle matrix: Pi/Codex/Claude 3 passed, 0 failed, 0 skipped.
- Real production Herdr bridge matrix: Pi/Codex/Claude 3 passed, 0 failed, 0 skipped.
- Bun package matrix: 34 passed, 0 failed.
- npm pack/publish: 64 files, 0 external artifacts.
- Installation rehearsal: PASS.
- Ledger after source-hardening review attempt 2: 18 files, 0 findings.
- Secret scan: 0 findings. Cleanup scan: 0 leaked tabs, 0 AgentFS processes, 0 temporary directories, token file absent.
- Self-contained review bundle: 44 path/SHA-256 sections, mode 0600.

## Decision

**PASS.** US-005 completed through the bundle-completeness split. The fresh-context remediated review in `agent-output/production-acpx-worker-backend/final-review-remediated-fail.json` returned FAIL on five source-level gaps: fail-closed expected-count and stale-evidence enforcement; complete focus cancellation plus attempt-key validation; reuse of one shared cancellation implementation for normal abort and cleanup; per-failure adversarial cleanup and granular inventory proof; and complete state-preservation assertions for direct legacy migrations. The ledger audits 15 files with 0 findings, cleanup is empty, and the secret scan has 0 findings. The source-hardening and bundle-completeness splits both pass. Final reviewer evidence: `agent-output/production-acpx-worker-backend/final-bundle-completeness-review-pass.json`. Final ledger: 21 files, 0 findings.