# Handoff: refuse a dispatch whose owned paths escape the working directory

Status: implemented on this tree, uncommitted. Opened and implemented 2026-10-03 against
`0a5c4f9615ed6f2a08a025a86523e417612303b9`. Not committed, branched or pushed: the operator has
not asked.

## 1. Summary

A slice whose `ownedPaths` lie outside the dispatch working directory can never succeed, but
nothing refuses it. The worker launches, does its whole turn, and then staging fails with an
`owned_path_escape` audit error whose classified reason is `unclassified`, the diagnosis-free
bucket. One worker turn of provider spend and wall-clock is burned on an outcome that was
impossible before it started, and the operator is handed a failure naming the path but neither the
cause nor the fix.

This work order adds a dispatch-time precondition that refuses such an operation before anything
is launched, reusing the `[dispatch_precondition]` contract that already exists for the coding
Git check.

## 2. Evidence for the defect

Observed on this tree at `main`, read from the source:

- `extensions/pi-agent-wave/lib/agentfs-sandbox.ts:207-230` — `ownedRelativePaths` computes
  `relative(realBase, absolute)` and emits `owned_path_escape` for a `..`-prefixed result.
- `extensions/pi-agent-wave/lib/runtime-staging.ts:66-67` — staging runs that audit on every
  settlement; `readOnly` filters only `audit_error`, so `owned_path_escape` fails the attempt in
  read-only and owned-write mode alike.
- `extensions/pi-agent-wave/test/agentfs-sandbox.test.ts:337` — an escaping owned path surfaces as
  an `AgentFS audit error` message.
- `extensions/pi-agent-wave/retry.ts:62-66` — the cost is **one** worker turn, not three. Verified by
  executing `classifyFailure(agentFsAuditErrorMessage([...]))`: an `owned_path_escape` message carries
  the `[owned_path_escape]` token, matched ahead of the transient scan, returning
  `{kind: "permanent", reason: "unclassified"}`. An `audit_error` message in the same format returns
  `{kind: "transient", reason: "agentfs-audit-error"}`. An earlier draft of this work order claimed the
  escape was transient and cost the full three-attempt budget; that was wrong. The value of the change
  is the saved worker turn plus a named reason and a remedy, not budget preservation.
- `extensions/pi-agent-wave/scripts/delegate_core.py:451,790` — `parsed_owned_paths` absolutizes
  entries against the dispatch cwd and performs no containment check, by design; the existing
  `test/owned-path-normalization.test.ts` pins that an escaping entry still normalizes.

Field report (2026-10-03, a job-hunter slice): `base_dir` was
`/Users/davidepugliese/.job-hunter` while the declared owned path was
`/Users/davidepugliese/.pi/agent/backups/ats-originals-20261003`. The worker spent its turn probing
NFS mounts, the AgentFS `delta.db` schema and the sandbox allow-list trying to find a bypass,
because nothing told it the slice was unsatisfiable. That investigation is itself the hazard
`AGENTS.md:33` warns about: a process that reaches an absolute host path writes outside the overlay
and the audit sees nothing.

## 3. Approach

Refuse at the same point and with the same mechanism as the existing coding Git precondition, in
`index.ts`, not in `delegate_core.py`. That placement is what makes the refusal cheap and
actionable: it runs before `init`, so no run directory, attempt, agent or worker ever exists, and
`retry.ts:62` classifies a `[dispatch_precondition]`-prefixed message as **permanent**
`dispatch-precondition` ahead of every transient pattern, so the three-attempt budget is not spent.

1. Extract the containment rule from `ownedRelativePaths` into one exported pure helper in
   `lib/agentfs-sandbox.ts` and have `ownedRelativePaths` call it. One rule, two call sites, no
   drift. The resolution order must stay exactly what staging does today: `resolve(baseDir, entry)`,
   then `realpathExistingPrefix`, then the `relative()` escape test.
2. In the `op=dispatch` branch of `index.ts` (currently `index.ts:941-967`), after `dispatchCwd` is
   resolved and alongside the `implement` Git check, run the helper over
   `operation.owned_paths_json` against `realpathSync(dispatchCwd ?? process.cwd())`. The check
   applies to every node, not only `implement`; an empty owned-path list is a no-op, which keeps
   read-only research searches (`specification.md:480`) unaffected.
3. On a violation, build a `[dispatch_precondition]` reason, call
   `graphStore.retryRuntimeAttempt` fenced to the dispatched counters exactly as the Git check
   does, emit `progress("dispatch_refused_by_precondition", …)`, and return
   `{dispatched: false, blocked: "precondition", reason, baseDir, …}`.

The refusal message must let the next agent proceed without investigation. It names the base
directory, each offending path, why it cannot work, and both remedies:

```
[dispatch_precondition] owned path escapes the dispatch working directory; a worker writes only
inside the AgentFS copy-on-write overlay rooted there. base_dir <B>; owned path <P>. Remedy:
declare owned paths under <B> (relative entries resolve against it), or dispatch this operation
from the directory that contains <P>, then resolve this operation with retry, or abort the run.
```

