# PRD: Cancel the run's workers from the list

Status: implemented 2026-09-13; every acceptance criterion names its evidence. Parent issue: [Default numbered agent list with in-TUI details](prd-default-agent-list.md). This amends that PRD's read-only goal with one explicit, confirmed mutation and reassigns Escape.

## Overview

Operator request, 2026-09-13: "When I send esc it should send a cancellation signal to all the elements of the graph." Two clarifications were taken: the trigger is Escape with a confirmation step (not immediate), and the scope is the run in view (the selected worker's run, otherwise the most recently registered one), not every run of the session.

Escape therefore no longer closes a view or steps back; `q` does both. Escape clears a pending number, aborts a pending confirmation, or asks to cancel every running worker of the run in view. The prompt names the workers; Enter confirms; `q` or a second Escape aborts and reports that nothing was cancelled.

## Goals

- A confirmed Escape stops every running worker of the run in view and records the run cancelled, in the agent list and in the follow view alike.
- A cancellation is never silent, partial by accident, or fabricated: the prompt names what it will stop, the notice names what was stopped, and a worker whose stop cannot be confirmed is reported rather than assumed.
- Everything else in the views stays read-only, and keys still reach the views only while the editor is empty.

## User Stories

### US-001: Ask before cancelling

**Acceptance Criteria:**

- [x] Escape in the list or in details shows `cancel run <runId>? N running worker(s): <names> | Enter confirms, q or Esc aborts` on top of the current view; `q` or Escape aborts with a notice that nothing was cancelled, keeping the view and any open details. Proof: test `Escape asks before cancelling and q or a second Escape aborts without touching anything` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] Escape with a pending number clears the number instead. Proof: `multi-digit selection addresses the displayed attempt` in that file.
- [x] Escape when the run has no running workers reports that and shows no prompt. Proof: `Escape then Enter cancels every running worker of the run in view and only that run` in that file.
- [x] Real terminal proof: Escape shows the prompt naming the worker, `q` aborts with the notice. Proof: `e2e/tests/test_us008_default_agent_list.py` (`cancelPromptShown`, `cancelAborted`).

### US-002: Confirmed cancellation stops the run's workers

**Acceptance Criteria:**

- [x] Enter on the prompt stops each running worker of that run through its structured cancel script, settles its attempt as cancelled, and records the run's running operations and the run itself cancelled in one transaction; other runs are untouched; the list row reads `settled (cancelled)` with its number intact. Proof: the `Escape then Enter cancels...` test above, and `cancelRunningOperations` in `extensions/pi-agent-wave/store.ts`.
- [x] A worker whose stop cannot be confirmed is named in the notice and in the operation's error; its attempt is not given a fabricated cancelled outcome; the run is still recorded cancelled because that is what the operator asked for. Proof: test `a worker that cannot be confirmed stopped is named, and the run is still recorded cancelled`.
- [x] The follow view offers the same confirmation and cancels its own run. Proof: test `the follow view cancels its run through the same confirmation`.
- [x] Real terminal proof: Escape then Enter cancels the second run's worker through the real cancel script of the fake worker; the notice and the `settled (cancelled)` row appear; the database shows the run cancelled and the first run still active. Proof: the E2E test (`cancelConfirmed`, `cancelledRunStatus`).
- [x] Typecheck, whitespace check and the full unit suite pass. Proof: 2026-09-13 run recorded in the commit message.

### US-003: Documentation

- [x] Both READMEs, `AGENTS.md` and the parent PRD describe Escape as the confirmed cancel key and `q` as the navigation key. Proof: commit; documentation tests pass.

## Functional Requirements

1. FR-1: Escape must, in this order, clear a pending number, abort a pending confirmation, or open the confirmation for the run in view. It must never close a view.
2. FR-2: The confirmation must name every worker it would stop and must require Enter; `q` or Escape aborts.
3. FR-3: A confirmed cancellation must stop processes before recording state, settle each confirmed-stopped attempt as cancelled, and record all running operations of the run plus the run cancelled in one transaction.
4. FR-4: Unconfirmed stops must be reported by name in the operator notice and in the operation's error, never treated as stopped.
5. FR-5: The list module must not execute anything; the entry point injects the cancel action.
6. FR-6: The follow view must offer the same behaviour for its run.

## Non-Goals

- Cancelling every run of the session at once.
- Cancelling from headless or ACP contexts; `op=cancel` remains the tool path.
- Changing what `op=cancel` does for a single operation.

## Design / Technical Considerations

`cancelRunWorkers` in `extensions/pi-agent-wave/index.ts` iterates the run's running operations, calls the existing structured cancel per worker (tolerating an already dead session as `op=cancel` does), settles confirmed stops, then calls `GraphStore.cancelRunningOperations`, which records everything in one transaction and emits `operation_cancelled` per operation and one `run_cancelled` event. The agent list receives the action through `AgentListActions` so it stays free of execution. The fake acpx fixture answers the cancel script's `cancel`, `close` and `status` calls, so the terminal proof exercises the real cancel path.

## Verified behaviours and gotchas

- The first terminal run showed Escape reaching the editor rather than the list: Pi enables the CSI-u keyboard protocol, under which Escape (and Enter) arrive as escape sequences, not the bare byte a string compare expects. Both views now match keys through pi-tui's `matchesKey` and `parseKey`, which accept the legacy and CSI-u encodings alike; the unit doubles still send bare bytes and pass.
- Operator report after release: one Escape press showed the prompt and it was immediately "aborted; nothing was cancelled". The terminal reports key releases under the kitty keyboard protocol (`CSI 27;1:3 u`), and pi-tui's `matchesKey` accepts a release as the key. Both views now ignore `isKeyRelease` events before matching anything; a unit test feeds the release sequences for Escape, Enter, q and an arrow. The harness cannot reproduce this because Herdr and tmux send no release events.
- Operator report after the release fix: "aborted; nothing was cancelled" followed by "has no running workers to cancel". Cause: while a confirmed cancellation was in flight, the prompt state was still set, so an Escape or q in that window took the abort branch and printed a false abort while the cancellation went on to succeed. Keys during an in-flight cancellation now answer "is in progress; wait for its report", the prompt line reads `cancelling run …: … | please wait`, and Enter cannot start a second cancellation. Key repeats (event type 2) of Escape, Enter and q are ignored as well, since a held Escape would otherwise abort the prompt it opened. Unit test: `a cancellation in flight cannot be aborted, confirmed twice, or closed over, and key repeats do not act`.
- Escape must be matched before any other key, because under CSI-u a letter can also arrive as a sequence; `parseKey` yields the plain letter for `q` and `r`.
- The fake acpx fixture answers the cancel script's `cancel`, `close` and `status` calls, so the terminal proof runs the real structured cancel path and settles the attempt from its report.

## Open Questions

- None.
