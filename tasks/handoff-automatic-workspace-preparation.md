# Handoff: automatic workspace preparation before graph dispatch

Status: implemented and verified; attempt 1. Recorded 2026-10-05 against
`a0d3d7df95194a7cc7946876ed96621ebd4bd471`. This work order is the issue;
`product.md` and `specification.md` carry the implemented design. No production installation,
production migration, paid worker run, commit, push or merge is authorized by this plan.

## 1. Overview

Prepare the host workspace automatically before workers launch. Dependency installation
belongs to the supervisor, not to an AgentFS worker whose dependency writes fall outside
its assigned ownership. Also catch an overlapping, uncommitted prior integration before
launching the next implementation worker, not after it has produced a candidate.

The operator chose **approve a workspace recipe once**: approved preparation runs when
needed without repeated prompts; changes to the approved commands require renewed approval.
Repository files and worker messages cannot grant host execution authority.

This follows the existing worker-resource design, but is a finite preparation step rather
than a host service. Host services have disposable per-attempt state; dependencies belong
to the shared workspace and must not be installed concurrently with its active workers.

## 2. Goals

- No implementation worker is launched with a known, avoidable workspace blocker.
- Routine approved preparation needs no manual install command and no repeated approval.
- Installation failure is reported before worker spend; it is not classified as a model failure.
- Ownership audit, candidate base revision and integration preimages remain strict.

## 3. User stories

### US-001: Approve a preparation recipe once

**Description:** As an operator, I want to approve explicit host commands for one workspace
so that delegation can prepare it automatically without treating repository content as authority.

**Acceptance criteria:**

- [x] An operator-owned recipe is bound to a canonical workspace, with explicit executable,
      argv, ordered dependency/baseline commands, readiness check, dependency-input paths,
      timeout and approval. Missing, changed or revoked approval prevents host commands.
      Proof: new preparation tests under `extensions/pi-agent-wave/test/`, cases
      "unapproved recipe executes no command" and "changed recipe requires renewed approval".
- [x] Workspace recipes are resolved automatically by workspace, not attached by every worker
      dispatch. A workspace without a recipe keeps existing dispatch behaviour and reports that
      automatic preparation is not configured. No package-manager guessing occurs.
      Proof: cases "approved recipe is selected by canonical workspace" and
      "unconfigured workspace preserves dispatch behaviour".
- [x] Repository data and worker answers cannot create approval; argv remains an array and
      execution does not interpolate a shell string. Approval of a command invoking repository
      scripts must explicitly cover those scripts; changed script bytes require renewed approval.
      Proof: "repository script changes invalidate command approval" and
      "argv containing spaces and metacharacters arrives unchanged", exercising real subprocesses.

### US-002: Prepare before launch, without repeated installs

**Description:** As a supervisor, I want approved preparation to finish before worker launch
so that the worker inherits functional dependencies and never needs to install them.

**Acceptance criteria:**

- [x] Dispatch runs preparation on the resolved host workspace before launcher `init`/`start`,
      attempt directories, agent registration or model invocation. Baseline commands must exit
      successfully before launch. Proof: a real temporary Git/npm workspace through the extension
      dispatch path records installation, dependency loading and baseline completion before the
      intercepted paid-worker launch. Test doubles cover paid execution only, not npm or Git.
- [x] A second dispatch in the same run with unchanged dependency inputs and successful readiness
      does not reinstall or repeat the already-successful preparation baseline. Changed inputs,
      a new run, or missing dependencies invalidate readiness; checks are not presence-only.
      Proof: "unchanged preparation is reused", "changed lockfile invalidates readiness" and
      "deleted dependency invalidates readiness", loading an actual installed local npm package.
- [x] Concurrent dispatches cannot run installations concurrently in one workspace. No install
      occurs while a worker using that workspace is active; a necessary refresh blocks with an
      actionable reason rather than altering its dependencies mid-turn. Proof: real subprocess
      overlap test plus graph-store cases for active workspace workers and retries.
