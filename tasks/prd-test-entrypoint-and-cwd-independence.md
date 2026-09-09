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
- [x] The two tests that skip under one cwd and run under the other are named. **Answered and
      fixed.** `acpx-event-mapping.test.ts` "maps a sanitized real completed transcript…" and
      "…real cancellation transcript…", gated on `existsSync(join(process.cwd(), "agent-output", …))`
      while `agent-output/` exists at the repository root only. From the repository root that file
      reported 5 pass / 0 skipped; from the package directory, 3 pass / **2 skipped**, with both
      transcripts present (1783 and 842 bytes). Silent coverage loss, not a neutral skip: the only
      difference was where the command was typed. Anchored to `repoRoot`, it reports 5 pass /
      0 skipped from either directory.

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

- [ ] Each of the 18 path-construction `process.cwd()` sites is either anchored or annotated.
      **Partly — count now correct at 19.** After the eight-file pass 19 lines still read
      `process.cwd()`; they include legitimate `cwd:` arguments to subprocesses and the matrix
      files' sandbox workspace (Q2), which has not been triaged.
- [ ] Full-suite run from the package directory reports 0 failures, or names each remaining one.
      **Half met, left unchecked on purpose:** down to one failure, named below, but "not fixable
      here" is not established — it is a concurrency interaction, not yet traced to a sibling.
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


## Implementation record — 2026-09-09 (path class closed, one interference failure open)

Authorised by the user's "1b / 2a / 3b" answers. This section replaces the *status* of the
hypotheses above; the hypotheses themselves stay as written, annotated, because they record
what was knowable before the runs.

### Confirmed mechanism (was: hypothesis)

Every one of the 25 was reproduced from **both** launch directories, which is the test US-001
demands before anything gets called confirmed. All 25 are genuine cwd coupling: the seven
affected files give 56 passes and 0 failures from the repository root and 25 failures from the
package directory. Nothing among them was an unavailable-environment case, and nothing was a
"no-longer-true assertion".

The signature is a doubled path segment. Failures tried to open
`extensions/pi-agent-wave/extensions/pi-agent-wave/index.ts`, `…/scripts/delegate_core.py`,
`…/retry.ts`, and to `scandir` `extensions/pi-agent-wave/extensions/pi-agent-wave`. Those come
from `join(process.cwd(), "extensions/pi-agent-wave/…")` where `process.cwd()` is already
`extensions/pi-agent-wave`. `production-audit.ts` builds `join(root, "extensions",
"pi-agent-wave")` internally, so its `root` argument means *repository* root: passing
`process.cwd()` was wrong from the package directory, not merely a different supported mode.

### What changed

- `test/support/repoRoot.ts` (new) exports `packageRoot` and `repoRoot`, derived from
  `import.meta.url`. Depth is measured from `test/support/`, which is one level deeper than the
  existing `test/*.test.ts` anchors, so it is deliberately not the same `../` count; a first
  draft copied the precedent's count and pointed `repoRoot` at `<repo>/extensions`. That was
  caught by running the affected files from both directories, not by reading the code.
- Eight files converted to those anchors: `agentfs-sandbox`, `commands`, `headless-pi-stdio`
  (including an inline Python `sys.path.insert(0, 'extensions/pi-agent-wave/scripts')`, now
  absolute so the child no longer inherits a cwd assumption), `production-audit`,
  `production-review-bundle`, `production-review-gate`, `provider-credential-snapshot`, and
  `acpx-event-mapping` (the silent-skip class).
- `acpx-real-matrix.test.ts` had the same latent defect on its driver path. Fixed for
  consistency, **not verified**: it sits behind `RUN_REAL_ACPX_MATRIX` plus a token-file check,
  so no run here exercises it. Recorded as unverified rather than as a fix.
- `package-portability.test.ts` gained the divergence guard the user asked for: a file under
  `$PI_CODING_AGENT_DIR/lib` whose stem matches a shipped `lib/` file must be byte-identical to
  it. It skips when no agent directory exists, so a clean machine is not failed by it.

