# Handoff: delegated write slices produce no files (AgentFS / Delegate Graph)

**Status:** superseded by `tasks/prd-delegated-write-slice-settlement.md` — the staging defect is
fixed there, and the two diagnoses below are corrected there
**Recorded:** 2026-09-20
**Corrected:** 2026-09-20 — two premises in this report were wrong and must not be repeated:

1. §3.4 ("the overlay cannot be written at all") is withdrawn. AgentFS mounts the host tree as a
   read-only *base* and accepts writes into its delta layer. A bounded real slice reproduced both
   halves: the session's writes landed in the delta, and the host tree was byte-identical after.
   The real cause is the ownership rule in `lib/agentfs-sandbox.ts`, which called a created parent
   directory an unowned change and refused settlement for it.
2. The macOS `/mnt` dialog is neither a `/mnt` reference in code nor a test artifact. Two dead `nfs`
   mounts to `127.0.0.1` were left under real `delegate-graph-herdr-run-*` directories by delegated
   workers; `mount` reported them, `ls` on them hung, and no code in the package unmounts an AgentFS
   mount. They were released by hand with `umount -f`.

**Reported by:** Pi supervisor session working in `/Users/spotted/projects/rag-microservice`
**Affects:** Delegate Graph `build` graph, `implement` node, Herdr transport
**Does not affect:** the `research` graph / read-only roles, which settle and retain correctly

## 1. Summary

A delegated implementation slice can complete successfully from the worker's own
point of view and still deliver **zero file changes to the working tree**. The
worker exits `0` with a complete captured answer describing the files it created
and the tests it ran; the graph independently records the attempt as failed and
stages nothing.

An operator reading only the worker's report would conclude the work is done.
An operator reading `git status` sees nothing. Both are looking at the same run.

The second, related defect: a delegated worker on the read-only host path cannot
write **anything** into the mounted virtual filesystem — not even the `.coverage`
file the pytest coverage gate needs. So "run the suite with coverage" is
unsatisfiable for a delegated worker, independently of whether its edits would
have been exported.

## 2. Impact

- Two implementation attempts (~30 minutes of worker time each) produced
  deliverable code that was discarded. Neither could be recovered: the AgentFS
  overlay that held it was removed when the attempt failed.
- The failure mode is silent in the direction that matters. `delegate_graph`
  `collect` returned `settled: true` with a full `answer` and no diagnostic on
  attempt 1; the failure is only visible by cross-checking `processState`,
  `stagedFiles`, and the filesystem.
- Delegation is currently unusable for any slice that must change files, which
  makes the whole build graph unusable for its primary purpose.

## 3. Evidence

### 3.1 Writer slice — worker succeeded, graph failed, nothing staged

Run `run_5132c864-9152-4420-90ee-44b273123135`, operation `op_2a36e068-992e-449c-80a4-fa9740415cda`
(node `implement`, role `implementer`, `read_only: 0`, `ownedPaths` non-empty).

From the settlement/failure record
(`…/failure-op_2a36e068-992e-449c-80a4-fa9740415cda.json`):

```
reason:           "attempt aborted before cleanup"
processExitCode:  null
agentFsSnapshot:  {"backupError": null, "method": "backup",
                   "path": "…/acpx/dg_run-5132_implement_bb9b918d/agentfs-snapshot/delta.db"}
```

From the same record's `workerResult.output`, i.e. the worker itself:

```
outcome:      {"kind": "exited", "exitCode": 0}
capture:      {"captureStatus": "complete", "answerBytes": 11563,
               "responseCompleteness": "unverified", "ignoredEvents": 19504}
```

The worker's retained answer reports 24 production files, 8 test files, 109
passing tests and `lint-imports` green.

Observed on the filesystem:

- `git status` in the target repo showed no `app/topics/` and no modification to
  any tracked file.
- `ls app/topics` → `No such file or directory`.
- `stagedFiles: 0` in the settlement record.
- The `agentFsSnapshot.path` above **no longer exists**; the run directory was
  cleaned on failure, so the overlay contents were unrecoverable.

### 3.2 Read-only slice — silently discarded, then reported as a normal result

Run `run_5132c864-9152-4420-90ee-44b273123135`, operation `op_2c8e38e4-7519-4a61-b624-15360696c814`
(node `thinker_plan`, role `thinker`, `read_only: 1`).

Same shape: worker exited `0`, `captureStatus: complete`, 11,663-byte answer
describing 24 files and 99 passing tests. `stagedFiles: 0`. Nothing on disk.