Whole-base ownership is refused in the same check with its own sentence, because
`auditAgentFsChanges` is called without `ownWholeBase` at `runtime-staging.ts:66` and would reject
it at settlement for the same reason.

## 4. Affected components

| Path | Change |
| --- | --- |
| `extensions/pi-agent-wave/lib/agentfs-sandbox.ts` | Export the containment helper; `ownedRelativePaths` delegates to it |
| `extensions/pi-agent-wave/index.ts` | New precondition in the `op=dispatch` branch |
| `extensions/pi-agent-wave/test/dispatch-owned-path-precondition.test.ts` | New; modelled on `dispatch-git-precondition.test.ts` |
| `specification.md` | §1.1 dispatch-precondition paragraph and §5.2 step 8 record the new refusal |
| `extensions/pi-agent-wave/README.md` | The dispatch-refusal paragraph (currently line 326) gains the owned-path case |
| `AGENTS.md` | The AgentFS hazard bullet states that containment is now enforced at dispatch |

## 5. Acceptance criteria

Each criterion names the artifact that proves it. A criterion is checked only when that artifact
exists and passes on this tree.

- [x] **AC1 — an escaping owned path is refused before launch.** `test/dispatch-owned-path-precondition.test.ts`,
      case "an escaping owned path is refused before any worker, attempt or run directory exists":
      asserts `dispatched: false`, `blocked: "precondition"`, no `init`/`start` invocation, no new
      `/tmp/delegate-graph-herdr-*` directory **carrying this run's id**, `store.agents(runId).length === 0`
      and `runtimeAttemptByOperation(operationId) === undefined`. Passes. The directory assertion was
      first written as a before/after diff over all of `/tmp` and failed once in a full-suite run,
      picking up directories other test files created concurrently; scoping it to the run's own id is
      race-free, and the gate was then run twice to confirm.
- [x] **AC2b — the settlement-side classification this replaces is pinned.** Case "an escaped owned
      path is permanent at settlement too, while an unreadable overlay path stays transient" asserts
      that the `[owned_path_escape]` token survives message formatting, that the escape classifies
      `{permanent, unclassified}`, and that an `audit_error` still classifies
      `{transient, agentfs-audit-error}`. Passes.
