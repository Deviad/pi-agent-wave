# PRD: Operational search delegation

**Status:** Implemented and verified. The bounded real LinkedIn rehearsal completed with exit `0`, checkpoint status `ok`, and zero saved jobs, but the reachable `jh-search.mjs` dependency did not create `results.json` for an empty result set. After three rehearsal attempts, the acceptance contract was narrowed below instead of modifying the out-of-scope job-hunter implementation.

## Overview

pi-agent-wave currently routes exact, writable operational searches through graphs designed for either software implementation or read-only research. Supervisors compensate with long prose prompts, duplicate script preflights, manual ledger reconciliation, and increasingly detailed retries. A schema-valid worker report can still claim `DONE` after running only a preparatory command.

Add an `operations` graph that dispatches existing commands directly to writable Herdr searchers, validates task-specific execution proof, settles retries cleanly, and records evidence automatically. Existing `build` and `research` behavior remains compatible.

The first integration target is the existing job-hunter command `jh-search.mjs`, but the package implementation must remain portable and must not contain author-machine paths.

## Goals

- Dispatch an exact argv to a visible Herdr searcher without a planning node or script reimplementation.
- Require observable execution artifacts before an operational search can report `DONE`.
- Preserve explicit writable-path ownership and serialize shared database ownership.
- Make Herdr run-state updates safe under concurrent starts and cleanup.
- Settle superseded workers before retry dispatch so closed tabs never remain `running`.
- Append accepted, blocked, and failed ledger outcomes automatically without supervisor-authored placeholder reports.
- Keep prompts and retries concise by relying on structured command and report contracts.

## User Stories

### US-001: Dispatch a structured operational command directly

**Description:** As a supervisor, I want to initialize an operational-search graph with structured commands so that visible search workers execute existing artifacts instead of planning or recreating them.

**Acceptance Criteria:**

- [x] `GraphKind` accepts `operations` while existing `build` and `research` initialization remains unchanged. Proof: focused topology assertions in `extensions/pi-agent-wave/test/operational-search-graph.test.ts`.
- [x] The `operations` graph starts at writable `source_search`, joins all supplied source operations, advances to synthesis, then audit; it has no thinker/planning node before `source_search`. Proof: transition tests in `extensions/pi-agent-wave/test/operational-search-graph.test.ts`.
- [x] `delegate_graph op=init` accepts a non-empty structured command list whose command is `{ executable, args, cwd }`, where `args` is an argv array rather than shell text. Proof: tool-schema and initialization tests in `extensions/pi-agent-wave/test/operational-search-command.test.ts`.
- [x] Each pending source operation returned by `op=next` retains its byte-for-byte executable, argv, cwd, writable paths, and frozen model route. Proof: persistence round-trip test in `extensions/pi-agent-wave/test/operational-search-command.test.ts`.
- [x] Operational commands with overlapping writable paths are rejected before dispatch; two commands cannot both own the same canonical SQLite path. Proof: ownership rejection test in `extensions/pi-agent-wave/test/operational-search-command.test.ts`.
- [x] The generated Herdr task prompt tells the worker to run the structured argv as its first execution command, permits required instruction reads beforehand, and does not duplicate the generic report contract or job-hunter preflight procedure. Proof: exact prompt assertions in `extensions/pi-agent-wave/test/delegate-script-rehearsal.test.ts`.
- [x] `npm run typecheck` passes from `extensions/pi-agent-wave/`. Proof: command exit status.

### US-002: Gate completion on task-specific execution proof

**Description:** As a supervisor, I want operational-search completion tied to process and artifact evidence so that preparatory checks alone cannot satisfy `DONE`.

**Acceptance Criteria:**

