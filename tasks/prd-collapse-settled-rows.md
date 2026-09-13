# PRD: Collapse settled rows in the agent list

Status: implemented 2026-09-13; every acceptance criterion names its evidence. Parent issue: [Default numbered agent list with in-TUI details](prd-default-agent-list.md).

## Overview

Operator observation, 2026-09-13: "When an agent completes its task the number remains attached to that agent." That is the parent PRD's stable-numbering rule (FR-2, FR-3): a worker keeps its number for the session and stays inspectable after it settles. The operator chose, from four options, to keep those rules and fold finished workers out of the way: settled and superseded rows collapse into one summary line that lists their numbers, `s` shows or hides them, and a folded number still opens its details.

## Goals

- The list shows what is running; finished workers take one line, not one line each.
- Numbers never change or get reused, and every number, folded or not, still opens its details.

## User Stories

### US-001: Finished workers fold into a summary

**Acceptance Criteria:**

- [x] A worker whose attempt settled or was superseded leaves the row list and is counted in one line, `settled (N): <numbers> | s shows them`, placed after the running rows; running rows keep their numbers and order. Proof: test `settled rows collapse into a summary and stay selectable by number` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] Typing a folded number and Enter opens that worker's details. Proof: the same test.
- [x] `s` shows the settled rows in their original positions with their labels and removes the summary; `s` again folds them back. Proof: the same test; the key is named in the list legend.
- [x] Cancelled workers fold the same way. Proof: `Escape then Enter cancels every running worker of the run in view and only that run` in that file.
- [x] Real terminal proof: after the first worker is collected it appears as `settled (1): 1 | s shows them`, `s` reveals `1. <name> | thinker_plan | settled (exited 0)`, `s` folds it again, and after the confirmed cancellation the summary reads `settled (2): 1, 2`. Proof: `e2e/tests/test_us008_default_agent_list.py` (`settledCollapsed`, `settledToggled`).
- [x] Both READMEs and the parent PRD describe the fold and the `s` key. Proof: commit.

## Functional Requirements

1. FR-1: A row folds when its attempt's process state is not running or the attempt was superseded.
2. FR-2: The summary names the folded numbers in ascending order; it is absent when nothing is folded and while settled rows are shown.
3. FR-3: Folding is presentation state per view; it never changes numbers, entries, or selection semantics.
4. FR-4: The follow view is unchanged: it already lists only running operations.

## Non-Goals

- Removing or renumbering entries; hiding decided workers permanently.

## Open Questions

- None.
