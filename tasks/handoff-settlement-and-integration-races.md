# Handoff: two races between a running worker and the operator

**Recorded:** 2026-09-21
**Reported by:** the Pi supervisor session that ran the delegated documentation build
(`run_e161a611-d022-4300-a909-65e18c977a85`) in `/Users/spotted/projects/pi-agent-wave-new-design`
**Affects:** Delegate Graph `build` graph — `implement` node with more than one slice, and every node
that dispatches more than one worker (Herdr and headless transports both observed)
**Does not affect:** the `research` graph's read-only roles, single-slice `build` runs, or settlement of
a worker that runs alone
**Not a PRD.** This file is a work order, not a plan of record. It is written to survive the removal of
the `tasks/prd-*.md` files and should be read with `specification.md` and `product.md`.

---

## 1. Summary

Two defects, both found by running a real two-slice `build` run end to end:

1. **A worker whose turn has ended still reads as `running` until `collect` is called.** An operator
   watching the worker's tab sees a finished agent; `op=status` shows `running`; the tab stays open. Two
   agents sat in this state while the supervisor was told they were done. Nothing is wrong with the
   worker — the graph simply has no state for "the process exited and nobody has collected it yet".
2. **Integrating one slice while a sibling slice's worker is still running fails that sibling
   permanently.** The integration writes a file into the host workspace; the still-running worker's own
   settlement audit then sees a change it does not own and refuses the attempt with
   `AgentFS contains unowned changes: <path>`. That classification is permanent, so the run parks and the
   work of that worker is lost.

Issue 2 has a related requirement, recorded in §5: the build graph's rounds implicitly require the
operator to commit between them, and nothing states or enforces it.

---

## 2. How this was found, and where the evidence is

The run produced two documents from the code (`product.md`, `specification.md`) with two parallel
`implement` slices. Everything below is read from that run's own records, not reconstructed.

| What | Where |
| --- | --- |
| Run id | `run_e161a611-d022-4300-a909-65e18c977a85` |
| Store | `~/.local/share/delegate-graph/delegate-graph.db` (`runs`, `operations`, `runtime_attempts`, `runtime_decisions`, `runtime_integrations`, `events`, `state`) |
| Failure bundle for issue 2 | `~/.local/share/delegate-graph/evidence/run_e161a611-d022-4300-a909-65e18c977a85/failure-op_7b271a21-c6d2-4152-9e28-83f862024e0f.json` |
| Integrations that made issue 2 fire | `runtime_integrations` rows `77d21fd8d0bc03342fb20d133f214246090882f6049bb88394ce9177aec245f1` (specification) and `10e680b80b4989b70204ab7f4d6a424e6815dcb929affb187fd2e49b8e247c0c` (product, round 1) |
| Commits on this branch | `02972d4` (both documents committed) and `6347a12` (the corrected specification) |

---

## 3. Issue 1 — a finished worker is invisible as finished until `collect`

### 3.1 Symptom

The operator sees a worker tab whose agent has stopped working and says the agent is done. The run has
not moved: `op=status` still reports the operation `running`, `collect` has not been called, and the
attempt's `processState` is `running`.

### 3.2 Evidence

- The attempt row is written at dispatch with `processState: "running"` and only takes the settled
  outcome at settlement: `store.ts:1236` (`processState: outcome?.kind ?? "running"`) inside the settle
  path, and `store.ts:1342` emits `runtime_attempt_settled` with `processState: outcome.kind`. Until
  `collect` runs, nothing rewrites it. **Verified by reading the store and by every collect in this run:
  the operation changed from `running` to a terminal state only when `collect` returned `settled: true`.**
- The launcher already knows the process ended, independently of settlement:
  `scripts/headless_supervisor.py:110` writes `{"schemaVersion":1,"workerPid":…,"exitCode":…}` to the
  `--status` path, mode 600. **Verified.**
- The tab is closed at *settlement*, not at turn end: `scripts/delegate_core.py:1023` defines
  `close_settled_tab`, and the settle path calls it at `delegate_core.py:1873` (the two other call sites,
  1193 and 1198, are the wait-failure branches). So a worker whose turn ended but which was never
  collected keeps its tab. **Verified in code; this is the mechanism by which a finished-looking tab and
  a `running` operation coexist.**
- Observed instance: the product slice's worker turned in at 08:36:22 but its operation stayed `running`
  until a `collect` was issued; the reviewer's worker turned in at 08:46:02 and likewise needed the
  explicit `collect` at 08:46:40 before the run advanced to `test`.

### 3.3 Why this matters

The run's own progress is invisible between "the worker stopped" and "someone called collect". A
supervisor watching tabs cannot tell whether a run is stalled, finished or mid-flight, and a session
that never issues `collect` leaves a settled worker that nothing will ever settle. It also makes the
tab's own state actively misleading, which is how this was noticed.

