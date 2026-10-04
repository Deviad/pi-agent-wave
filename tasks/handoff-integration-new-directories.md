# Handoff: a candidate that adds a file in a new directory cannot be integrated into a repository

**Recorded:** 2026-10-04
**Reported by:** the operator, from `run_4b30826b-b84f-4f11-ad0c-2354cd3643fc` (story `ats-adapters-us006`, build
graph, Herdr transport, implement operation `op_b7c4d0f8-29b7-4c04-bd82-e67170be7c0e`, candidate
`a372d00ca9e1d8897bc956dc528c84417c2a83b027994e2b4adb708a2e436f55`, model `alibaba/deepseek-v4.1-flash`),
supervised from `~/projects/job-hunter-public`.
**Affects:** every `op=integrate` in repository mode (`gitChecks` true) whose candidate creates a file under a
directory that does not exist at the base revision. Home-workspace mode (`gitChecks` false) is not affected.
**Not a PRD.** This file is a work order. Read it with `specification.md` (integration and the runtime journal)
and `tasks/handoff-settlement-and-integration-races.md`.

**Status:** opened 2026-10-04; defect 3 explained and items 1–3 implemented the same day (§3 result, §4 decisions); the
live criterion is open.

## 1. Summary

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | `RuntimeIntegration.target()` rethrows `ENOENT` for a missing parent directory whenever `gitChecks` is true, both when taking the before-image in `prepare()` and when writing in `replace()` | A repository-mode candidate that adds a file in a new directory can never be integrated. The worker's verified work is stranded |
| 2 | The error is the raw `lstat` message: no entry name, no hint that the parent is a new directory | The operator cannot tell a design limit from a broken workspace |
| 3 | After the operator created the missing directories by hand, `op=integrate` kept failing with `ENOENT` on paths that existed (§2) | Unexplained. The obvious workaround does not work |
| 4 | When integration is impossible, the run cannot reach `decide accepted`, so a correct candidate can only be cancelled | The graph records a good result as cancelled, and the review and test nodes never run |

Defects 1 and 2 are plain bugs with a known fix. Defect 3 needs a reproduction before it can be fixed. Defect 4 is
a design question; §4 item 4 proposes one answer.

## 2. Evidence (2026-10-04)

The candidate's staging manifest (`runtime-content/f39104fe…`, 2502 bytes, `baseRevision` `6e01f68`) lists 10
changes. Two of them sit in directories that do not exist at the base:
`skills/auto-job-application/scripts/adapters/index.mjs` and `test/fixtures/ats/contract/{blocker,review}.html`.
Every path is relative and inside the operation's owned paths.

| Time (CEST) | Action | Result |
| --- | --- | --- |
| ~13:55 | `op=integrate` on the clean tree at `6e01f68` | `ENOENT: no such file or directory, lstat '…/job-hunter-public/skills/auto-job-application/scripts/adapters'` |
| 13:55 | Operator: `mkdir skills/auto-job-application/scripts/adapters`; `ls -ld` shows it | — |
| ~13:55 | `op=integrate` again | the same `ENOENT` on `…/scripts/adapters`, which existed |
| 13:56 | Operator: `mkdir test/fixtures/ats/contract`; `ls -ld` shows both directories | — |
| ~13:56 | `op=integrate` again | `ENOENT: … lstat '…/job-hunter-public/test/fixtures/ats/contract'`, which existed |
| after | `ls -ld` | both directories still present; `git status --short` empty |

Other observations:
- `runtime_integrations` in the graph store holds no row for this candidate, so no journal entry was replayed. The
  only row for this workspace is an earlier, successful integration (state `applied`).
- `~/.local/share/delegate-graph/runtime-integration-staging/` was empty afterwards.

Code, read on `16672c8`:
- **`target()`, `lib/runtime-integration.ts:163-184`.** It walks each parent of the path with `lstatSync`. On a
  missing parent: `if (gitChecks || !absent(error)) throw error;` (line 172), then
  `if (!createParents) return null;` (line 173). The refusal is deliberate. Its doc comment (`:157-162`) says:
  "With Git checks every parent must already exist and none may hold a nested repository, because Git's index and
  submodules own those paths."
- **`prepare()`, `:233`.** It calls `this.snapshot(workspace, path, true, gitChecks)`, which reaches `target()`
  with `createParents` false. In repository mode, therefore, a new directory fails before the journal row is
  written.