- [x] Install/baseline failure, timeout and cancellation prevent launch, keep bounded retained
      diagnostic output, and never publish a success receipt. They name the failed phase and
      recovery action without spending provider fallback attempts. A later successful retry can
      recover without duplicate successful installation. Proof: real failure/timeout/cancellation
      subprocess cases and a success-after-failure dispatch case.
- [x] Preparation commands may write declared dependency state and disposable scratch only,
      not candidate source files. Unexpected source changes block dispatch and are reported;
      preparation never resets, stashes or deletes operator changes to conceal them. A failed
      partial dependency tree is marked not ready, not rolled back by an invented npm guarantee.
      Proof: "preparation source mutation blocks launch" preserves the mutation for inspection.
- [x] Both transports use the same dispatch preparation path; retries and read-only roles can
      reuse ready dependencies. Home and operational runs retain their existing behaviour in
      this increment. Proof: dispatch tests for headless/Herdr, retry and read-only operations.

### US-003: Catch integration sequencing before spending a worker turn

**Description:** As a supervisor, I want dispatch to identify uncommitted earlier integrations
that overlap the next slice so that committing cannot invalidate an already-produced candidate.

**Acceptance criteria:**

- [x] A repository implementation dispatch whose ownership overlaps dirty output from an
      earlier applied integration is refused before preparation or launcher creation. The
      reason names the workspace and affected paths, requesting an authorized commit before
      dispatching a replacement worker. Proof: extend
      `extensions/pi-agent-wave/test/dispatch-git-precondition.test.ts` with a real journaled
      integration and real Git status; no worker, attempt or private directory is created.
- [x] Directory ownership and deleted paths are included; clean committed output and disjoint
      pending slices are not blocked. Ordinary operator dirt is not silently committed or
      discarded. Proof: directory/deletion/commit/disjoint cases with real temporary Git repos,
      alongside the existing `test/integration-sibling-race.test.ts` assertions.
- [x] The settlement fallback no longer recommends committing beneath an already-launched
      candidate. HEAD/preimage checks and sibling fences are unchanged. Proof: updated message
      assertion in `test/integration-sibling-race.test.ts`; existing
      `test/runtime-integration.test.ts` and `test/runtime-candidate-integration.test.ts` pass.

## 4. Functional requirements

- **FR-1:** The system must select a once-approved, operator-owned workspace recipe automatically.
- **FR-2:** The system must run finite preparation on the host before dispatch creates a worker.
- **FR-3:** The system must distinguish approved command identity from dependency-input freshness;
  dependency changes rerun preparation, while changed commands/scripts need renewed approval.
- **FR-4:** The system must serialize workspace preparation and refuse dependency mutation while
  workspace workers are active, across runs and supervisor processes, not only within one call.
- **FR-5:** The system must retain readiness and failure evidence, validate it on reuse/resume,
  and propagate real exit, cancellation and timeout outcomes without model failover.
- **FR-6:** The system must check conflicting uncommitted prior integrations before implementation
  dispatch, never commit automatically, and never relax integration checks.
- **FR-7:** The system must expose progress and actionable blockers in terminal and headless/ACP
  results. Worker instructions say dependencies are host-prepared and missing ones are reported,
  not installed. Recipe configuration is optional for backwards compatibility.

## 5. Non-goals

- Ignoring or granting ownership of `node_modules`, or ignoring all gitignored paths.
- Arbitrary repository-defined hooks, inferred package-manager commands, new package-manager
  adapters, automatic commits, relaxed HEAD checks, or unattended authorization escalation.
- Moving candidate-generating commands into host services or restarting existing workers.
- Guaranteeing an installer rolls back dependency state, or proving paid-provider compatibility
  without separate live-run authorization.
- Implementing this work order in the current planning session.

## 6. Design and technical considerations

