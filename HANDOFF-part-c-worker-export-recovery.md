# Part C: Worker Export and Report Recovery

Prepared 2026-09-11 at the user's request. This is a development handoff,
not an acceptance report or authorization to publish.

## Scope and Current State

Part C is the orchestrator work from the job-hunter conversation: recover
missing worker reports and prevent false unauthorized-file export refusals.
It belongs to this repository, not to job-hunter's profile generalisation.

- Package: `extensions/pi-agent-wave/`.
- Current branch: `issue-worker-export-recovery`.
- HEAD observed while writing: `d4a19c8`.
- Implementation remains uncommitted in this working tree.
- The tree also contains earlier report-gate and provider-catalog/runtime work.
  Do not attribute every changed file to the Part C worker or discard changes.
- Job-hunter Parts A/B were committed and merged into that repository's local
  main. That operation did not commit or merge anything here.

Read `AGENTS.md` and the canonical `tasks/prd-package-delegate-graph.md` before
continuing. This handoff does not replace the PRD. Update the PRD before any
behavioral or acceptance-criteria change. Preserve the current dirty files with
private restore copies before editing them, as required by AGENTS.md.

## Reported Implementation

Paths below are relative to `extensions/pi-agent-wave/`. The earlier worker
reported all nine items implemented; that claim still needs combined-diff review.

1. **Audit failures are not modifications.** `lib/agentfs-sandbox.ts` adds
   `AgentFsAuditError` and `agentFsChangeInventory`. Failed overlay reads become
   `audit_error` entries. `scripts/agentfs-export.ts` writes them into the receipt;
   `scripts/delegate_core.py` surfaces the distinct failure message.
2. **Configured executable is used for audit.** `auditAgentFsChanges` receives
   `agentFsExecutable` through export options, avoiding an unrelated PATH binary.
3. **Owned-path normalization agrees across runtimes.** `realpathExistingPrefix`
   resolves existing prefixes and preserves missing tails. Escapes become per-path
   errors. Whole-base ownership requires explicit `ownWholeBase: true`.
4. **Ignored Git bookkeeping is reachable.** Python accepts `--ignored-paths-json`;
   `index.ts` passes the default list: `.git/index`, `.git/ORIG_HEAD`, `.git/FETCH_HEAD`.
   Explicit `[]` disables those defaults. Other Git writes remain subject to audit.
5. **Owned platform metadata can export.** Ownership is checked before filtering
   `._*` and `.DS_Store`; only unowned metadata is discarded.
6. **Infrastructure failures can retry.** `retry.ts` recognizes missing reports,
   exits before results, runtime-configuration changes and AgentFS audit errors.
   Genuine unowned-change violations remain permanent; semantic verdicts must not
   trigger model failover. Existing timeout classification covers result timeouts.
7. **Repair does not reuse a rejected report.** `set_aside_rejected_report` moves
   it to `report-rejected-N.json` before a prompt-mode repair turn. Projection
   remains diagnostic only and cannot supply a positive semantic verdict.
8. **Settlement waits for worker exit.** `wait_for_worker_exit` adds a bounded
   wait, controlled by `PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS` (default 30000).
   Cleanup matching fixes precedence and excludes supervisor/launcher noise.
9. **SQLite backup is the primary snapshot method.** `snapshot_agentfs_db` uses
   `sqlite3.Connection.backup`, switches the snapshot to DELETE journal mode,
   and records the method and any backup error in the resource receipt.

## Evidence and Its Limits

The following results are historical reports from the earlier session, not
tests rerun while creating this document:

- Full serial Node suite: 496 tests, 484 passed, zero failures, 12 opt-in skips.
- Targeted suites: agentfs-sandbox 20/20, owned-path-normalization 3/3,
  retry 21/21, acpx-worker-launch 12/12, acpx-cleanup 35/35.
- Typecheck, Python compilation, pack dry-run (69 files), publish dry-run and
  whitespace checks reportedly passed.
- The earlier lead reported separate spot checks of retry and sandbox suites.