- **`replace()`, `:282-283`.** It calls `target(…, manifest.gitChecks, image !== null)`. In repository mode it
  would throw on a missing parent at write time as well.
- **No test covers it.** None of the three integration test files (`runtime-integration.test.ts`,
  `runtime-candidate-integration.test.ts`, `integration-sibling-race.test.ts`) creates a candidate file in a new
  directory.

How the work was landed instead (recorded so the fix can be checked against it):
- The supervisor read each change's bytes from `runtime-content/<sha256>`, checked the SHA-256 and byte count
  against the manifest, and confirmed `HEAD` equalled the manifest's `baseRevision` with a clean tree.
- It wrote the 10 files, re-hashed them, re-ran the downstream project's full verification, and committed the
  result as `234153f`.
- It then cancelled the operation with that reason, since `decide accepted` requires a recorded integration.

## 3. Hypotheses for defect 3

**Result (2026-10-04): none of the three. Defect 3 is a supervisor race, not a product bug.** The supervisor
session (`~/.pi/agent/sessions/--Users-davidepugliese-projects-job-hunter-public--/2026-10-03T06-20-56-295Z_01a1006c-….jsonl`)
shows that both retries were sent as one assistant message holding two parallel tool calls: entry 551 (11:55:41Z)
holds `bash mkdir …/scripts/adapters` and `delegate_graph op=integrate`, and entry 570 (11:56:52Z) holds
`bash mkdir test/fixtures/ats/contract` and `op=integrate`. Each `integrate` returned in 100–200 ms, before its
sibling `mkdir` took effect, so each error is exactly one step behind the operator's view: the retry that
accompanied the `adapters` mkdir still saw no `adapters`, and the retry that accompanied the `contract` mkdir saw
`adapters` and failed on `contract`. Nobody integrated a fourth time. Replaying the real manifest
(`runtime-content/f39104fe…`, real blobs) against a scratch clone at `6e01f68` with the same mkdir sequence, each
step in order, gives: `ENOENT …/adapters`, then `ENOENT …/contract`, then `applied`. Hypothesis 1 is refuted
independently: `target()` before `76bf8c6` also only `lstat`ed each parent, which an existing empty directory
passes. Lesson for supervisors: never issue a workspace mutation and the `integrate` that depends on it in the
same parallel batch.

The original hypotheses, kept for the record:

1. **The supervisor ran an older module.** The supervisor's Pi session started on 2026-10-03 and loaded the
   extension then. `integrate` runs in-process, so it may have been running a `runtime-integration.ts` that differs
   from `16672c8` on disk.
2. **Another check fails with a stale message.** A failed `prepare()` leaves state that makes the next call throw
   at a different check while reporting the previous error. The empty staging directory and the absent journal row
   argue against this.
3. **The `git status` pathspec.** `git status --porcelain -- <path>` is run on a file whose parent is an untracked,
   empty, freshly created directory. If it errors, the error could surface as the `lstat` message of an earlier
   step. Unlikely, but cheap to rule out.

## 4. Proposed design (to confirm before implementation)

1. **Allow new directories in repository mode.**
   - In `prepare()`, a missing parent means the path is absent: its before-image is `null`, exactly as in Git-free
     mode.
   - In `replace()`, create the missing parents of a file being written.
   - Each directory created must be a real directory, created with `mkdirSync` (no symlinks), inside the
     workspace. The nested-repository check (`.git` under a parent) still runs on every component that exists.
   - This answers the stated reason for the refusal (`:157-162`). A directory the integration creates is new and
     empty, so it cannot hold a nested repository or a submodule. Git's index has no entry under it until the
     operator commits. The refusal protects existing paths, and an absent directory is not one.
   - Record in the journal entry which directories the integration created, so that rollback removes exactly those,
     deepest first, and only when empty. A directory that existed before integration is never removed.
2. **Name the entry in the error.** Any remaining parent failure says
   `integration parent <dir> of <entry> is missing or not a real directory`, never a bare `lstat` message.
3. **Reproduce defect 3** with a test that pre-creates the empty parent directories and then integrates, in
   repository mode. If it passes on `16672c8`, record hypothesis 1 as the likely explanation, together with a note
   that a long-running supervisor must reload the extension after an update.
4. **Adopt an already-applied workspace (judgement call).** When every manifest entry's `after` image already
   matches the workspace byte for byte, and `HEAD` equals the base revision, `op=integrate` records the integration
   as `applied` instead of failing on the dirty preimage. A candidate landed by hand, as in §2, could then still go
   through review and test. Reject this item if it weakens the dirty-preimage guard more than it helps; record the
   decision here either way.