### Why the guard checks divergence rather than existence

`lib/jsonc.mjs` exists in both trees right now and the two copies are byte-identical (same
SHA-1, 99 lines each), and the agent-directory copy is live: `scripts/policy-resolver.mjs` and
`scripts/resolve-model.mjs` import it. A "no twin allowed" assertion would therefore have failed
on the day it was written and been weakened within the hour. `lib/model-failover-native.mjs` was
the case where two copies *had* drifted apart, which is the failure the guard needs to catch.

Mutation-checked, against a temporary agent directory (`PI_CODING_AGENT_DIR=/tmp/…`), never the
real one: a diverged twin makes the test fail and names itself
(`agentfs-sandbox.ts diverged from shipped agentfs-sandbox.ts`); restoring the copies to
identical makes it pass again; an agent directory with no `lib/` passes. Runs under Node from
either directory and under Bun from the package directory. The real `~/.pi/agent/lib` was
verified unchanged afterwards.

### Counts, before and after

| launch directory | before | after |
| --- | --- | --- |
| repository root | 438 pass / 0 fail (449 tests) | 438 pass / 1 fail (450 tests) |
| package directory | 411 pass / **25 fail** / 13 skipped | 438 pass / **1 fail** / 11 skipped |
| package directory, `--test-concurrency=1` | — | **439 pass / 0 fail** / 11 skipped |

Both directories now report identical counts and the *same* single failure, which is the point of
G2: launch directory no longer changes the outcome. Skips match at 11 after the
`acpx-event-mapping` fix; they were 11 against 13 before it.

### The one remaining failure, and what is actually known about it

`production-audit.test.ts` "writes a private hash-bound passing bundle" fails in a **full-suite**
run from either directory and passes when its file runs alone. It also fails with all of this
session's changes stashed (`git stash push -u`, baseline re-run, then popped), so it predates the
path work rather than being caused by it — the honest reading of the earlier "438 / 0" figure is
that it was measured under different conditions, not that the class was closed then.

Observed, and now traced: a serial run (`--test-concurrency=1`) from the package
directory gives 439 pass / **0 fail** / 11 skipped, against 438 / 1 concurrently, and the failing
assertion's own payload names the cause:

```
{"stale":[],"cleanup":{"leakedTabs":[],"agentFsProcesses":1,"temporaryDirectories":[],
 "tokenFilePresent":false},"secret":{"files":13,"findings":0},"changed":false}
```

Everything is clean except `agentFsProcesses: 1`. `runProductionAudit` probes live machine state
even when a fake `Runner` is injected, and `summariesValid` treats a non-zero count as a failed
cleanup scan (`production-audit.ts:222`). Twenty-four other test files start AgentFS, so under
concurrent execution a sibling's process is alive at the instant the scan runs. Confirmed by
elimination as well as by the payload: 70 two-file pairings of the audit file against every other
test file produced **zero** failures, and the file passes alone, so this is not attributable to
one poison sibling. Nor is it leftover state — no AgentFS process and no leaked temporary
directory existed on the machine when it was checked, and the serial run is green.

So the assertion asks "is this machine quiet right now?" of a suite whose other files are
deliberately not quiet. Three ways out, none applied, and (a) and (c) touch product code:

- **(a) Inject the cleanup probe** as a parameter defaulting to the real one, so a test covers
  the gate logic against a synthetic quiet machine and a separate check covers the real probe.
  Preferred: the function already takes an injected `Runner`, so this follows an existing seam.
- **(b) Serialize the file or the suite.** Rejected: hides a visible failure behind a command
  nobody types by hand, and taxes every future run given 24 possible contributors.
- **(c) Scope the scan** to processes whose command line references the audit's own workspace.
  Most precise, more work, and it changes what a production audit means by "clean".


Still open after this slice: the runner dimension (US-004), Q2 (matrix files that use
`process.cwd()` as the sandbox workspace on purpose), Q3 (AgentFS containment for relative
owned paths), and Q4 (the real-Pi failover rehearsal spec).