- [x] **AC2 — the refusal is permanent, not transient.** Same case: `classifyFailure(reason)`
      deep-equals `{kind: "permanent", reason: "dispatch-precondition"}`, operation `failed` with
      `classifier_reason: "dispatch-precondition"`, run `awaiting_user`. Passes. The settlement-side
      behaviour it replaces is pinned in the same file ("an escaped owned path is permanent at
      settlement too, while an unreadable overlay path stays transient"): also permanent, but as
      `unclassified`, and only after a worker turn has been spent. The improvement is the saved turn
      and the named reason, not a saved retry budget. Note on the mutation run below: it ends in
      `worker-credential-preflight` with `transient_attempts: 1` because the fixture's route has no
      credential, so it never reaches staging; that is the dead route, not evidence about escape
      classification, and it is not cited as such.
- [x] **AC3 — the message tells the next agent what to do.** Same case asserts the reason starts
      with `[dispatch_precondition]`, names the resolved base directory and the offending path, and
      contains "declare owned paths under", "dispatch this operation from the directory that
      contains" and "resolve this operation with retry, or abort the run". Passes.
- [x] **AC4 — contained owned paths still dispatch.** Case "contained owned paths, relative or
      absolute, still reach the launcher" dispatches `["src/a.ts"]`, an absolute in-base path, and a
      mixed pair; each reaches `blocked: "preflight"` with `start` invoked. `parsed_owned_paths` was
      not touched and `test/owned-path-normalization.test.ts` passes unmodified in the gate below.
- [x] **AC5 — whole-base ownership is refused with its own message.** Case "ownership of the whole
      working directory is refused with its own remedy": reason matches "cover the whole working
      directory" and "declare the specific files or subdirectories the slice writes". Passes.
- [x] **AC6 — dispatch and staging agree on containment.** Case "the same path set produces the same
      escaping subset at dispatch and at audit" runs a real `agentfs run` (v0.6.4) to produce a
      delta, then asserts `ownedRelativePaths(...).errors` and the `owned_path_escape` subset of
      `auditAgentFsChanges(...).errors` name the same paths over a five-entry set covering
      in-base, nested, sibling, outside and whole-base shapes. Passes.
- [x] **AC7 — mutation proof.** Replacing the precondition's guard with `if (false)` fails both
      refusal cases (3 pass, 2 fail) and leaves the other three green; `index.ts` was restored from
      a verified copy and re-hashed byte-for-byte
      (`7c1be1867387a9aca4b068dd4f23b6ea3be09b221f32d4c30ce11b3fe1fc3b0f` before and after).
- [x] **AC8 — completion gate.** Run on this tree 2026-10-03, after the §2 correction:
      `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` →
      **616 tests, 84 suites, 605 passed, 0 failed, 11 opt-in skips**, twice in succession. The same
      command with this increment's file excluded → 610 tests, 81 suites, 599 passed, 0 failed,
      11 skips, so the delta is exactly the six new tests and no existing test changed state.
      `git diff --check` clean; `npm run typecheck` in `extensions/pi-agent-wave/` clean.
- [x] **AC9 — documentation synchronized.** `specification.md` §1.1 (second dispatch-precondition
      paragraph), `extensions/pi-agent-wave/README.md` (dispatch-refusal paragraph) and `AGENTS.md`
      (AgentFS hazard bullet) updated in this change.

### Deviation from §3

§3 step 1 proposed extracting a new helper that `ownedRelativePaths` would call. The implementation
instead **exports `ownedRelativePaths` itself**, unchanged apart from its doc comment. Same
property — one rule, two call sites, no duplicated logic — with no new indirection. Only the
refusal's wording is built at the call site (`ownedPathPreconditionReason` in `index.ts`), because
the audit's own `detail` strings name the internal `ownWholeBase` option, which means nothing to an
operator.

### Not verified

No live run was made: this increment is proven by the automated gate and the mutation pair only. A
live measurement would spend provider credit and needs explicit authorization.

## 6. Non-goals, and what each one leaves open

Status of each, verified on this tree rather than assumed.

**Enforcing the checkpoint rule (`AGENTS.md:32`) — already enforced; there is no gap.**
An earlier revision of this section claimed only half the rule was enforced. That was wrong, and it
was wrong because it reasoned from `observeCheckpoint`'s `null` branch at settlement without first
asking whether an unowned checkpoint could ever reach it. It cannot. `store.ts:268-272`
(`validateOperationalCommands`, called from `initRun` for every operations run) resolves the
checkpoint and each owned path against the command's `cwd` and throws
`operational command <id> checkpoint must lie under one of its owned paths` unless the checkpoint is
one of them or sits beneath one. `op=init` is the only point at which a command is declared, so the
rule is enforced before a run exists. `test/runtime-operations.test.ts:52-53` already pins both
failure shapes — a sibling directory and a `..` escape — and
`test/runtime-operations.test.ts` also covers the host-bypass case, where a checkpoint present on the
host with no overlay change fails settlement. All 7 tests in that file pass on this tree.
The `null` return from `observeCheckpoint` therefore means something narrower and legitimate: the
checkpoint was validly owned but the worker never wrote it.

The only unverified question left in this area is a possible realpath asymmetry: init compares with
`resolve()` while staging realpaths owned paths, so a symlinked owned path could in principle stage
under a different relative path than the checkpoint matches. Contrived, unobserved, and not
investigated — recorded as a question rather than a defect.

**Leaving `parsed_owned_paths` and `auditAgentFsChanges` alone — correct, with one residual gap.**
The new check is strictly earlier and never stricter, and AC6 pins that it refuses exactly what
settlement would. The gap: it lives in the `delegate_graph` dispatch branch, so it covers every
production dispatch but not a direct `python3 scripts/delegate_core.py start \u2026`, which
`test/support/runtime-result-probe.py`, `test/support/failure-bundle-driver.py` and the real-matrix
tests use. Closing it would mean a second containment check in `delegate_core.py` as defence in
depth. Not obviously worth it while no production path reaches `start` directly; recorded so the
next person decides deliberately.

**Leaving the transient classification alone — correct, and for a better reason than stated.**
The original wording implied escapes were transient and should stay so. They are not transient: the
`[owned_path_escape]` token makes them permanent `unclassified` (§2). What must stay transient is a
genuine `audit_error`, an overlay path the audit could not read, where a re-read can succeed. Both
halves are now pinned by "an escaped owned path is permanent at settlement too, while an unreadable
overlay path stays transient". A possible small improvement, not taken here: give the escape its own
classifier reason instead of `unclassified`, so a settlement-side escape is as legible as a
dispatch-side one.

**Leaving the sandbox allow-list alone — correct, and should stay a non-goal.** Widening
`--no-default-allows --allow <privateDir>` so a worker could write the path it declared would delete
the isolation the audit depends on: the overlay is what makes a worker's writes reviewable before
they touch the host. The defect is a slice declaring the wrong path, and it is fixed by refusing the
slice, never by widening the sandbox.

## 7. Risks

- The dispatch check and the staging audit must resolve paths identically or the refusal becomes
  either a false block or a missed one. AC6 is the guard.
- `realpathExistingPrefix` touches the filesystem; on a path whose prefix does not exist it must
  not throw out of the dispatch branch. The helper already converts a resolution failure into an
  `owned_path_escape` error rather than an exception, and the new call site must preserve that.
