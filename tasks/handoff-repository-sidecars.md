# Handoff: macOS AppleDouble files inside an owned path are integrated into the repository

**Recorded:** 2026-10-04
**Found by:** the live criterion of `tasks/handoff-integration-new-directories.md` (`run_7b0cea2f-6c09-4e54-bc3a-42d3441c5857`,
implement `op_5a9bc175-7e61-4c59-bb6e-120b66d67da6`; evidence `agent-output/live-integration-new-directories-20261004/`).
**Affects:** repository-mode coding and operational candidates on macOS. Home runs already drop sidecars.
**Not a PRD.** This file is a work order. Read it with `specification.md` §5.3–§5.4.

**Status:** opened 2026-10-04. Decision the same day (operator): option 1, implemented the same day; every criterion
is checked below.

## 1. Observation

The worker was asked to create one file, `docs/notes/new-dir/hello.md`. The candidate's integration manifest held
three entries, and all three were placed:

| Entry | Bytes |
| --- | --- |
| `docs/notes/._new-dir` | 4096 |
| `docs/notes/new-dir/._hello.md` | 4096 |
| `docs/notes/new-dir/hello.md` | 27 |

The two `._*` files start with the AppleDouble header (`00 05 16 07`, "Mac OS X"). The placed files carry the
`com.apple.provenance` extended attribute. Inferred, not verified: AgentFS's macOS overlay stores extended attributes
as AppleDouble files, and these record the provenance attribute macOS sets on files the worker's process creates.
The earlier real candidate `ats-adapters-us006` (10 entries) held none, so it does not happen on every write; when it
does is unknown.

## 2. Cause in the code

`lib/agentfs-sandbox.ts:auditAgentFsChanges` discards `platformMetadata` paths (`._*`, `.DS_Store`) only outside
ownership: inside an owned path they count as owned changes and are exported (comment at line 267: "discarded
rather than exported or refused, but only outside ownership"). `lib/runtime-staging.ts` drops them only when
`ownWholeBase` is set, which is home mode. So in repository mode a sidecar under an owned path reaches the
working tree as an untracked file, and a supervisor who commits with `git add -A` would commit it.

## 3. Options

1. **Drop sidecars in every mode.** Treat `platformMetadata` paths as never work, inside ownership too, as the
   function's own doc comment says ("never work, never placed"). A repository that deliberately tracks a file whose
   name starts with `._` could no longer receive it from a worker; no such case is known.
2. **Drop sidecars unless already tracked at the base revision.** Keeps the rare deliberate case, at the cost of a
   Git lookup per sidecar path in staging.
3. **Leave the behaviour and document it.** Supervisors clean sidecars before committing.

Recommendation: option 1, because it removes the most state for the least code and matches the function's stated
intent; option 2 only if a real tracked `._*` file turns up.

## 4. Acceptance criteria (for option 1; revise if another option is chosen)

- [x] A repository-mode candidate whose overlay holds `._x` and `.DS_Store` under an owned path stages neither, and
  its owned file is staged. Proof: `test/agentfs-sandbox.test.ts` "platform metadata is discarded inside and outside
  ownership, and only the owned work is exported" (real AgentFS; `out/.DS_Store` and `out/._standalone` ignored and
  absent after export, `out/result.txt` exported). Red on `6f25e89`. The whole-base case
  ("whole-base ownership is refused unless ownWholeBase is set") also went red there, and showed real AgentFS
  writing `._other.txt` and `._owned.txt` beside the worker's two files; it now asserts exactly the two files.
  The change is the order in `auditAgentFsChanges`: platform metadata is checked before ownership.
- [x] Home mode is unchanged. Proof: `test/home-workspace.test.ts` passes unchanged. Staging's own sidecar check
  became unreachable and was removed (`lib/runtime-staging.ts`), so the rule lives in the audit only.
- [x] The comment at `lib/agentfs-sandbox.ts:267`, `specification.md` §5.4 and the README "Sandbox and staging"
  describe the rule. Proof: the comment above the classification loop, spec §5.4 (audit and home staging
  paragraphs), README "Sandbox and staging" and "Home runs".
- [x] Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` and `git diff --check`
  green, with counts from the run made. 2026-10-04 on `6f25e89` plus this change: 678 tests, 667 passed, 0 failed,
  11 skipped; `git diff --check` clean; typecheck exit 0. Bun package checks not run: `bun` is not installed on
  this host. A live rerun of the new-directory integration was not made; the real-AgentFS cases above exercise the
  same audit.