### 3.4 Fix options

- **A — surface the launcher's own record (smallest).** The headless supervisor already writes the
  worker's pid and exit code at `headless_supervisor.py:110`. Let the agent list and the worker detail
  view read that file (or its Herdr equivalent) and render `process exited, awaiting collect` while the
  attempt is unsettled. No contract change, no new state, and it makes the existing truth visible.
  Open question: the Herdr transport's equivalent of `status.json` (see §8).
- **B — give the store an intermediate state (deeper).** Record the process outcome as an observation
  when the worker exits, with `collect` still owning the candidate and acceptance. This splits "the
  process ended" from "the attempt settled", which is the distinction the operator needs; it adds an
  event and a field to `runtime_attempts`, so it needs a PRD entry and a migration-style review.
- **C — collect automatically (convenience, not correctness).** A supervisor-side watcher that calls
  `collect` when a worker exits. This hides the gap rather than closing it, and it moves settlement —
  which carries acceptance semantics — away from an explicit operator act. Recommend not doing this
  alone.

### 3.5 Acceptance criteria

- [x] With a worker whose process has exited and whose operation is unsettled, the agent list and the detail
  view state that the process exited and that collection is pending. Proof:
  `test/turn-end-visibility.test.ts` cases 1 and 2. Case 1 asserts the detail view reads
  `process exited 0, awaiting collect` while `store.getOperation(...).status` is still `running` and the
  stored `processState` is still `running` in the same fixture; case 2 asserts the list row through
  `listRows`, and covers the Herdr shape (no `status.json`, so the label omits the code). The signal is
  the worker's own `worker-result.json`, not the supervisor status file §3.4 A proposed — see §5b and
  §8's first open question, which this answers for both transports.
- [x] No display path waits on the worker to settle, and no path blocks the terminal. Proof:
  `test/turn-end-visibility.test.ts` case 3 puts a FIFO where the result file goes — opening it for read
  would block forever — and asserts both `turnEndFor` and `attemptDetail` return inside 1 s with
  `running`, plus the null and missing-path variants.
- [x] Nothing about settlement semantics changes: a candidate is still accepted only through `op=decide`.
  Proof: `lib/turn-end.ts` only stats and reads files; case 1 asserts the stored attempt is untouched and
  case 4 asserts a settled attempt is still labelled from its recorded outcome (`settled (exited 0)`)
  rather than from the leftover result file. Mutation-proven: forcing `turnEndFor` to report "not ended"
  fails cases 1 and 2.

---

## 4. Issue 2 — integrating one slice fails its running sibling permanently

### 4.1 Symptom

Slice A's candidate is integrated while slice B's worker is still running. Slice B then fails at
settlement with:

```
runtime settlement failed: AgentFS contains unowned changes: specification.md
ACPX cancel/close error: command failed (1): ['cancel-acpx.sh']
{"action":"cancel_attempt",…,"cancelled":false,"structuredCancelled":false,"closed":false,"noSession":false}
```

The failure classifies as **permanent** (`retry.ts:61`: `[owned_path_escape]|AgentFS (?:contains unowned
changes|export failed…)` → `{kind: "permanent", reason: "unclassified"}`), the run parks at
`awaiting_user`, and B's work is discarded.

### 4.2 Evidence

- The error is raised by the sandbox audit: `lib/agentfs-sandbox.ts:277` and
  `lib/runtime-staging.ts:69` both throw `` `AgentFS contains unowned changes: ${…paths…}` ``.
- Timeline from the store (all UTC): the product worker was dispatched 09:27:36 owning `product.md`
  alone; the specification slice was **integrated at 09:44:24** (integration
  `77d21fd8…`, `decidedAt 2026-09-21T09:44:24.983Z`); the product attempt failed at 09:49:45.
- The failure is the supervisor's doing, not the worker's: the product worker was told to own
  `product.md` and not to touch `specification.md`, and the changed file the audit objected to is
  `specification.md`, written by the integration.
- The recovery was an operator retry from a committed base: `op=retry` classified it permanent
  (`exhausted: true`, `classification: "unclassified"`) → run parked → `op=resolve decision=retry` →
  re-dispatch at 09:51:02 with base `6347a12`.

### 4.3 Why this matters

Parallel slices are the point of the `implement` fan-out, and integrating a finished slice while others
run is the natural thing for an operator to do. Doing it destroys a running worker's attempt *and* its
output, parks the run, and gives the operator no hint that the integration was the cause. The failure
message names the file, not the interference.

### 4.4 Fix options

- **A — refuse integration while a sibling is running (smallest, recommended first).** In the `op=integrate`
  branch, refuse when any operation of the same run, node and round is still `running`, naming those
  operations. The store already answers the inverse question for the join
  (`store.ts:1629-1636`, `allCurrentComplete`); the guard is the same query with `status='running'`.
  Give it an explicit override for an operator who knows the sibling is dead.