This one was an operator error as well — an implementation-sized task was
dispatched to a read-only planning node — but the pipeline gave no signal that
the work was being discarded rather than produced.

### 3.3 Read-only research does integrate

For contrast, the same transport settled a review correctly:
`run_4ae63627-bc66-4455-973c-dd7c13e51649` retained its answer by content hash
at `~/.cache/delegate-graph/runtime-content/bfeca6f46aa5a7b3864e4a9e7e42ebfaf491e720dcfe16439945b9309925a13e`
(19,732 bytes) and the entry was written and audited into the delegate ledger.

So the transport and the answer-capture path work. The defect is specific to
staging file changes out of the overlay.

### 3.4 The overlay cannot be written at all

Reported by the operator driving this work: the AgentFS partition backing the
worker's mounted workspace is read-only, so a worker cannot create files in it —
including `.coverage`. That makes the coverage requirement
(`uv run pytest --cov …`) logically unsatisfiable for a delegated worker, and it
means the writes the workers *believed* they made cannot be relied upon as a
source to export from.

## 4. Confirmed vs hypothesised

State plainly so the next person does not repeat this analysis:

**Confirmed**

- Writer slices stage nothing: `stagedFiles: 0`, no tree change (3.1).
- The worker-side signal is a success, not a failure (3.1, 3.2).
- The overlay is deleted on failure, so work is unrecoverable (3.1).
- Read-only research settles and retains normally (3.3).
- The worker's mounted workspace is read-only (3.4).

**Hypothesised, not yet proven**

- That the read-only mount is the *cause* of `stagedFiles: 0` rather than a
  co-symptom. If the mount is read-only, the worker's writes may be landing
  somewhere that the export step does not consider, or failing silently.
- That "attempt aborted before cleanup" and the missing staging are the same
  defect or two. A previous run in this session also reported
  `postSettlementFailures: ["cleanup absence audit failed: tabAbsent; paneAbsent"]`,
  which points at lifecycle/cleanup rather than export.
- Whether an `agentfs`-backed worker is *supposed* to be writable for
  `read_only: 0` operations, or whether a second writable mount is required.

## 5. Code-level leads already gathered

These narrow the search; none is yet a diagnosis.

- `scripts/delegate_core.py:737` appends to the worker prompt:
  *"Read-only host mode: all tool activity stays inside AgentFS COW and every
  overlay change will be discarded. Zero repository paths are exported."*
  This explains 3.2 directly.
- `scripts/delegate_core.py:1262` carries the comment:
  *"The runtime settle configuration receives the snapshot path directly; the
  legacy export configuration it used to rewrite is gone."*
  i.e. the export path was deliberately replaced by the runtime-settle snapshot
  path. Worth checking that the replacement is wired for the Herdr transport.
- `scripts/agentfs-export.ts` — the CLI wrapper that audited overlay changes
  against `ownedPaths`/`ignoredPaths`, reported violations, exported owned
  changes via `exportOwnedAgentFsChanges`, and honoured a `discardAllChanges`
  flag — was **deleted in commit `d9af58a`**. The underlying
  `lib/agentfs-sandbox.ts` still exists and is still referenced by
  `scripts/acpx-worker.ts`, `lib/runtime-staging.ts` and others, so the
  capability survives; what needs checking is whether every transport still
  reaches it.
- `lib/runtime-staging.ts` exposes `stageRuntimeAgentFs(...)` and returns a
  manifest with `files`. Confirm it runs on the Herdr `implement` path and that
  its input snapshot is the one that actually exists at settle time.

## 6. What needs to be solved

Acceptance criteria for closing this out. Each names a concrete proof.

1. **A writer slice's files reach the working tree.**
   Proof: dispatch a `read_only: 0` slice that creates one known file; assert the
   file exists in the target repo after settle, and that the settlement reports
   `stagedFiles` equal to the number of files created.
2. **The graph's verdict and the tree agree.**
   Proof: a run whose `processState` is failed/settled must not be accompanied by
   a worker answer claiming success; either the run reports success and the files
   are present, or it reports failure and the answer says so. No third state.
3. **A discarded overlay is either preserved or announced.**
   Proof: after a failed attempt, the overlay snapshot named in the failure
   record still exists, *or* the failure record states that the overlay was
   discarded and names what was lost. Today the record points at a path that has
   already been deleted.