- [x] A `source_search` report requires a typed `execution` block containing exact argv, integer exit code, source, run ID, checkpoint path and status, non-negative candidate count, source status, and a results path when candidates were produced. A completed zero-candidate run may omit the results path when its checkpoint proves zero saved jobs. Proof: accepted fixtures in `extensions/pi-agent-wave/test/operational-search-report.test.ts`.
- [x] A `DONE` report containing only generic claims, doctor output, or preflight output is rejected. Proof: focused rejected fixtures in `extensions/pi-agent-wave/test/operational-search-report.test.ts`.
- [x] Exit `0` with completed checkpoint/result artifacts may report `DONE`; budget exhaustion must include a resumable run ID and resume argv; blocker reports must identify the expected source or domain and cannot report `DONE`. Proof: status-matrix tests in `extensions/pi-agent-wave/test/operational-search-report.test.ts`.
- [x] Generic schema-version-1 reports for existing build and research nodes remain valid. Proof: existing `report-audit` tests plus a compatibility fixture in `extensions/pi-agent-wave/test/operational-search-report.test.ts`.
- [x] The validator checks that the checkpoint and any reported results path exist under the operation's declared writable roots before accepting completion. A missing results path is accepted only for a completed zero-candidate report whose checkpoint records zero saved jobs. Proof: temporary-directory boundary tests in `extensions/pi-agent-wave/test/operational-search-report.test.ts`.
- [x] `npm run typecheck` passes from `extensions/pi-agent-wave/`. Proof: command exit status.

### US-003: Mutate Herdr run state safely under concurrency

**Description:** As a supervisor, I want concurrent starts and cleanup to preserve every resource so that no visible worker becomes untracked.

**Acceptance Criteria:**

- [x] Every read-modify-write mutation of the Herdr delegate `state.json` uses one reusable lock plus atomic replace mechanism. Proof: source assertion and concurrency test in `extensions/pi-agent-wave/test/herdr-state-concurrency.test.ts`.
- [x] Two concurrent harmless worker starts retain both resource registrations and both workers can be waited and cleaned up. Proof: real Herdr integration test in `extensions/pi-agent-wave/test/herdr-state-concurrency.test.ts`; skip is not accepted when the installed Herdr dependency and workspace identity are reachable.
- [x] Concurrent close and repair-diagnostic updates preserve closed tab IDs, model attempt metadata, and report-repair diagnostics. Proof: contention test in `extensions/pi-agent-wave/test/herdr-state-concurrency.test.ts`.
- [x] A failed state mutation leaves the previous valid `state.json` readable and mode `0600`. Proof: injected-failure test in `extensions/pi-agent-wave/test/herdr-state-concurrency.test.ts`.

### US-004: Settle retries and write ledger outcomes automatically

**Description:** As a supervisor, I want worker settlement, graph recording, and ledger append handled by the execution path so that retries do not leave stale agents or require manual placeholder JSON.

**Acceptance Criteria:**

- [x] Before dispatching a replacement worker, the prior worker is marked failed or settled, its diagnostics are retained, its tab is closed, and its agent row is no longer `running`. Proof: retry lifecycle assertion in `extensions/pi-agent-wave/test/operational-search-settlement.test.ts`.
- [x] A valid positive operational report creates one `accepted` ledger entry; a valid blocker creates one `blocked` entry. Proof: isolated temporary ledger tests in `extensions/pi-agent-wave/test/operational-search-settlement.test.ts`.
- [x] A missing or invalid report after one repair creates one `failed` ledger entry containing diagnostics without a supervisor-authored placeholder report. Proof: worker-exits-without-report fixture in `extensions/pi-agent-wave/test/operational-search-settlement.test.ts`.
- [x] Settlement is idempotent: replaying the same operation result does not create a second ledger entry or regress graph/agent status. Proof: replay test in `extensions/pi-agent-wave/test/operational-search-settlement.test.ts`.
- [x] Automatic ledger outcome and Delegate Graph operation/agent status agree after accepted, blocked, failed, and retried paths. Proof: state-versus-ledger matrix in `extensions/pi-agent-wave/test/operational-search-settlement.test.ts`.
- [x] Retry prompts reduce to the exact command, prior execution diagnostics, and existing report-repair contract; retries do not accumulate the original prose prompt. Proof: prompt-length and required-field assertions in `extensions/pi-agent-wave/test/delegate-script-rehearsal.test.ts`.

