# PRD: Enter and arrows select workers

Status: implemented 2026-09-13; every acceptance criterion names its evidence. Parent issue: [Default numbered agent list with in-TUI details](prd-default-agent-list.md).

## Overview

Operator observation, 2026-09-13: "as I progress asking a question in a session, and the questions pile up I have to type e.g. 100, but maybe all the other agents are done." Stable numbers grow for the life of a session, so typing them becomes the cost of the stable-numbering rule. The operator chose, from three options, to keep numbers as labels and make the common case need none: Enter alone opens the only running worker; when several are running, Enter focuses the list and the up and down arrows choose; Enter opens the marked row. Renumbering running workers 1..N was rejected because a number could change under the operator's fingers when a worker finishes.

## Goals

- Opening the one running worker costs one key, whatever its number.
- Choosing among several is done by what is visible, never by a number that may change.
- The arrows never reach the list unless it is visibly focused; the editor keeps them otherwise.

## User Stories

### US-001: Enter opens the running worker or focuses the list

**Acceptance Criteria:**

- [x] Enter with nothing typed and exactly one running worker opens its details, leaving the list unfocused afterwards; with none running it reports that and offers typed numbers for settled workers. Proof: test `Enter alone opens the only running worker, and reports when none is running` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`.
- [x] With several running, Enter focuses the list: the header switches to `focused: up/down move, Enter opens, q unfocuses, ...` and the first running row carries the cursor mark. Up and down move over the visible rows and the folded summary, stopping at the ends; Enter opens the marked row or unfolds the summary; `q` from details returns to the focused list with the cursor kept; `q` unfocuses; the next `q` closes. Proof: test `Enter with several running workers focuses the list and the arrows choose`.
- [x] The cursor follows the worker: a row above it folding away does not move the cursor to another worker. Proof: the same test.
- [x] Arrows pass through to the editor while the list is not focused. Proof: the same test and the follow-view test.
- [x] Typed numbers still work and take precedence over the cursor. Proof: existing number-selection tests unchanged.
- [x] The follow view behaves the same for its run. Proof: test `the follow view opens the sole running worker on Enter and walks several with the arrows`.
- [x] Real terminal proof: Enter alone opens the sole running worker; with two running, Enter focuses the list with the cursor on row 1, down moves it to row 2, Enter opens agent 2, `q` returns to the focused list, `q` unfocuses. Proof: `e2e/tests/test_us008_default_agent_list.py` (`enterOpensSole`, `arrowsSelect`).
- [x] Both READMEs and the parent PRD describe the behaviour. Proof: commit.

## Functional Requirements

1. FR-1: Enter with no pending number and no open details: one running worker opens; none reports; several focuses with the cursor on the first running row.
2. FR-2: While focused, up and down move the cursor over the visible items in display order; the cursor is stored as the worker (or the summary), not as a position.
3. FR-3: Enter on a row opens it; Enter on the folded summary shows settled rows and puts the cursor on the first of them.
4. FR-4: Focus is always visible in the header and by the cursor mark; `q` unfocuses before it closes.
5. FR-5: A pending typed number takes precedence over the cursor.

## Non-Goals

- Renumbering; removing typed numbers; changing what the follow view lists.

## Open Questions

- None.