4. **A worker can satisfy the coverage gate.**
   Proof: a delegated slice runs `uv run pytest --cov …` successfully and the
   coverage artifact is written; or the mount is documented as read-only and the
   coverage criterion is explicitly excluded for delegated slices.
5. **Violations of `ownedPaths` are enforced and reported, not silently dropped.**
   Proof: a slice that edits a non-owned path fails with a violation naming the
   path, rather than producing `stagedFiles: 0` with no explanation.
6. **The documented ledger workflow works from a clean checkout.**
   Proof: `delegate-ledger write …` resolves `scripts/ledger.ts` in the tree that
   `settings.json` registers, with no `PI_AGENT_WAVE_ROOT` override. See §7.

## 7. Related defects found while reproducing

These are separate from the staging failure but blocked the same workflow.

### 7.1 `delegate-ledger` cannot resolve its script

`~/.pi/agent/scripts/delegate-ledger` resolves `scripts/ledger.ts` by scanning
the absolute paths in `settings.json`. The registered path is
`/Users/spotted/projects/pi-agent-wave-new-design/extensions/pi-agent-wave`
(`settings.json:29`), and that tree has **no** `scripts/ledger.ts` or
`scripts/report-audit.ts` — both were deleted in commit `d9af58a`.

```
MISS /Users/spotted/projects/pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/ledger.ts
HAS  /Users/spotted/projects/pi-agent-wave/extensions/pi-agent-wave/scripts/ledger.ts
HAS  /Users/spotted/projects/pi-agent-wave-bak/extensions/pi-agent-wave/scripts/ledger.ts
```

Result: the prescribed command fails with *"no loaded package provides
scripts/ledger.ts"*, and the documented evidence-ledger workflow is unavailable
unless the operator knows the undocumented override (pointing
`PI_AGENT_WAVE_ROOT` at the package directory that still has it, not at the repo
root — the wrapper joins `<root>/scripts/ledger.ts`).

Needs: either restore `ledger.ts`/`report-audit.ts` to the registered tree, or
update the wrapper and the AGENTS.md rule that documents it.

Two follow-on observations, both verified:

- No file in the live tree references `report-audit` any more, so the deletion is
  clean on that side — nothing dangles.
- `test/production-audit.test.ts:21` still classifies a command as the `ledger`
  case when one of its arguments ends with `ledger.ts`, and line 24 asserts that
  case returns `{valid: true, files: …, findings: []}`. So the production audit
  still expects a `ledger.ts` to exist and be invoked, while the registered tree
  no longer ships one. Either the audit's expectation is stale or the script's
  removal was unintended; the two need to be reconciled.

### 7.2 A tier whose first model has no provider prefix is unresolvable

`~/.pi/agent/model-routing.jsonc` had `"deepseek-v4.1-flash"` (no `provider/`)
as the first entry of the `reasoning` tier, while every other entry in the file
is provider-qualified and the file's own header documents the format as
`provider/model-id`. Preflight failed with `provider_not_found`, and because the
`review` tier is promoted to the `reasoning` floor for planning roles, an
explicit tier request failed too.

Fixed by the operator during the session. Worth a guard: the repo already has
`lib/model-routing-config.test.mjs` asserting the `provider/model` shape — the
question is why it did not run on that edit.

## 8. How to reproduce

1. Use a supervisor session on the Herdr transport with
   `HERDR_ENV=1`, `HERDR_WORKSPACE_ID` and `HERDR_TAB_ID` set (verified present).
2. `delegate_graph` `init` with `graph: "build"`, then `decide` with a slice
   declaring non-empty `ownedPaths`, then `dispatch`.
3. Have the worker create one known file under an owned path.
4. After settle, compare: the worker's answer, `processState`, `stagedFiles`,
   and `git status` in the target repo.

Expectation today: the answer describes the file, `stagedFiles: 0`, and the file
is absent.

## 9. Recovery notes

- A failed attempt's overlay is deleted; there is no reliable way to recover the
  work after the fact. Capture the worker's answer early, and treat it as a
  design record rather than a deliverable.
- The two lost reports from this incident were preserved by hand as
  `notes/slice1-implementer-report-lost.txt` and
  `notes/slice1-planning-node-report-lost.txt` in
  `/Users/spotted/projects/rag-microservice`. The implementer report is the more
  useful: it records the design decisions and the exact evidence the worker
  believed it observed.
- For the work that prompted this: the affected slice was rebuilt directly in the
  supervisor session, where the tree is writable, and is being committed in
  verified increments.