Decisions (2026-10-04):
- Items 1 and 2 are adopted. The recorded directories are the entry parents absent at `prepare`, stored in the
  manifest as `newDirectories` (omitted when empty, so every earlier manifest keeps its digest); apply creates them,
  and once every file is back at its preimage, rollback removes each one that is still empty, deepest first. A
  directory created between `prepare` and apply by someone else and left empty is removed by rollback; one with
  content is kept.
- **Scope change:** the same rule applies to placement without Git checks, because `target()` then treats a missing
  parent identically in both modes and only the nested-repository check differs. Home-run undo therefore now
  removes the directories its placement created when they are empty, where it used to leave them (README "Home
  runs" and `specification.md` §5.9 updated).
- Item 3: done; the result is §3's.
- **Item 4 is rejected.** It would not have helped §2: the hand-landed files were committed (`234153f`), so `HEAD`
  no longer equalled the base revision. With defect 1 fixed and defect 3 explained, hand-landing a candidate is no
  longer needed, and adopting a dirty preimage whenever its bytes match a candidate adds a path around the
  dirty-preimage guard for a case that should not recur.

Out of scope: deleting directories that a candidate empties; changing how candidates are staged inside the
sandbox.

## 5. Acceptance criteria

- [x] In repository mode, a candidate that adds `a/b/new.txt` where `a/` does not exist integrates, and the
  directories and file match the candidate. Proof: `test/runtime-integration.test.ts` "a candidate file in a new
  directory integrates with Git checks, and rollback removes the directories it created"; red on `16672c8` with
  `ENOENT … lstat '…/repo/a'`, green after.
- [x] Rolling that integration back removes `a/b/new.txt`, `a/b` and `a`, and leaves an unrelated pre-existing
  sibling directory untouched. Proof: the same case asserts the `find` tree (minus `.git`) equals the base with
  `keep/` present; "rollback keeps a created directory that gained other content" covers the non-empty case.
  Mutation: removing the `removeNewDirectories` call fails both cases.
- [x] A parent that exists but is a symlink, or contains a `.git`, is still refused, with a message naming the
  entry. Proof: "a symlinked or nested-repository parent is refused with a message naming the entry" (both
  messages asserted); "ownership, symlink and internal Git paths fail during preparation" and the home-workspace
  nested-repository refusal keep passing.
- [x] Integrating after the operator pre-created the empty parent directories succeeds, and rollback leaves those
  operator-created directories in place. Proof: "rollback keeps parent directories the operator created before
  preparation", which passed on `16672c8` as well; result and session evidence in §3.
- [x] Item 4 is either implemented, with a case showing a hand-applied candidate adopted as `applied`, a changed
  file refused, and a different `HEAD` refused; or rejected, with the reason recorded in §4. Rejected; reason in
  §4 Decisions.
- [ ] One live integration of a candidate that creates a directory, in a repository workspace, reaches `applied`.
  Proof: the run and operation ids, and the journal row's state. Not run: it spends provider credit and needs
  explicit authorization. Offline substitute, not a replacement: the real `ats-adapters-us006` manifest and blobs,
  replayed through `RuntimeIntegration` against a scratch clone at `6e01f68` with no directory pre-created, reach
  `applied` in one step.
- [x] `specification.md` (integration), `extensions/pi-agent-wave/README.md` and `AGENTS.md` describe new-directory
  integration and its rollback. Proof: spec §5.9 bullets and `advance` paragraph, README "Decisions" and "Home
  runs", AGENTS.md "Result contracts".
- [x] Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` and
  `git diff --check` green, with counts from the run made. 2026-10-04 on `16672c8` plus this change: 653 tests,
  642 passed, 0 failed, 11 skipped; `git diff --check` clean; `npm run typecheck` exit 0. Bun package checks not
  run: `bun` is not installed on this host.

## 6. Operator workaround until this lands

For a candidate that creates a directory: read the staging manifest from
`~/.local/share/delegate-graph/runtime-content/<manifest sha256>`. Confirm `HEAD` equals its `baseRevision` and the
tree is clean. Apply each `after` blob from `runtime-content/<sha256>`, checking its hash and size, then re-hash the
written files. Verify and commit in the target repository, and cancel the operation with the reason. Before
dispatching, prefer slices whose new files sit in directories that already exist, when the story allows it.
