# Fix plan: Delegate Graph failure modes seen on run `run_a6a35211`

Source session: a build-graph run asked a read-only question ("can AgentFS sandboxes created with pi-agent-wave-new-design be written to?"). The thinker settled; one of three `implement` workers exited 0 with an 11,776-byte answer and was then discarded with `coding settlement requires a Git base revision recorded at dispatch`.

**Root cause:** `scripts/delegate_core.py:800` runs `git -C <cwd> rev-parse HEAD` on the dispatch `cwd`, not on the owned paths. The supervisor's `cwd` was `/Users/davidepugliese`, which is not a Git repository, so every build run started from it fails at settlement regardless of `ownedPaths`. The slices' absolute `/tmp` owned paths were a second, separate defect.

**Process:** per this repository's `AGENTS.md`, record this as a work order in `tasks/handoff-delegation-fail-closed-settlement.md` and update `specification.md` before implementing.

**Precondition:** the working tree currently has uncommitted edits in `README.md`, `specification.md` and `lib/claude-auth-stream.ts`, plus two untracked test files. Commit or set these aside first.

## Changes

1. **Reject the problem before any worker launches.** This is the most important fix: it stops the Git failure from recurring and removes most of the need for a way to re-plan a running graph.
   - `op=init` with `graph=build` is refused when `cwd` is not a Git working tree. The error names the `research` graph as the alternative.
   - `op=decide` on `thinker_plan` rejects `ownedPaths` outside the run's workspace (checked in `store.ts`, next to `assertDisjointOwnership`). Today `parsed_path_list` accepts any absolute path. A path outside the workspace cannot be audited, and it is how the three workers wrote to the host's `/tmp` without ever going through export.
   - `op=dispatch` refuses an `implement` operation that has no base revision. This is a backstop, since the two checks above should already have caught it.

2. **Keep the worker's answer when settlement fails** (`settle_runtime_attempt`). The function's own docstring says "Content retention is the essential commit", but the Git check at line 1815 runs before anything is retained.
   - On a failure caused by a precondition, keep the captured answer and return it as `captureRetainedPath`. That field already exists and was `null` in this run.
   - Mark the result as a failed candidate that cannot be accepted, so the output is never silently promoted.

3. **Make the templates state the rules.**
   - In `index.ts:718`, change the `ownedPaths` placeholder to say the paths must be relative to the workspace and inside the Git tree.
   - In `contract.ts`, the kickoff text should say that `implement` produces code candidates only, and that a question you verify by running tests belongs on the `research` graph.

4. **Fix the evidence record.** Failure evidence reads `resource.get("selected_model")` at `delegate_core.py:1554`, but the resource stores the model under `model` (line 1356), so `selectedModel` was recorded as `None`. Also record the settlement error and the cleanup error as two separate fields instead of one joined string.

5. **Make `op=status` agree with itself.** In the "current operations" rows (`commands.ts:76`), show the attempt's process state next to `operation.status`. Today the same operation appears as `failed` in one table and `running` in the other.

6. **Stop a failed join from stranding its siblings.** When one slice fails in a way a retry cannot fix (a precondition failure, for example), park the run as `blocked`, so the operator can use `op=resolve` or `op=cancel` instead of waiting on siblings that can never join.
   - Not yet verified: how joins behave after retries run out. Read `graph-core.ts` and `retry.ts` before committing to this approach.

7. **Find out why cancellation failed.** In this run, `cancel-acpx.sh` exited 1 with `cancelled:false, closed:false, noSession:false`. The cause is unknown, so the first step is to reproduce it on the failed slice. Any fix gets its own small change.

## Tests (only for behaviour that actually broke)

- `op=init` with the build graph from a directory that is not a Git repository is refused.
- `op=decide` with an absolute path outside the workspace is refused.
- A precondition failure at settlement still returns the retained answer through `captureRetainedPath`.
- Failure evidence has `selectedModel` filled in.
- A precondition failure at the join moves the run to `blocked`.

Test command, run from the repository root: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`

## Docs

- `specification.md`: the preconditions checked at init, decide and dispatch, the rule that `ownedPaths` stay inside the workspace, and retention on failed settlement.
- `extensions/pi-agent-wave/README.md`: which graph to use for which kind of task.

## Acceptance criteria (each names its proof)

- [ ] Replaying the source session's question fails at `op=init` or `op=decide`, before any worker launches. Proof: the tests above, plus one live `op=init` from `~`.
- [ ] Each of points 1–5 has a named passing test. Point 6 has one once its approach is confirmed.
- [ ] The cancellation failure in point 7 is either reproduced and fixed, or written up in the work order as an open cause.

## Not in scope (pending a decision)

- **Every role starts on the same model.** This comes from `~/.pi/agent/model-routing.jsonc`, not from extension code. Suggestion: make the reviewer and auditor chains start on a different provider from the implementer's. The tradeoff is cost and latency against a review that is actually independent.
- **A general "re-plan" operation.** Suggestion: don't build it (YAGNI). With the checks in point 1, the bad slice definitions that would need it get rejected up front. The tradeoff is that a slice turning out wrong for other reasons still has to be cancelled and a new run started.

## Downgraded findings

- **`No result provided` on the second collect.** It came back at the moment the user interrupted the session, so it is most likely a side effect of the interruption rather than a design flaw. Treat it as a bug only if it happens again without an interruption.
- **Over-orchestration.** Once point 3 steers questions like this one to the `research` graph, this is the same problem and needs no separate fix.
