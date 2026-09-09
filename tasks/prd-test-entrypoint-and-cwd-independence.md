# PRD: Canonical test entry point and cwd independence for package tests

**Status:** Open — plan of record. No implementation authorized by this file.
**Follows:** `tasks/prd-cwd-independent-test-paths.md` (that slice fixed three files; it did
**not** close the defect class, and its closing note understated what remained).

## Overview

Two related problems, one root cause.

1. **The suite's results depend on where it is launched from.** Identical test count (449),
   different outcomes:
   - from the repository root: 438 pass / 0 fail / 11 skipped (verified twice this session,
     before and after the `import.meta.url` fix)
   - from `extensions/pi-agent-wave/`: 411 pass / **25 fail** / 13 skipped
2. **No canonical runner exists for parts of the suite**, so files drift into a state where
   nothing executes them and their failures are invisible.

The root cause is not cwd alone. It is that "the directory the tests assume" was never
defined. `process.cwd()` was used to mean "repository root", but the repository root is not a
discoverable concept: `package.json`, `tsconfig.json` and `pyproject.toml` all live in
`extensions/pi-agent-wave/`, not at the repo root. So two launch directories are equally
"valid", and they disagree.

This matters beyond tidiness: `settings.json` currently loads the package by absolute path
(`/Users/spotted/projects/pi-agent-wave-new-design/extensions/pi-agent-wave`), while an npm
install puts the same code under a different tree. Anything that derives a path from the
launch directory is wrong in exactly the configuration a real user has.

## What is actually installed (this gates any "rehearsal" plan)

Verified 2026-09-09 on this machine, all reachable on `PATH`: Pi 0.84.1 (Homebrew Cellar),
ACPX 0.13.2, Bun 1.3.14, Node 22.16.0. Consequence: **the 25 failures are not
"environment unavailable"**, and must not be waved away as such. The 11→13 skip difference is
a separate question and needs its own classification.

## Goals

- G1. One documented, canonical way to run the package suite, with the working directory part
  of the contract.
- G2. Every test file gives the same result from either launch directory, **or** is explicitly
  marked as requiring one, with the reason recorded.
- G3. No test file exists that no runner collects.
- G4. Coverage that silently changes with cwd (the two extra skips) is either made stable or
  explained in writing.

## Non-Goals

- Rebuilding a fake Pi harness. Prohibited by the project rule against simulating an
  invocable system.
- Weakening or deleting an assertion to reach green. The 25 are triaged, not deleted.
- Changing `parsed_owned_paths()` resolution semantics. That is a separate design question
  (see Open Questions Q3).
- Touching the ~28 unrelated dirty entries in `~/.pi/agent`.

## Triage findings so far (read-only; input to the work, not the work itself)

Failure counts come from a full run from the package directory. Attribution is at file level;
per-test mechanism is inferred from locator lines and is **not yet confirmed**.

Failing files: `acpx-real-matrix`, `production-audit`, `production-review-bundle`,
`production-review-gate`, `provider-credential-snapshot`, `agentfs-sandbox`,
`headless-pi-stdio`, `commands`, `supervisor-ux`.

Remaining `process.cwd()` use in `test/`: **18 path-construction lines across 15 files**,
plus 8 deliberate `cwd: process.cwd()` and 9 other uses. Examples that need classifying, not
guessing:

- `acpx-real-matrix.test.ts` — `const ROOT = process.cwd()`, and
  `baseDir: process.cwd()` fed to `buildAgentFsInvocation`; the sandbox scope itself moves
  with cwd.
- `production-audit.test.ts` — `auditCommands(process.cwd())`,
  `runProductionAudit(process.cwd(), …, runner("typecheck"))`; runs real `npm run typecheck`,
  whose meaning changes with cwd because `tsconfig.json` sits in the package directory.
- `acpx-headless-real-matrix.test.ts` / `acpx-production-matrix.test.ts` — `ROOT` from cwd.

Runner dimension, also unresolved: running those same eight files under **Bun from the repo
root** gives 26 pass / 4 fail / 4 errors, while the same files pass under Node from the repo
root. 52 test files import `node:test` directly, 13 go through `test/test-api.mjs`, which
selects `bun:test` when `globalThis.Bun` exists. So runner and cwd are two independent
variables, and only one combination is currently exercised: Node from repo root.

## User stories