Observed extension entry point: `extensions/pi-agent-wave/index.ts`, `op=dispatch`, resolves
`dispatchCwd`, validates ownership/Git and then calls launcher `init`/`start`. Place both new
checks before those launcher calls. Check integration blockers before mutating dependencies.

`extensions/pi-agent-wave/lib/runtime-integration.ts` currently has private `appliedHere`
(exact-path applied-journal membership), and `prepare` checks both HEAD and dirty preimages.
Expose a focused journal-backed dispatch query rather than duplicating journal interpretation;
expand prospective owned-directory coverage without changing settlement semantics.

Use the existing operator-registry pattern from `lib/host-services.mjs` for command authority,
but keep finite workspace preparation separate from per-attempt host service lifecycles.
`lib/runtime-process.ts` demonstrates shell-free argv execution and bounded output capture;
reuse appropriate primitives rather than fabricating a runtime worker identity for preparation.

Implement one small workspace-preparation module. Select exact registry filename, receipt/lock
storage and approval interface after a focused implementation design review, recording them
here before code. Receipt identity must include canonical workspace, approved recipe,
dependency-input content and run identity; readiness must be checked before reuse. Approval
must not authorize newly changed repository scripts simply because argv is unchanged. A
cross-process workspace lock must not clear a lock held by a live process.

Minimal scope is an operator-approved npm recipe and a real local-package installation slice;
explicit executable/argv recipes allow other tools without inventing automatic discovery.
Install scripts run with host access, so approval must state that consequence plainly.

Affected existing surfaces: extension dispatch, integration query/message, supervisor contract,
root and package READMEs, `product.md`, `specification.md`, and preparation/dispatch tests.
New module/test paths and any persistent schema change must be added to this work order before
implementation. Do not change graph topology, retry budgets or ownership defaults.

## 7. Success metrics and completion proof

Proof is tests, not an estimated probability of being flawless:

- Approved unchanged preparation installs once, baseline passes and worker launch follows it.
- Dependency freshness failure never reaches worker launch.
- An overlapping uncommitted prior integration spends no worker turn.
- Existing strict integration and audit tests remain green without weaker assertions.

