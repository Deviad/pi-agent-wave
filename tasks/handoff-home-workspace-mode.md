# Handoff: home workspace mode — unattended writes in `$HOME`, reviewable and revertible

**Recorded:** 2026-10-04
**Requested by:** the operator, who runs agents unattended and sometimes needs them to write
configuration files under `$HOME`; usability is the priority over confinement.
**Affects:** runs that opt in at `op=init`. Every other run is unchanged.
**Not a PRD.** This file is a work order. Read it with `specification.md` (§5.1–§5.5, §5.9) and
`product.md`.

**Status:** implemented 2026-10-04 on the uncommitted tree over `c096e4a` (with Issue 7 / Issue 3); every criterion below is checked with its evidence. Not committed: the operator has not asked.

## 1. Problem

A worker cannot write a configuration file under `$HOME` today. Its working directory is the session's
directory (`index.ts` dispatch, `ctx.cwd`); writes outside it are refused by AgentFS (verified
2026-10-03: an absolute write under `$HOME` from a workspace elsewhere is refused). The two ways
around it were rejected:

- `--allow $HOME` writes straight to the host: nothing is reviewable or revertible, read-only nodes
  can write too, and nothing attributes a change to a worker. A pruned scan of `$HOME` for changes in
  a two-hour window took 55 s and found 149 files mixed with the operator's own activity, so post-hoc
  detection is not a safety net; no local snapshot exists to roll back to.
- Declaring every path a task may write (owned paths) is exactly the friction the operator wants
  gone: an undeclared write refuses the whole candidate.

The package already has most of the mechanism that makes writes reviewable and revertible: the
integration journal retains each file's preimage and applies a candidate, and it works without Git
(`gitChecks:false`, used today only by operational candidates).