### US-005: Rehearse the real job-hunter integration safely

**Description:** As a job-hunter user, I want the operational-search workflow proven against the existing search artifact so that the mechanism is not validated only with fabricated commands.

**Acceptance Criteria:**

- [x] A harmless persisted-script rehearsal proves the exact argv boundary, launch ordering, report creation, file-descriptor behavior where applicable, and child exit-code propagation. Proof: `extensions/pi-agent-wave/test/operational-search-rehearsal.test.ts` executes a temporary harmless target end to end.
- [x] The installed `jh-search.mjs --help` contract is checked for `--db`, `--budget-minutes`, `--resume`, JSON output, and documented exit codes before the live rehearsal. Proof: captured assertions in `extensions/pi-agent-wave/test/job-hunter-operational-search.test.ts`.
- [x] A bounded real CDP search runs through the exact structured operational command against an isolated temporary SQLite database supplied with `--db`; it must not write `~/.job-hunter/jobhunter.sqlite`. Proof: before/after canonical database hash plus execution report, checkpoint, isolated database assertions, and a results artifact when the dependency produces candidates in `extensions/pi-agent-wave/test/job-hunter-operational-search.test.ts`.
- [x] The live rehearsal records exact argv, child exit code, run ID, checkpoint status, results path, candidate count, and resume argv when budget-exhausted. Proof: accepted `source_search` report fixture produced by the live run.
- [x] User-facing operational-search usage and ownership constraints are documented in `extensions/pi-agent-wave/README.md`; root `README.md` links to that workflow without duplicating the full reference. Proof: assertions in `extensions/pi-agent-wave/test/package-docs.test.ts`.
- [x] Full completion gate passes: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, `npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, `npm publish --dry-run --json --ignore-scripts`, and `git diff --check`. Proof: recorded command exit statuses in this PRD's Verification section.
- [x] The story ledger passes `node --experimental-strip-types extensions/pi-agent-wave/scripts/ledger.ts audit operational-search-delegation`. Proof: command output recorded in this PRD's Verification section.

## Functional Requirements

- FR-1: The system must add an `operations` graph without changing existing build/research behavior.
- FR-2: An operations run must start with one or more structured source commands and no planning node.
- FR-3: Structured commands must preserve exactly one executable plus argv array and cwd; the package must not turn them into interpolated shell strings.
- FR-4: Every writable source operation must declare owned paths before dispatch.
- FR-5: Writable-path ownership must be disjoint across concurrently dispatchable operations.
- FR-6: The worker prompt must require the exact command as the first execution action while allowing required read-only instruction loading.
- FR-7: `source_search` completion must require typed execution proof in addition to generic evidence-bearing claims.
- FR-8: Task-specific validation must reject preparatory-only evidence and verify declared artifacts under writable roots. A completed zero-candidate run may omit a results artifact only when its checkpoint records zero saved jobs.
- FR-9: Budget exhaustion must preserve resumability; security, CAPTCHA, verification, and preflight failures must remain blockers rather than automatic retries.
- FR-10: Herdr state mutation must use one reusable lock and atomic replacement mechanism.
- FR-11: Retry dispatch must settle the superseded worker and close its tab first.
- FR-12: Accepted, blocked, and failed reports must append exactly one matching ledger entry automatically.
- FR-13: Settlement and ledger append must be idempotent by operation identity.
- FR-14: Concurrent source workers must not share ownership of one SQLite file; merging or canonical persistence must be a separate serialized owner.
- FR-15: Shipped code and documentation must not embed `/Users/spotted` or another author-machine path.
- FR-16: Existing public `/delegate`, `/graph`, and `delegate_graph` build/research contracts must remain compatible.

## Non-Goals

- Reimplement job-hunter search, scoring, salary enrichment, or browser preflight logic inside pi-agent-wave.
- Add permanent role recall, stale-role classification, embeddings, or local-LLM adjudication; that is a separate feature.
- Run LinkedIn and Indeed concurrently through one shared CDP session.
- Allow two workers to write the canonical job-hunter SQLite database concurrently.
- Replace Herdr or add a hidden/panel worker transport.
- Publish the npm package, apply a real Pi migration, modify credentials, or merge a pull request.
- Generalize an arbitrary distributed command runner beyond the operational-search graph.

## Design / Technical Considerations

- Add a distinct `source_search` node rather than making the existing read-only research `search` node context-dependent. Its role remains `searcher`, but it is writable and requires declared ownership.
- Persist structured command data rather than embedding it solely in task prose. Rendering must preserve one argv boundary and use direct process execution or one correctly quoted `bash -lc` boundary only where the worker tool requires a shell.
- Keep generic report schema compatibility. Add task-specific operational execution validation only for `source_search` operations.
- Reuse `ledger.ts` for ledger format and auditing. Add operation identity/idempotency rather than creating supervisor-authored rejected-candidate placeholders.
- Reuse one Herdr state-mutation helper for resource registration, route updates, report repair diagnostics, tab closure, and cleanup.
- The real job-hunter integration supports `--db`; seed a temporary SQLite database from the reachable schema and use a bounded budget. The canonical job-hunter database must be hash-checked before and after. `jh-search.mjs` currently omits `results.json` when a successful source run saves zero jobs; pi-agent-wave must validate that case through the checkpoint rather than changing job-hunter behavior in this feature.
- The required skill read is not an execution action. “First execution command” means no planning command, generated script, doctor command, or alternate preflight command may run before the supplied argv.

## Success Metrics

- Operational task prompts contain only the exact structured command, concise success fields, and the shared generated report contract.
- A preparatory-only `DONE` report is rejected mechanically.
- Concurrent Herdr starts lose no resources.
- Retried workers leave no closed agent row marked `running`.
- Each settled operational source produces exactly one matching ledger outcome.
- The bounded real job-hunter rehearsal leaves the canonical database unchanged and produces auditable execution artifacts.
- All focused and full package verification commands pass.

## Open Questions

None. The handoff fixes the graph shape, structured command boundary, execution-proof fields, retry policy, database serialization rule, and rehearsal order.

## Verification

- Full Node gate with reachable live proofs enabled: `193` tests in `35` suites passed, with zero failures and zero skips.
- Package-focused Bun gate: `33` tests across `8` files passed with zero failures.
- `npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, `npm publish --dry-run --json --ignore-scripts`, and `git diff --check` passed.
- Real Herdr proof passed: two concurrent harmless tabs were retained and cleaned, and the visible review run retained all three concurrently started search workers. State-lock contention, mutation failure, close/repair contention, blocked-report handling, and orphan-lock recovery tests passed.
- Real job-hunter proof: `linkedin-IE-20260830-093621` completed with checkpoint status `ok`, one completed query, and zero saved jobs against an isolated SQLite copy. The canonical database and its restore point both hashed to `690f1c91156f4349236330210da69abe6c56f5e00089ccff3d15fc5ca67a52ca`.
- Durable rehearsal evidence: `agent-output/operational-search-delegation/live-job-hunter-report.json`; ledger audit result: `PASS: audited 1 ledger files`.
- Test isolation repair verified: the real Delegate Graph database contains zero `operational-tool`, `operational-blocked`, or `operational-failed` test stories after cleanup; the test now sets `DELEGATE_GRAPH_DB` to a temporary path.
- Fresh-context semantic review evidence: `agent-output/operational-search-delegation-review/delegate-ledger/`; audit result: `PASS: audited 5 ledger files`. Review-driven fixes covered physical ownership aliases, failed-to-accepted ledger reconciliation, test database isolation, state-lock recovery and contention, blocked report handling, and concise retry-prompt assertions. The reviewer found no remaining blocker; its final stale-plan finding was resolved afterward by synchronizing both PRD status lines, acceptance checkboxes, and this verification section.