Run the repository completion command from `AGENTS.md`:
`node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, plus
`git diff --check`, and package `npm run typecheck`. Run the package-focused checks and real
Node-only installation rehearsal specified there. Preserve skips and missing resources in the
report. Test a bounded real npm/local-package slice and AgentFS dependency inheritance; fake
only paid model execution. Any live provider run needs separate authorization.

## 8. Implementation and verification

The authorization policy is settled: approve each workspace recipe once, not each run.
Implementation design checkpoint (recorded before source changes):

- Add `lib/workspace-preparation.ts`, `scripts/workspace-preparation.ts`,
  `test/workspace-preparation.test.ts`, `test/dispatch-workspace-preparation.test.ts` and
  `test/support/workspace-preparation-fixture.ts`.
  No graph schema migration. Extend the existing dispatch/Git and integration tests.
- The optional operator registry is `<PI_CODING_AGENT_DIR>/workspace-preparation.jsonc`.
  It must be an operator-owned private regular file outside the workspace. Its `workspaces`
  array contains canonical `workspace`, `install` and `baseline` command arrays, one
  `readiness` command, `dependencyInputs`, `scriptInputs`, `writePaths` and `timeoutMs`.
  Commands have an absolute `executable` and string-array `args`; no shell interpolation.
  `scriptInputs` declares every repository script and transitive script/config input the
  commands execute. Repository executables (including extensionless scripts) and direct repository
  script arguments must be covered; npm script
  definitions are bound separately from dependency versions. Approval explicitly attests
  completeness of this declaration and acknowledges arbitrary host access.
- The CLI `node --experimental-strip-types scripts/workspace-preparation.ts
  approve --workspace <root> --host-access` records the recipe/script identity in a separate
  private operator approval file under the agent directory. `revoke` removes that approval;
  `status` is read-only. Dispatch never creates approval. Registry changes require renewed
  approval, except dependency-input bytes, which affect freshness rather than authority.
- A private directory under the workspace's real Git metadata stores the cross-process lock,
  run-scoped receipts, bounded diagnostics and references to dispatched operations in their
  graph databases. Both configured and unconfigured repository dispatches hold the same lock
  through registration, preventing a launch/install race. References are read using read-only
  SQLite across runs and databases; unconfirmed launches fail closed rather than being inferred
  dead. The launch reservation is retained before calling `start`; a confirmed unsuccessful
  launcher exit releases it, but an exception/identity-registration failure preserves it for
  reconciliation. An SDK exec result with `killed:true` is also unconfirmed, not evidence that
  a detached worker stopped: retain the reservation/run directory, then block a dependency
  refresh until reconciliation. Scope this handling to repository preparation; home/operations
  keep their previous lifecycle behaviour. The supervisor contract must wait for reconciliation
  before redispatching an unconfirmed launcher. Verify this in a paid-start-only double with
  real preparation. Concurrent stale-lock reclamation uses a separate exclusive reclamation
  directory, so one reclaimer cannot erase another dispatch's newly acquired live lock. A lock
  held by a live process is never reclaimed. Busy preparation blocks with retry guidance instead
  of queuing a second installer.
- Readiness is a real operator-approved dependency-loading command, executed on every reuse.
  Successful install checkpoints can survive a failed baseline only when inputs are unchanged
  and readiness succeeds; only completed preparation publishes a success receipt. A new run,
  changed inputs or failed readiness requires refresh, which active workers forbid. Install,
  baseline and readiness output is bounded and retained even on timeout or cancellation.
- Source snapshots include Git-tracked, untracked and ignored worktree files outside declared
  `writePaths`; tracked source cannot be declared dependency state. HEAD and index identities
  are checked too. Commands may write dependency/scratch paths only. Unexpected writes remain
  in place for inspection and invalidate readiness. Host execution is approved, not sandboxed:
  worktree auditing does not promise confinement of a trusted installer outside the workspace.
- Expose a journal-backed dirty-applied-output query for dispatch. Refusal leaves the pending
  operation and provider budgets unchanged and precedes preparation. For Git-checked journal
  entries, compare the path's latest committed change at the integration base and current HEAD:
  once that path has been committed/superseded, later operator dirt is not an uncommitted prior
  integration. Add the real-Git `committed-then-operator-dirt` dispatch case. Settlement instead asks
  to discard/replace the launched candidate after an authorized commit; it never suggests
  committing underneath that candidate.

Do not implement a general task scheduler or an elaborate recipe language. No production registry or dependency tree is changed by this implementation.

Progress evidence: `agent-output/automatic-workspace-preparation/targeted.log` records a fresh
67-test pass, including the journaled directory/deletion/commit/disjoint/operator-dirt cases and
`committed-then-operator-dirt`, plus the unchanged strict runtime integration tests. US-003 is
checked against those results. Workspace recipe, reuse, real npm/AgentFS inheritance, transport,
read-only retry, active-worker and subprocess failure cases also pass. The final full gate verifies
all acceptance criteria, including `repository data cannot grant preparation approval` and the
focused red-then-green `extensionless repository executables must be pinned by script approval`
case. Both READMEs, `product.md`, `specification.md`, `AGENTS.md`, and the supervisor contract
agree with the implementation; `test/supervisor-contract.test.ts` verifies pending-blocker guidance.

Verification isolation correction: the initial AgentFS inheritance test set `AGENTFS_HOME` but not
`HOME`, creating four host session cache directories. Their copied SQLite overlay records all named
this test's disposable `workspace-preparation-*/repo` roots; no active sessions or referencing
processes remained. Those exact test directories were removed after copies were retained under
`agent-output/automatic-workspace-preparation/restore/test-agentfs-cache/`, and the host run directory
was checked empty. The test now sets both HOME variables to its temporary root. Two early typecheck
invocations also used npm's default cache: their verified typecheck logs were copied and removed;
each npm log records rotation of one older log, which cannot be restored. Subsequent verification
sets a private npm cache under this increment's evidence directory. No credentials, routing,
production registry, installed dependency tree, graph database or Pi settings were changed.

Final gate (2026-10-05, uncommitted `automatic-workspace-preparation` based on
`a0d3d7df95194a7cc7946876ed96621ebd4bd471`):

- `node-gate.log`: 737 Node tests, 726 passed, 0 failed, 11 opt-in skips; aggregate rechecked.
- `typecheck.log`: package typecheck passed. `diff-check.log`: clean.
- `bun-gate.log`: real Bun 1.4.2 package checks, 50 passed, 0 failed. Bun's native binary
  came from a temporary npm installation under this increment's private evidence tree,
  with lifecycle scripts disabled; no global Bun installation or fake binary was used.
- `installation-rehearsal.log`: real Node-only installation rehearsal, 1 passed, 0 failed.
- `pack.log` and `publish.log`: dry runs passed, 91 packed entries; both preparation helpers
  are included and generated evidence is excluded.
- The first full-gate invocation used a login shell, which selected `/usr/bin/python3` 3.9.6
  instead of the available Python 3.14.7 and failed on the pre-existing `tomllib` import.
  `node-gate-login-path-failure.log` retains that failed run. The final gate preserves the
  normal PATH; no Python code or assertion was weakened.
- All acceptance criteria are checked against these fresh results. No paid provider run,
  production installation/migration, commit, push or merge was performed. The host AgentFS
  session cache is empty and no process names this increment's scoped temporary test roots.

Final isolation follow-up: `test/runtime-watch.test.ts`'s registration fixture defaults its
context cwd to the real checkout. The optional unconfigured preparation guard therefore wrote
four synthetic references in `.git/pi-agent-wave-preparation/launches.json`. Their database paths
are this fixture's disposable `agent-list-open-*` trees, all absent, and their owner processes have
exited; its init/start callbacks are entirely mocked, so no worker was launched. Set this fixture's
cwd to its temporary directory without weakening its UI assertions. Preserve the proven test-only
metadata by moving it to `restore/test-repo-preparation-metadata/` under this increment's evidence,
then rerun the full gate and verify that the real checkout metadata remains absent.
A temporary diagnostic trace identified the remaining empty-cache creators: missing init cwd in
`test/acpx-collect-convergence.test.ts`, `test/dispatch-owned-path-precondition.test.ts` and the
`pendingThinker` helper in `test/host-services.test.ts`. Set their init contexts to their already
allocated temporary workspaces; preserve every existing assertion. The diagnostic change was
restored byte-for-byte before continuing. These fixture corrections are part of verification
isolation, not a change to dispatch behaviour.

Final follow-up verification is complete: `node-gate.log` is the post-correction 737-test run
(726 passed, 0 failed, 11 opt-in skips), and all acceptance criteria are checked. It includes
`an interrupted launcher retains its reservation and blocks dependency refresh`, asserting that
the real initialized run directory survives and that changed dependencies cannot trigger another
install or launch. `interrupted-launch-red.log` retains its pre-fix failure. The supervisor contract
waits for reconciliation; home/operations bypass the new interruption handling.
The generated checkout metadata was moved, not deleted, to the restore locations above; the
final full suite leaves `.git/pi-agent-wave-preparation/` absent and the host AgentFS cache empty.
Typecheck, Bun package checks and package dry runs also passed after the fixture corrections.
Temporary diagnostic instrumentation was restored byte-for-byte and does not ship.
The status review also found a stray `installed pi integration to ` directory whose nesting
contains the initial `workspace-preparation-*` fixture agent paths. It was preserved by reversible
move to `restore/test-shell-integration-artifact/`; no contents were deleted. The final checkout
status contains only the intended implementation, tests and documentation, with HEAD unchanged.