- **B — make the audit attribute changes correctly (deeper).** The audit exists to catch writes a worker
  made outside its owned paths. A path that changed *on the host* after the overlay was created is not
  such a write. Comparing the overlay's delta against the recorded base revision rather than the live
  host tree would remove the false positive without weakening the rule — but it changes the audit's
  input, so it needs its own PRD entry and a proof that a genuine unowned worker write is still caught.
- **C — state the rule in the supervisor contract.** "Integrate a slice only once every operation of that
  node and round has settled." This belongs in the contract text regardless of whether A or B lands; on
  its own it is only documentation, and the incident shows documentation is not enough here.

### 4.5 Acceptance criteria

- [x] Integrating a slice while a sibling operation of the same node and round is `running` is refused with
  an error that names the running operations, and the sibling's attempt is unaffected. Proof:
  `test/integration-sibling-race.test.ts` case 1, on a real two-slice build run with real AgentFS
  overlays and a real Git workspace: it asserts the refusal names the live operation id, that
  `product.md` still holds its preimage, that the sibling then settles with its `coding` candidate
  intact, and that the same integration applies once both have settled. One correction to §4.4 A found
  while building it: the guard cannot key on `status='running'`, because an operation stays `running`
  until `op=decide`, so a sibling that had already settled would be refused needlessly. The hazard
  window is "dispatched and not yet settled", which is what `liveSiblingOperations` asks.
- [x] The override path is explicit and recorded. Proof: case 2 asserts a blank reason is refused
  (`override requires a reason`), that the unqualified call is still refused, and that the stated reason
  is returned as `overrideReason` and survives reopening the store from a new `GraphStore`. Case 3
  asserts a rollback is never refused by the guard, because it is the recovery route out of the state.
- [x] A genuine unowned worker write is still permanent. Proof: the guard is in
  `store.ts:prepareIntegration` and touches neither the audit nor `retry.ts`; `agentfs-sandbox.test.ts`,
  `owned-path-normalization.test.ts` and `runtime-candidate-integration.test.ts` are unchanged and pass
  in the full gate below. Mutation-proven: disabling the guard fails cases 1 and 2.

---

## 5. Related requirement — the implicit commit between rounds

The same root cause (the workspace is shared mutable state between the operator and running workers)
produced a second, quieter failure earlier in the same run, and it is worth fixing alongside issue 2.

A fix round cannot integrate a candidate that modifies a file the previous round created, because
`lib/runtime-integration.ts` requires a clean **tracked** preimage and `HEAD === baseRevision`:

```
lib/runtime-integration.ts:179  integration workspace must be the Git root
lib/runtime-integration.ts:180  candidate base revision changed            # git(workspace,"HEAD") !== input.baseRevision
lib/runtime-integration.ts:183  workspace has an active integration
lib/runtime-integration.ts:187  unowned integration path
lib/runtime-integration.ts:188  overlapping integration entries
lib/runtime-integration.ts:193  candidate preimage is dirty or untracked   # git status --porcelain is non-empty for the path
lib/runtime-integration.ts:196  candidate preimage is untracked or ignored # ls-files --error-unmatch fails
```

Round 1 integrated `product.md` and `specification.md` into the working tree and nothing committed them,
so round 2's candidates could satisfy neither check: untracked refused the preimage, and committing
moved `HEAD` away from their recorded base `50f05b5`. The graph's rounds therefore assume an operator
duty — commit between rounds — that is neither stated nor enforced, and it surfaces as an integration
refusal with no guidance.