Fresh checks for this handoff were read-only: branch/HEAD and dirty status,
AGENTS.md/package commands, and the presence of implementation anchors for the
inventory, ownership normalization, ignored paths, repair, worker exit and backup.
No full behavioral verification or independent acceptance was performed here.

## Review Before Declaring Completion

- **Snapshot fallback retains the original race risk.** Fresh inspection shows
  that a `sqlite3.Error` falls back to separate raw copies of DB/WAL/SHM. Recording
  the fallback is not proof of consistency. Review whether to fail closed or prove
  the writer has stopped before copying; the original plan called for consistency.
- **Streaming comparison was not implemented.** Fresh inspection still shows
  `spawnSync(... maxBuffer: Infinity)` and `readFileSync` for full-buffer comparison.
  Review memory bounds and host-side read failures, not only overlay command errors.
- **Platform metadata policy needs explicit acceptance.** On macOS, AppleDouble
  companions created automatically inside owned directories now export too.
  Do not silently reverse this behavior without a recorded policy decision.
- **Documentation and configuration exposure need review.** The worker reported
  no README edits of its own; existing README modifications predate that work.
  Confirm documentation for ignored paths, whole-base ownership and worker exit.
  The default ignored-path list is passed as a constant, not stored per operation.
- **Review the whole combined revision.** Other changed files include
  `scripts/acpx-worker.ts`, `scripts/report-audit.ts`, `store.ts`, report-projection
  tests, provider-runtime tests, README and the PRD. Keep their provenance intact.
- Skipped live tests are not live compatibility proof. Earlier packaging or
  acceptance findings remain open unless the canonical PRD explicitly closes them.

## Resume and Verify

First inspect `git status --short`, `git diff --stat` and the PRD's latest log.
Review the combined changes and resolve the caveats above with focused tests.
Then use the repository's documented completion gate from its root:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts
git diff --check
```

For comparison with the earlier serial result, add `--test-concurrency=1` before
the test-file glob. From `extensions/pi-agent-wave/`, also run:

```bash
npm run typecheck
npm pack --dry-run --json --ignore-scripts
npm publish --dry-run --json --ignore-scripts
```

Follow AGENTS.md for package-focused Bun checks, the Node-only installation
rehearsal and prerequisites. Record fresh counts, skips, failures and source
revision; do not substitute this historical report for fresh evidence.

Do not dispatch paid/live workers, alter real Pi settings/credentials/installations,
apply migrations, publish, commit, merge or push without separate user authorization.
The current request authorizes this handoff document only.

## Continuation review — 2026-09-11

The user's subsequent `continue` authorized local review and corrections. Those
changes remain uncommitted on the same branch. Pre-edit copies of the entire dirty
revision are in `agent-output/part-c-review-20260911/before/`; the canonical PRD now
opens with the review scope, decisions, evidence and remaining gates.

The review corrected unsafe raw SQLite fallback, unbounded backup retries,
dangling-symlink/parent-traversal normalization, host audit-error handling,
ownership failure classification, cleanup false negatives, and rejected-report
symlink target chmod. Ignored paths now default to empty to match the canonical
PRD's strict Git ownership contract; explicit private-launch overrides remain.
Ownership-first platform metadata is retained and documented. Streaming is
explicitly deferred under the existing in-memory design, with memory scaling
recorded as a limitation.

Fresh final checks: 85 selected logic tests and 10 focused review tests pass,
as do 46 Bun package tests, typecheck, Python compilation, pack/publish dry runs
and whitespace checks. Full Node: 504 tests, 462 passed, 30 failed, 12 opt-in skips.
Mounts, process inspection and process substitution are restricted in this sandbox;
the installation rehearsal also fails and has a masking cleanup assertion.
Host-read and mounted export acceptance remain unverified. No paid worker, live
installation change, graph recovery, commit, merge, push or publication occurred.
See `agent-output/part-c-review-20260911/REVIEW.md` and the PRD for details.
