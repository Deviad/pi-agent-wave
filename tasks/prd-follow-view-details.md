# PRD: Follow view opens details by number

Status: implemented 2026-09-13 in commit `dc6694c` on `main`, after the parent feature landed in `98b3dd4`. This document was written after the fact as the record of the story; every acceptance criterion names the evidence that exists. Parent issue: [Default numbered agent list with in-TUI details](prd-default-agent-list.md).

## Overview

The run-scoped follow view (`/graph watch <runId> --follow`, and its aliases `/graph status --follow <runId>` and `/graph status <runId> --follow`) bound its number keys to Herdr tab focus. After the parent feature, the automatic agent list bound numbers to in-terminal details. The same digit therefore meant two different things depending on which view was open, and the follow view still contained the failure the parent issue was raised for: selecting a worker whose Herdr tab had disappeared produced `agent_not_found`.

This story makes the follow view select the same way as the agent list and render the same attempt-bound details, and leaves tab focusing to the explicit `/graph focus` command, which the parent PRD retains (FR-7).

Operator decision, 2026-09-13: "If you would rather the follow view also open details by number" was answered with "Ok, commit everything as it is, then proceed", after the recommendation below was given.

## Goals

- One meaning for a number key in every interactive Delegate Graph view: it selects a worker whose details open in the terminal.
- Remove the last code path where number selection depends on a live Herdr target.
- Keep the follow view's scope (one run, running workers) and its lifecycle (redraw timer only while open and the run is active).
- Keep `/graph focus` as the only way to bring a Herdr tab forward.

## User Stories

### US-001: Select a worker's details in the follow view

**Description:** As the operator watching a run with `--follow`, I want a number followed by Enter to open that worker's details in the terminal, exactly as in the agent list, so that I never need to remember which view I am in and never hit a missing Herdr tab.

**Acceptance Criteria:**

- [x] In the follow view, digits accumulate as a pending selection shown on screen, Enter opens the selected worker's details, and the details are rendered by the same code as the agent list, bound to the worker's attempt key at the moment of selection. Proof: test `/graph watch --follow keeps the overview on screen, refreshes on r, opens details by number plus Enter, and closes on q` in `extensions/pi-agent-wave/test/runtime-watch.test.ts`, asserting the pending line, the `agent 1:` header, the process line and the rendered stream.
- [x] Selection runs no Herdr focus or cancel command, and no "no pane to focus" or `agent_not_found` notice can appear. Proof: the same test asserts no such notice; `startFollow` in `extensions/pi-agent-wave/index.ts` no longer references `focusRegisteredAgent`, whose only remaining caller is `/graph focus`.
- [x] An out-of-range number is reported as `no worker N in the watch view` and changes nothing. Proof: the same test, number 7 on a one-worker view.
- [x] `q` or Escape clears a pending number first, then returns from details to the overview, then closes the view; `r` refreshes whichever level is open; other keys pass through to the editor. Proof: the same test.
- [x] Keys reach the follow view only while Pi's editor is empty, so a command being typed is never mangled. Proof: the follow handler checks `ctx.ui.getEditorText()` like the agent list; the gating itself is covered by `multi-digit selection addresses the displayed attempt` in the same file, which the follow view shares by construction.
- [x] Typecheck passes. Proof: `npm run typecheck` from `extensions/pi-agent-wave/`, exit 0 on 2026-09-13.
- [x] Real terminal proof: the follow view opens for a run whose worker is running, `1` then Enter opens its details, `q` returns to the overview, `q` closes it with the closed notice, and the operator's default Herdr session is unchanged. Proof: `e2e/tests/test_us008_default_agent_list.py` (`followDetailOpened`, `followClosed` in `evidence.json`), passing run `agent-output/default-agent-list/20260913T134157.021650Z-461166/`.

### US-002: Documentation names one focusing path

**Description:** As a reader of the READMEs, I want the follow view described with its actual keys and `/graph focus` named as the only tab-focusing command.

**Acceptance Criteria:**

- [x] `README.md`, `extensions/pi-agent-wave/README.md` and the parent PRD no longer say that number keys in the follow view jump to or focus a Herdr tab, and each names `/graph focus` as the focusing command. Proof: commit `dc6694c`; `git grep -n "focus worker\|jump to a worker" -- README.md extensions/pi-agent-wave/README.md` returns nothing; the package documentation tests pass (`test/package-docs.test.ts`, 8/8).
- [x] `git diff --check` passes. Proof: exit 0 on 2026-09-13.

## Functional Requirements

1. FR-1: The follow view must accept a number of any length followed by Enter, display the pending digits, and open the selected worker's details on Enter.
2. FR-2: Details must be produced by the agent list's `attemptDetail` and `renderAgentDetail`, bound to the attempt registered for the selected operation, so a settled or superseded attempt keeps its own identity while the details are open.
3. FR-3: The follow view must never invoke Herdr focus or cancel; `/graph focus` remains the explicit focusing command and is unchanged.
4. FR-4: `q` and Escape must act in this order: clear pending digits, leave details, close the view. `r` must refresh the current level.
5. FR-5: Keys must be consumed only while the editor is empty.
6. FR-6: The view's scope (one run, currently running operations), its redraw timer rules, its replacement by a new follow or by the agent list, and its closing notice are unchanged.

## Non-Goals

- Changing what the follow view lists. It still shows running operations of one run; settled attempts are inspected from the agent list.
- Merging the follow view into the agent list, or removing `/graph watch --follow` and its aliases.
- Changing `/graph focus`, worker lifecycle, settlement or decision contracts.

## Design / Technical Considerations

`startFollow` in `extensions/pi-agent-wave/index.ts` keeps its own widget key, input subscription and timer, and gains two pieces of local state: the pending digits and the selected worker (`number`, `attemptKey`, `operationId`). `draw` renders either `renderFollow(view, pending)` or the shared detail renderer. The attempt key is resolved once at selection time through `runtimeAttemptByOperation`, so the details stay bound to that attempt even if the operation is later retried. The follow view and the agent list still replace each other, so at most one input handler consumes keys.

Restore copies were not needed: the working tree was committed (`98b3dd4`) immediately before this change.

## Success Metrics

Every criterion above is checked against named evidence: the updated follow test, the terminal harness run, the documentation tests, typecheck and whitespace check, all passing on 2026-09-13 with the unit suite at 500 passed, 0 failed, 11 skipped.

## Open Questions

- None.