### US-001: Classify the 25 before changing anything

**Description:** As the implementer, I want a per-failure classification, so that fixes target
real defects instead of whatever makes the run go quiet.

**Acceptance criteria:**

- [ ] A table exists listing each of the 25 with: file, one-line mechanism, and one of
      {genuine cwd coupling, gate that legitimately requires repo root, runner-dependent
      behaviour, real defect unrelated to cwd, no-longer-true assertion}.
- [ Each entry cites the command whose output produced it, and no entry's mechanism is
      marked "confirmed" without a run that reproduces it from both directories.
- [ ] The two tests that skip under one cwd and run under the other are named, with which one
      they are and whether that is silent coverage loss.

### US-002: Define the canonical entry point

**Description:** As a maintainer, I want one documented command including its working
directory, so that "the suite is green" means one thing.

**Acceptance criteria:**

- [ ] `AGENTS.md` and `extensions/pi-agent-wave/README.md` state the canonical command and its
      working directory, and state explicitly whether the package-directory launch is
      supported.
- [ ] A single script or documented command exists that runs the suite; `grep` for ad-hoc
      per-file invocations in docs returns no competing variants.
- [ ] Running the canonical command twice gives the same counts (deterministic, no cwd
      dependency smuggled in through the launcher).

### US-003: Make the 15 remaining files cwd-independent, or scope them out

**Description:** As a maintainer, I want path lookups anchored to the code, so that results do
not depend on where I typed the command.

**Acceptance criteria:**

- [ ] Each of the 18 path-construction `process.cwd()` sites is either converted to an
      `import.meta.url` anchor, or annotated as intentionally launch-dependent with the
      reason, and the count in this PRD is updated to match reality.
- [ ] Full-suite run from `extensions/pi-agent-wave/` reports **0 failures**, or a PRD blocker
      entry names each remaining failure and why it is not fixable here. Not "fewer failures".
- [ ] The `deepEqual` assertion in `acpx-herdr-bridge.test.ts` still fails when pointed at a
      missing helper (mutation check re-run, result recorded), proving the guards stayed
      binding.

### US-004: Close the runner-variable question

**Description:** As a maintainer, I want to know whether Bun support is real or incidental, so
that a second runner does not silently mean a second, weaker suite.

**Acceptance criteria:**

- [ ] A written decision on whether Bun is a supported runner for `test/*.test.ts`. If
      unsupported, the `test-api.mjs` Bun branch gets a documented rationale; if supported, the
      four Bun errors and four Bun failures from the repo-root run are individually triaged.
- [ ] `npm run typecheck`, the Node gate, and the package-focused Bun gate are each runnable
      from a documented directory, with results recorded in this file.

## Design notes

- `settings.json` loads the package by absolute path today. Any path fix should be judged
  against "would this also be true if the package were installed under `~/.pi/agent`", since
  that is the shipped shape.
- `test/support/` is not dead: `sourceRoot.ts` is imported by five live test files. Do not
  delete by association with the retired rehearsal files.
- In `~/.pi/agent`, `lib/` is imported by four live scripts (`scripts/adaptive-route.mjs`,
  `pipeline-route-telemetry.mjs`, `routing-feedback.mjs`, `routing-report.mjs` import
  `lib/adaptive-routing.mjs`). Only `lib/model-failover-native.mjs` looks unreferenced, and
  that has one unverified gap, recorded in its own issue.

## Open questions

- **Q1 — canonical cwd.** Repo-root-only (narrow the "must be cwd-independent" rule and
  document one launch directory), or dual-cwd support (finish the class, US-003 at 0 failures)?
  Recommended: finish the class, because the npm-install shape gives us no repo root at all.
- **Q2 — do we fix or fence the matrix files?** `acpx-real-matrix` and friends treat
  `process.cwd()` as the sandbox workspace on purpose. Making them cwd-independent may mean
  pinning a temp workspace instead.
- **Q3 — relative owned paths.** `parsed_owned_paths()` resolves relative entries against the
  worker cwd, and `production-review-bundle.ts` hardcodes a workspace-relative path. Whether
  that is a defect depends on whether AgentFS containment already denies writes outside
  `--workspace`; unverified here, and it should be verified rather than assumed.
- **Q4 — real-Pi failover rehearsal.** Needs a spec for what it must pin. Not scheduled by
  this PRD.