- [x] Acceptance criteria: either the graph states and enforces the duty (a named error telling the operator to
commit, before a round's candidates are wasted), or the integration can apply a candidate whose changed
paths are only untracked *because a previous round created them*. Proof: the first branch, in
`test/integration-sibling-race.test.ts` case 4. A round-1 candidate is applied and left uncommitted, and
a later candidate touching that same path is refused with `uncommitted output of an earlier applied
integration … commit the previous round's integrated files` instead of the bare
`candidate preimage is dirty or untracked`. `lib/runtime-integration.ts:appliedHere` distinguishes the
graph's own uncommitted output from an unrelated dirty file, so a genuinely dirty preimage still gets
the original error. Mutation-proven: reverting the branch fails case 4.

Partial, and stated as such: the criterion asked for the error "before a round's candidates are
wasted", and §5b planned to check this at dispatch as well as at integration. Only the
integration-time error is implemented. A candidate is still produced before the operator learns the
tree needs committing; what changes is that the refusal now says what to do instead of reading as an
unexplained dirty-preimage failure. A dispatch-time check remains open work.

---

## 5b. Chosen approach (2026-09-21, before implementation)

Recorded here because this work order is the plan of record for this change. Baseline before any edit:
584 Node tests, 573 passed, 0 failed, 11 opt-in skips at `157e87b` with a clean tree.

- **Issue 1 → option A**, with one correction to its premise. §3.4 A proposed reading the headless
  supervisor's `status.json`, and §8 asked what the Herdr equivalent is. There is a better record that
  needs no per-transport answer: the worker itself writes `worker-result.json` into its attempt
  directory, the same directory that holds `cancel-acpx.sh`
  (`scripts/delegate_core.py:747` and `:786`), on both transports. Its existence *is* "the worker's turn
  ended and nothing has collected it". The display paths read that, and read the headless
  `status.json` only as an optional source of the exit code. No store state, no event, no contract change.
- **Issue 2 → option A, plus option C's contract text.** `op=integrate` refuses while a sibling
  operation of the same node, round and fix iteration is still `running`, naming them. Option B
  (re-basing the audit off the recorded base revision) is deliberately not taken here: it changes the
  audit's input and §4.4 says it needs its own plan entry and its own proof.
- **Override:** explicit and recorded. A new `overrideRunningSiblings` parameter requires a reason, and
  the reason is stored on the integration journal row (a new nullable `override_reason` column, added
  additively where the journal already creates its own table) and emitted as a graph event.
- **§5 → enforce the duty at dispatch, not only at integration.** The criterion asks for the named error
  "before a round's candidates are wasted", so the check runs when the next round is dispatched: a
  workspace still holding uncommitted files from this run's own applied integrations refuses the
  dispatch with guidance to commit. The integration-time error carries the same guidance for a tree that
  became dirty after dispatch.

Not addressed, and left open: §8's question about whether `allCurrentComplete` should treat `cancelled`
as settled. It changes join semantics for every graph and belongs in its own entry.

---

## 5c. Result (2026-09-21)

Implemented on this tree, all three sections of acceptance criteria above checked with their evidence
named. Changed: `lib/turn-end.ts` (new), `agent-list.ts`, `index.ts`, `store.ts`,
`lib/runtime-integration.ts`, both the package README and `specification.md`, plus the two new test
files. `op=integrate` gained an `overrideRunningSiblings` parameter that reads the `reason` it is given.

Automated gate from the repository root, after the change: **592 Node tests, 581 passed, 0 failed, 11
opt-in skips** (baseline before the change was 584/573/0/11; the 8 new tests are the difference).
`npm run typecheck` and `git diff --check` clean. Bun package checks 46/46. Installation rehearsal 1/1.
`npm pack --dry-run` reports **81 packed files**, one more than the recorded 80, which is
`lib/turn-end.ts` arriving through the existing `lib` pattern; `npm publish --dry-run` agrees. Each of
the three product changes is mutation-proven as recorded above, and every mutated file was restored and
verified byte-identical with `diff -q`.

Not done, and not claimed: no live provider run was made, so this is proven by the automated gate and by
mutation, not by a measurement-driver run. The dispatch-time half of the §5 criterion is open, as is
§8's `allCurrentComplete`/`cancelled` question.

---

## 6. Non-goals

- No change to retry classification policy. `worker-credential-preflight` being transient is a separate
  open question recorded elsewhere and is not part of this handoff.
- No change to the evidence ledger, the store schema's story record, or the coverage of the audit beyond
  what §4.4 option B requires.
- No Herdr version work. The Herdr `pane run` submission behaviour was fixed separately and is unrelated.

## 7. Reproduction

Issue 2 is reproducible in one run once a second slice exists:

1. `delegate_graph op=init` with `graph: build`, a task that yields two slices, and any working model
   policy.
2. Drive `thinker_plan` to a decision with two disjoint slices.
3. `op=dispatch` both `implement` operations.
4. `op=collect` and `op=integrate` the first slice while the second worker is still running.
5. `op=collect` the second: it fails with `AgentFS contains unowned changes: <the first slice's file>`.

Issue 1 needs no failure at all: dispatch any worker, let its process exit, and read `op=status` before
calling `collect`.

## 8. Open questions

- What is the Herdr transport's equivalent of the headless supervisor's `status.json`
  (`headless_supervisor.py:110`)? Option A of §3.4 needs it, and this session did not establish it.
- Should an integration be *refused* or *queued* until the round is quiet? Refusing is simpler and
  pushes the ordering onto the operator; queuing is friendlier but introduces a waiting state the store
  does not have today.
- Does `allCurrentComplete` (`store.ts:1629-1636`) intend `cancelled` to keep a node from joining? It
  counts any status other than `completed`, so a cancelled slice stalls the implement node. Either that
  is intended and should be stated, or the join should treat `cancelled` as settled.