**Correction, recorded during implementation (2026-10-04).** An earlier statement in the conversation
that produced this work order said a placed change could be undone "the next day with one verb". That
was wrong. The journal rolls back only a `prepared` or `applying` integration (crash recovery and
abandonment): from `applied`, `RuntimeIntegration.rollback` throws `integration is applied`
(`advance`), and the existing tests exercise rollback only from `prepared` or `applying`
(`test/runtime-integration.test.ts`, `test/runtime-candidate-integration.test.ts`). The store also
refuses a rollback whose candidate is no longer the graph's current one (`stale integration
candidate`) or whose run has ended. Undo after placement is therefore new work, item 8 below.

## 2. Chosen design (2026-10-04, recorded before implementation)

A run may declare at `op=init` a **workspace root** that is `$HOME` or a directory under it. Such a run
is a *home run*; every operation of it uses that root as its working directory.

1. **Store.** Schema v13 adds `runs.workspace_root TEXT` (NULL for every existing and every normal
   run), additively, with the same seeded-migration test discipline as earlier versions.
   `GraphStore.initRun` takes an optional workspace root; it must be an existing real directory equal
   to or under the real `$HOME`, and the graph must be `build` or `research` (an operations command
   carries its own `cwd`). `RunRow` gains `workspace_root: string | null`.
2. **Tool.** `delegate_graph op=init` accepts `workspaceRoot` (absolute or `~`-prefixed). `/graph
   status` names the root of a home run.
3. **Dispatch.** For a home run: the working directory is `workspace_root` regardless of the session's
   directory; the Git precondition for `implement` is skipped; the owned-path precondition is skipped;
   the launcher receives `--owned-paths-json ["."]` and `--workspace-mode home`. A slice's declared
   owned paths stay validated (disjointness) as a statement of intent but do not limit what it may
   write.
4. **Launcher.** `--workspace-mode repository|home` (default `repository`) is recorded on the
   resource. In home mode a coding settlement does not require a Git base revision (`none`), the settle
   configuration carries `ownWholeBase: true`, and the worker prompt says that the working directory
   is the operator's home (or the declared root), that files must be addressed relative to it because
   `~` and `$HOME` point to a private directory, that every change is placed after review and can be
   rolled back, and that it must not commit inside repositories under it.
5. **Settlement and staging.** With `ownWholeBase`, staging owns every changed path, except that it
   drops (a) any path with a `.git` segment, because the journal refuses them and a worker's own
   commit must not sink its file changes, (b) any path under the graph home, so a worker can never
   place over the live store or another attempt's evidence, and (c) platform sidecars (`._*`,
   `.DS_Store`). (c) was found during implementation: the NFS mount writes an AppleDouble `._<name>`
   beside every file a worker writes, and with whole-base ownership the audit counts them as owned,
   so without this they would be placed into the home (observed in the staging test before the fix). The staging manifest's
   `ownedPaths` lists the staged paths themselves, since the whole base cannot be expressed as a
   relative path.
6. **Integration without Git checks.** `gitChecks` is false for a coding candidate of a home run.
   Placement without Git checks creates missing parent directories when it writes a file and treats a
   file under a missing parent as absent, and it no longer refuses a path under a nested repository.
   Both refusals exist for Git's index and submodule semantics, which placement does not use. This
   also applies to operational candidates, which already integrate without Git checks. Rollback
   removes a created file and leaves any directory it created in place.
7. **Unattended flow.** Unchanged verbs: `collect` → `decide accepted` → `integrate` places the
   change.
8. **Undo of an applied placement.** `RuntimeIntegration.undo(id)` reverses an `applied` integration
   whose manifest has no Git checks, using the same per-file step as recovery: each file must still
   equal either the placed image or the preimage, otherwise the undo stops in `needs_reconciliation`
   and overwrites nothing. It is refused while another integration of the same workspace is active.
   `op=integrate decision=rejected` on an attempt whose placement is applied takes this path through
   `GraphStore.undoRuntimeIntegration`, which verifies the retained content, is not bound to the
   graph's current node or to the run being active (it is the operator's decision, and the point is
   to undo after the run moved on), changes no graph state, and records an `integration_undone`
   event. Integrations with Git checks keep today's behaviour: Git is their undo.

Out of scope, stated so they are not mistaken for omissions: symlinked or hard-linked targets (the
journal still refuses them, e.g. stow-managed dotfiles), files over 16 MiB, home mode for the
operations graph and for `/delegate`, read confinement (parked by the operator), and automatic
integration (the supervisor still calls `decide` and `integrate`).

## 3. Acceptance criteria

- [x] **Store v13.** A v12 store with a run reopens at v13 with `workspace_root` present and every
  existing row byte-identical; `initRun` persists a valid root, refuses a root outside `$HOME`, a
  missing directory, and the operations graph. Proof: focused tests in `test/home-workspace.test.ts`,
  red before the change.
  Evidence: `test/home-workspace.test.ts` "a v12 store reopens at v13…" and "initRun records a root
  inside HOME and refuses anything else"; both failed before with `no such column: "workspace_root"`
  and pass after. `test/store.test.ts` "migrates a v1 database…" now pins `CURRENT_SCHEMA_VERSION`
  instead of the literal 12 (the rule in `AGENTS.md`) and asserts `workspace_root` is null.
- [x] **Placement creates parents and accepts nested repositories.** With `gitChecks:false`, preparing
  and applying a change to `a/new/dir/file.txt` creates the directories and the file, rollback removes
  the file, and a change under a directory containing `.git` integrates; with `gitChecks:true` both
  refusals are unchanged. Proof: focused tests, red before the change.
  Evidence: "creates missing parent directories…" failed before with `ENOENT … lstat '…/.config'`, and
  "places a file inside a nested repository…" with `submodule or nested repository path is
  unsupported`; both pass after. "with Git checks both refusals stand" passed before and after.
- [x] **Staging owns the whole base, minus `.git`, the graph home and platform sidecars.** Against a
  real AgentFS session whose worker writes a top-level file, an existing file, a file in a new
  directory, a file under `repo/.git/` and a file under the graph home: the first three are staged and
  listed as owned, the rest and every `._*` sidecar are dropped, and no violation is raised. Proof: a test over a real AgentFS delta; if the host refuses AgentFS, record
  the blocker rather than faking the delta.
  Evidence: "owns every changed path except .git internals and the graph home…", real `agentfs` mounted
  session; failed before with `owned path covers the whole base directory`, then on the AppleDouble
  sidecars (`._top.txt`, `._.config`, …) until they were excluded, and passes after with staged paths
  exactly `.config/newapp/config.toml`, `existing.txt`, `top.txt`.
- [x] **Launcher.** `prepare_acpx_attempt` with `--workspace-mode home` records the mode, writes the
  home instruction into the prompt, and builds a settle configuration with `ownWholeBase: true` and
  base revision `none` without raising; repository mode is unchanged. Proof: the Python fixture in
  `test/agentfs-sandbox.test.ts` style.
  Evidence: "home mode records the mode, instructs the worker, and settles with whole-base ownership
  and no Git base" and "repository mode is unchanged…"; both failed before (`unrecognized arguments:
  --workspace-mode`, no `runtime_settle_config`) and pass after.
- [x] **Dispatch.** For a home run started from a session in another directory, dispatch of an
  `implement` operation is not refused for missing Git, launches from `workspace_root`, and passes
  `--workspace-mode home` and `--owned-paths-json ["."]`. Proof: a tool-level test capturing the
  launcher arguments.
  Evidence: "launches from the workspace root, skips the Git precondition, and passes home mode with
  whole-base ownership" (dead route: stops at the worker preflight, no model spent). It failed before
  on `op=init` ignoring `workspaceRoot`; each dispatch assertion was then checked by mutation —
  launching from `ctx.cwd`, re-enabling the Git precondition, and passing the declared owned paths
  each fail the test, and restoring the code passes it.
- [x] **Undo after placement.** An applied placement is undone by `undo`, restoring every preimage and
  removing created files; a file edited after placement stops the undo in `needs_reconciliation`
  with the edit intact; an applied integration with Git checks still refuses. Proof: focused tests,
  red before the change.
  Evidence: the two placement tests call `undo` after `apply` (and assert `rollback` still refuses an
  applied integration), "undo of a placement whose file was edited afterwards…" and "undo is refused
  while another integration…", plus the Git-checks refusal in "with Git checks both refusals stand".
  Not run red before `undo` existed; instead a mutation that removes the `applied → applying`
  transition in `undo` fails three of them, and restoring it passes all 5.
- [x] **End to end.** A coding candidate settled from a real AgentFS session in a temporary
  "home" workspace integrates with `gitChecks:false`, places the files (including a new directory)
  on the host, and after the run has moved on `integrate decision=rejected` restores the preimages
  and records `integration_undone`. Proof: a test through `runtime-settle` and the store.
  Evidence: "settle with whole-base ownership, integrate without Git checks, end the run, then undo",
  real `agentfs` session over a temporary HOME, through `settleRuntimeWorker` and the store: the
  status line ends `workspace=home:<root>`, the placement writes the edited file and the new
  `.config/newapp/config.toml` with no `._*` sidecar, the run is cancelled, and `integrate` rejected
  restores `existing.txt`, removes the new file and records `integration_undone`. Before the store
  change it failed exactly there with `runtime integration unavailable: cancelled`.
- [x] **Docs.** `specification.md` (§2 v13, §5.1, §5.5, §5.9), `extensions/pi-agent-wave/README.md` and
  `AGENTS.md` describe home mode and its limits.
  Evidence: `specification.md` §2 (v13), §2.12a, §5.1a, §5.5 (whole-base staging), §5.9 (placement
  without Git checks, undo); `extensions/pi-agent-wave/README.md` `init`/`integrate` rows and
  "Home runs"; `product.md` graph selection and `integrate`; `AGENTS.md` storage paragraph and the
  absolute-path hazard note.
- [x] **Gate.** Full Node suite, `npm run typecheck`, `git diff --check` green; counts reported from the
  run made. Bun package checks are reported as not run while Bun is absent from the host.
  Evidence (2026-10-04 06:5x CEST, uncommitted tree on `c096e4a`): `node --experimental-strip-types
  --test extensions/pi-agent-wave/test/*.test.ts` exit 0, 631 tests, 620 pass, 0 fail, 11 skipped
  (opt-in); `npm run typecheck` exit 0; `git diff --check` clean; the live graph database's sha256
  unchanged across the run. Logs: `agent-output/home-workspace-mode-20261004/gate-node-suite.log`, `gate-typecheck.log`,
  `home-workspace-tests.log` (12 of 12). Bun package checks not run: Bun is not installed on this
  host. No live worker with a real model has run in a home workspace yet; that needs an authorized
  measurement.
