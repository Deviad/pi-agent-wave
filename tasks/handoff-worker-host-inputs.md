# Handoff: prepare the resources workers need for unattended runs

Status: implemented; AC1–AC9 verified; attempt 1. Work order for this increment in `specification.md` and
`product.md`. Local commit and merge into `main` authorized by the user. Push, publication, production
migration and paid live runs remain unauthorized.

## 1. Summary

A run's task text can name files on the operator's machine with `~/…` or an absolute path. Inside the worker's
sandbox `~` is a private temporary HOME, so a `~/…` path never resolves, and the worker falls back to searching
for the file. Before this increment, nothing in the task contract let an operator declare a host file for a
worker, and nothing refused a task that named one.

**Usability is the driver.** The goal is to let agents run unattended with the resources their authorized task
needs, not to make the operator rewrite prompts or troubleshoot sandbox paths. Prepare dependencies before
launch, give every operation and retry the same inputs, and return actionable diagnostics to the supervising
agent. Ask the operator only when a required resource is unavailable, ambiguous, or needs new authorization.
This increment removes the resource-delivery failure in §2; it does not promise error-free execution generally.

This work order adds:

1. **Declared inputs.** `op=init` accepts `inputs: { name, path }[]`. Files are validated and snapshotted at init,
   then materialized with read-only permissions beside the run evidence at each dispatch. Worker instructions
   name the private copy, not its host source. The source bytes are frozen; permissions on a worker copy are an
   accidental-write deterrent, not a security boundary.
2. **Shared task-path lint and preparation.** Both `op=init` and `/delegate` use the same preparation path.
   Unprepared host references never launch a worker. `/delegate` hands preparation to the supervising agent,
   which declares required files, selects already-authorized host services, and removes path-only provenance
   or prohibitions without removing their meaning. It then initializes the prepared run without another
   policy picker or operator prompt. Direct tool callers receive the same machine-actionable diagnostics.
3. **Stable workspace and provenance.** Record the initialization workspace for later dispatches, preserve
   existing operational-command working directories, and keep source-path provenance in operator-only views.

The path lint prevents known misaddressed resource references, not arbitrary filesystem access. Every worker
also receives positive instructions for finding its provided resources and reporting a missing dependency.

## 2. Evidence for the defect (2026-10-04, `run_01ca8e05-7f13-4dc8-a2d6-9f98ee1705c2`)

- The run's only operation, `op_78c606fd…` (`thinker_plan`, `alibaba/deepseek-v4.1-flash`), started at
  14:50:26Z. Its session stream had no event after 14:52:25Z; at 15:07Z the worker processes were alive at 0 %
  CPU.
- The worker's last tool call (from `worker.stdout.ndjson`, call `call_3d140249f8114642b4805495`) was
  `ls -la ~/.pi/agent/backups/ats-originals-20261003/scripts/apply-uk-batch.mjs …; find / -name "apply-uk-batch.mjs" 2>/dev/null | head`.
  The `ls` printed `…/acpx-home/.pi/agent/backups/…/apply-uk-batch.mjs: No such file or directory`, because the
  sandbox HOME is the attempt's `acpx-home`. The `find /` (pid 97729) was still running after 15:34 minutes;
  `lsof` showed its working directory inside `~/Library/CloudStorage/OneDrive-Personal/…`.
- The file exists on the host (`-r-------- 4434 bytes`). A real `agentfs run --no-default-allows --allow <dir>`
  with a temporary HOME, the launcher's own shape (`delegate_core.py`, `launcher_text`), reproduced both
  halves: `wc -c ~/.pi/…/apply-uk-batch.mjs` failed with `No such file or directory`, and `wc -c` on the absolute
  path printed `4434`, exit 0. The host is readable through the overlay; only `~` is remapped.
- The same task also names `~/Library/Caches/ms-playwright/chromium_headless_shell-1161/chrome-mac/headless_shell`
  as the browser to start, which fails inside the sandbox for the same reason, and `~/.job-hunter` in a
  prohibition. Three `~/` tokens in one task, each a defect or noise.
- The only time limit is the worker's `timeoutSeconds: 3600` (`delegate_core.py`, `config`). `README.md` states
  that `last_activity_at` "is a launch grace, not a stall signal". A runaway tool call holds the operation for up
  to an hour.

The existing rule "Never put absolute host paths into a worker's task or instruction" (`AGENTS.md`, product
invariants; `product.md` hazard "Absolute host paths escape the sandbox", which says "A general confinement guard
is open") is prose. Nothing enforces it, and the operator had no sanctioned alternative for a file the worker
must read.

## 3. Rejected alternatives

- **Add the host file or its directory to `agentfs run --allow`.** `agentfs run --help` defines `--allow` as
  "Allow write access to additional directories". It would give the worker unaudited write access to the
  operator's files, and it is unnecessary for reading: the overlay already exposes the host read-only.
- **Tell operators to use the absolute host path.** It works for reading today, but it contradicts the written
  invariant above, puts operator paths into prompts and transcripts, and lets the worker read whatever it finds
  there at run time rather than a frozen snapshot. Reviewers and auditors of the same run could then see different
  bytes.
- **Drop the path from the task.** The worker needs the file's content to do the work.
- **Declare inputs per dispatch, like `hostServices`.** Required source bytes belong to the run, not an
  individual attempt. Repeating file declarations for every planner, implementer, reviewer and auditor would
  make omissions and differing snapshots possible. Validate at init and inherit inputs at every dispatch;
  operation-specific tasks need not equal the run task.

## 4. Approach

### 4.1 Shared preparation and unattended use

- One initialization preparation helper in `index.ts` serves both `op=init` and `/delegate`; neither entry point
  may call `graphStore.initRun` without it. Validate task paths, graph arguments and input declarations before
  retaining input content or inserting run rows. Validation errors create no run and consume no worker attempt.
  The existing tool error-result contract remains intact; an internal throw is returned as an error result.
- Direct `op=init` returns all detected path issues together with the resource-preparation remedies in §4.3.
  `/delegate` with such issues sends the original task, selected graph, selected model-policy input, canonical
  workspace and diagnostics to the supervising agent as a preparation request, instead of creating a run.
  The supervisor uses `op=init` with that same policy and workspace after preparing resources. A clean task
  continues through the shared helper immediately. Preparation never reopens the policy picker.
- The supervisor preserves the requested work: declare a needed file and replace its host reference with the
  input name; attach a registered, authorized host service for a required program; describe a provenance note
  or prohibition without its host path. An explicit file-to-read request authorizes that file's snapshot, not
  unrelated files or credentials. Ambiguous intent or an unavailable service is a named blocker, not guessed
  permission. Record chosen registry service names as resource requirements in the prepared task, without
  host executable paths or configuration. Supervision instructions require supplying those attachments on
  relevant dispatches, including retries, under the existing `hostServices` contract; no per-role defaults.
- Dependency preparation is not a worker/model retry loop. A failed read identifies the exact input and reason
  so the supervisor can correct the declaration before any worker launches. An unchanged preparation failure
  is reported once rather than repeatedly initializing or asking the operator to rephrase the task.

### 4.2 Declared inputs, workspace and provenance

- `op=init` gains optional `inputs: { name, path }[]` and `dispatchWorkspaceRoot` for the supervisor to preserve
  the canonical repository workspace from a preparation request. This directory parameter pins dispatch, not
  home-mode ownership; `workspaceRoot` retains its existing home-mode meaning. Limits: 32 inputs, at most 10 MiB per file and
  32 MiB total. Report which limit was exceeded and suggest a smaller required file set; do not truncate bytes.
  Names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and are unique within the run.
- Expand `~/`, `$HOME/` and `${HOME}/` against the host HOME in declarations, not the private worker HOME.
  Require an absolute path after expansion. Resolve parent directories canonically; refuse a final symlink,
  directory, non-regular file, unreadable file, duplicate canonical path or duplicate opened file identity.
- Open each source with no-follow and nonblocking semantics so a substituted FIFO cannot hang preparation;
  inspect that same descriptor with `fstat` and accept only a regular file. Check its size before allocation,
  read with an explicit byte bound and end-of-file check, and compare metadata after
  reading. Refuse observed replacement or mutation; close every descriptor on every path. Do not use a
  separate `lstat` followed by an unbounded path-based read. `RuntimeContentStore.read` is the existing bounded
  descriptor-based pattern. A snapshot promises the captured bytes, not atomic consistency against an
  uncooperative concurrent writer whose changes cannot be detected.
- Validate and capture the entire input set within the total bound before calling `RuntimeContentStore.retain`.
  Record `{ name, sha256, bytes, sourcePath }` on the run. After init, dispatch and retry use retained bytes
  only, even if the source changes or disappears. A commit failure after retention may leave unreferenced
  content; the retention disclosure in §8 applies to that content too.
- Proposed schema v14 adds `runs.inputs_json TEXT NOT NULL DEFAULT '[]'` and
  `runs.dispatch_workspace_root TEXT` additively through `ensureColumn`. New runs record the canonical init
  working directory; explicit home runs still use `workspace_root`, and operational commands still use their
  validated command `cwd`. Repository dispatch uses the recorded root rather than the resuming session's
  directory. Older runs default to no inputs and a null recorded root, preserving their existing cwd fallback.
  Initialization lint uses the same effective bases as dispatch; validate operational task names against their
  command working directories as well as the run task against its initialization base.
- Operator `status` and `/graph ledger` may expose `sourcePath`. Worker evidence uses a separate explicit
  ledger projection whose input metadata contains only names, digests and byte counts, never source paths or
  their provenance event fields; preserve the existing operation and decision evidence. `materializeRuntimeEvidence` must use this worker projection, not the operator ledger.
  Check the complete generated task, prompt and evidence files for leaks of synthetic source provenance;
  checking `taskSuffix` alone is insufficient. This does not redact paths inside user-provided file contents.
- At every dispatch, materialize each input from verified retained bytes into
  `<private run dir>/runtime-evidence/inputs/<name>`, mode `0400`, and list its name and private path in
  `taskSuffix`. Use the existing evidence-delivery path for all nodes and attempts. Task text refers to inputs
  by name, for example "the archived batch script (declared input `o07-batch`)".
- The private run directory remains the launcher's writable `--allow` entry. A same-user worker can change
  permissions or replace its copy: `0400` prevents ordinary accidental writes, not deliberate mutation.
  Copies are attempt-local and never become the source for later attempts. Do not claim immutable worker
  evidence or add a new sandbox mechanism in this slice.

### 4.3 Task-path lint

- `lib/task-host-paths.ts` separates pure token extraction from filesystem-aware containment. The shared init
  helper runs it before input retention. This is resource-addressing lint, not a general confinement guard.
- Detect `~/`, `$HOME/` and `${HOME}/` references and absolute paths outside the effective workspace, including
  `/tmp` and `/`. Exempt recognized slash commands in command position, such as `/graph watch`, not every
  one-segment slash token. URLs are not filesystem paths. Preserve quoted paths with spaces, handle backticks,
  assignments and sentence punctuation, and do not strip characters from a quoted filename.
- For workspace containment, reuse `realpathExistingPrefix` from `lib/agentfs-sandbox.ts` on the original path
  before parent traversal; lexical `resolve` alone misses symlink escapes. Relative task paths remain usable;
  an explicitly detected relative path traversing outside the workspace gets the same preparation remedy.
  Absolute paths within the effective workspace are accepted, but the supervisor should use workspace-relative
  references in prepared worker tasks. This lint does not make absolute sandbox writes safe.
- Diagnostics include the original token, reason and effective workspace, with the same stable prefix and a
  structured list of path issues alongside the human-readable error. Report all detected issues in one pass:

```
[dispatch_precondition] resource preparation required before launching workers: <token>, <token>.
Prepare each reference: a required file belongs in `inputs`, referenced by name; a required program uses
an authorized host service (`hostServices` at dispatch); a prohibition or provenance note keeps its meaning
without the host path. The supervising agent should prepare these resources and call op=init again using
the selected policy and workspace. Ask the operator only for missing resources, ambiguity or authorization.
```

### 4.4 Worker instruction

`prepare_acpx_attempt` (`scripts/delegate_core.py`, where `prompt` is assembled) appends one constant paragraph
to every prompt:

> Work from the working directory, the run evidence and the declared input paths listed above. Use attached
> host services through their supplied variables. Your home is private to this attempt; `~` is not the
> operator's home. If a required resource is missing, name it and the blocked work in your answer so the
> supervisor can prepare it; do not replace it with a filesystem-wide search.

This guides behavior, not filesystem confinement. Required resources are prepared before launch so normal
execution does not rely on the worker discovering host paths or asking the operator for help.

## 5. Affected components

| Path | Change |
| --- | --- |
| `extensions/pi-agent-wave/index.ts` | `inputs` parameter; shared initialization preparation; `/delegate` supervisor handoff; stable dispatch workspace; worker-only evidence projection and input materialization |
| `extensions/pi-agent-wave/store.ts` | schema v14 input references and dispatch workspace; `initRun` records both; separate operator and worker ledger projections |
| `extensions/pi-agent-wave/types.ts`, `extensions/pi-agent-wave/lib/runtime-results.ts`, `extensions/pi-agent-wave/commands.ts` | synchronize run and ledger types and operator provenance display |
| `extensions/pi-agent-wave/contract.ts` | supervision instructions for resource preparation and task-declared service attachments |
| `extensions/pi-agent-wave/lib/task-host-paths.ts` (new) | token extraction and containment using the existing-prefix resolver |
| `extensions/pi-agent-wave/lib/run-inputs.ts` (new) | bounded descriptor-based source capture and typed retained-input parsing |
| `extensions/pi-agent-wave/scripts/delegate_core.py` | the resource-use/missing-dependency paragraph |
| `extensions/pi-agent-wave/test/` | cases in §6 |
| `specification.md`, `product.md`, `AGENTS.md`, `extensions/pi-agent-wave/README.md`, `README.md`, `CHANGELOG.md` | document `inputs`, the precondition, and replace "A general confinement guard is open" with what is now enforced and what still is not (see §7) |

## 6. Acceptance criteria

Each criterion names its proof. Test paths below are relative to `extensions/pi-agent-wave/`. Check a criterion
only when its artifact exists and passes on this tree; an opt-in skip is a stated blocker, not a pass.

- [x] **AC1 — bounded validation precedes run creation and retention.** `test/run-inputs.test.ts`, case
      "invalid inputs create no run or retained input content": cover missing, unreadable, non-regular,
      directory, final symlink, oversized, duplicate name/path/opened identity and invalid name inputs; input
      count and aggregate byte limits; and an invalid later input after a valid one. Each result identifies
      the input and reason. The tool-initialization case in AC5 additionally runs the invalid declarations
      through the registered handler: run count and retained-content inventory stay unchanged. Case "source reads use
      a bounded no-follow descriptor" exercises replacement, growth and observed mutation paths with explicit
      process time/output bounds, using real temporary files for the successful read.
- [x] **AC2 — frozen bytes and private provenance.** Same file, case "input copies use init bytes and redact
      source provenance": rewrite and then remove the source after init; materialization still matches its
      recorded digest and mode `0400`. Operator status and ledger retain the source path. This case checks
      materialized evidence; AC7's dispatch case checks the complete worker task and assembled prompt. They
      contain neither the synthetic source path nor its unique directory.
      That same case proves a fresh attempt restores retained bytes after an earlier copy was modified,
      without claiming worker-copy immutability; keep the related snapshot assertions in one focused test.
- [x] **AC3 — real AgentFS readability.** Same file, case "agentfs reads the materialized input": real
      `agentfs run --session … --no-default-allows --allow <private run dir>`, temporary HOME and the launcher's
      argv shape; `cat` prints the retained bytes. This proves sandbox readability, not model/adapter behavior.
      Skip with a stated reason only where AgentFS cannot run; leave this criterion unchecked there.
- [x] **AC4 — addressing lint is useful and bounded.** `test/task-host-paths.test.ts` covers the three home
      forms, `/tmp`, `/`, external absolute paths, existing-prefix symlink escapes and parent traversal,
      including a quoted filename with spaces and punctuation. Registered command-position `/graph watch`,
      URLs, ordinary relative workspace paths and contained absolute paths are accepted. Containment uses
      the same canonical base as the corresponding dispatch.
- [x] **AC5 — both initialization entry points prepare resources.** `test/run-inputs.test.ts`, cases "tool
      initialization prepares resources without a second picker" and "slash initialization hands resource
      preparation to the supervisor": the synthetic incident task returns all diagnostics through
      `op=init` with no run; `/delegate` sends the preparation request with the same task, graph, policy and
      workspace, creates no run and does not ask the operator to rewrite it. The tool-initialization case
      then prepares the request using real declared files and an existing test service registry,
      verifies preserved task intent and one run with the selected policy, and checks that supervision
      instructions preserve relevant service attachments for subsequent dispatches. The test proves the
      preparation protocol, not that a real model will always interpret arbitrary resource intent correctly.
- [x] **AC6 — mutation pair.** Remove the shared initialization lint: AC5 fails for the tool and slash paths;
      restore it: both pass. Record both runs in the gate log.
- [x] **AC7 — actual dispatch and prompt delivery.** `test/run-inputs.test.ts`, case "dispatch delivers inputs
      to every graph node and replacement attempt": use the registered dispatch handler and real
      `prepare_acpx_attempt` prompt assembly, with provider execution faked only at the unavailable/paid
      boundary. Cover build, research and operations node sets, a retry, a source deleted after init and a
      resumed session in a different cwd. Verify private paths, init digests, redaction and the §4.4 instruction
      in generated prompts; workspace and operational-command cwd selection remain correct. Case "legacy
      runs still dispatch in the session workspace" proves a null recorded root still selects the resuming
      session's cwd. No paid call.
- [x] **AC8 — migration.** Seeded v13 opens as v14 with old inputs defaulting to `[]` and the new dispatch root
      defaulting to null; all pre-existing column values and dependent rows are unchanged. Seeded older-version
      tests still pass. Fresh runs persist both input references and their canonical dispatch workspace.
- [x] **AC9 — gate and documentation.** Run the Node completion glob, `git diff --check`, package typecheck and
      Bun package checks listed in `AGENTS.md`; cite the log under `agent-output/`. Documentation states the
      preparation workflow, permission limitation, operator/worker provenance split and non-reclamation of
      inputs after cancellation or prune. Record unavailable checks explicitly, not as completed criteria.

No paid run is required by these criteria. AC3 proves real sandbox access; AC7 separately proves dispatch and
prompt wiring without substituting fixtures for reachable Git, SQLite or AgentFS. A paid adapter run would
add model/adapter compatibility evidence and needs separate operator authorization. The package's standard
live launcher/worker proof remains authorization-gated; do not claim that proof from `cat` or a fake provider.

## 7. Non-goals, and what each leaves open

- **A stall or per-tool-call time limit.** §2 shows a single runaway command can hold an operation for up to the
  3600 s worker timeout, and the store has no stall signal. That is a separate defect with its own design space
  (observing `tool_call` updates in `acpx-worker.ts`, cancelling the turn through `acpx-cancel.ts`, classifying
  the result). Write it as its own handoff; this change only removes the cause seen here.
- **Worker-produced text and general path parsing.** Accepted answers, file contents and review findings can
  contain host paths. Initialization lint covers detected references in caller-authored task text, not arbitrary
  shell programs, obfuscated references or instructions inside inputs. It is not confinement or an authorization
  mechanism. Input contents are task data, not authority to access further resources.
- **Absolute-path writes from inside the sandbox.** The `AGENTS.md` hazard about absolute host paths, `/tmp`
  and `/var/folders` is unchanged. Workspace containment in the lint does not make such writes audited.
- **Directories as inputs, inputs added after init, service provisioning and content garbage collection.**
  This slice delivers declared files and already-registered services. A newly discovered dependency after init
  is a named blocker for the supervisor; it is not an excuse for broad filesystem search or silent omission.
  Dynamic dependency delivery needs a separate plan. Fully unattended completion remains an end goal, not a
  claim that this increment handles every dependency, stall or provider failure.

## 8. Risks

- Path lint can flag a legitimate provenance note. The supervisor preserves its meaning while preparing the
  task; routine rewording should not become operator work. Tests pin practical forms rather than claiming a
  complete natural-language path grammar. A preparation request is not a guarantee of correct model judgment.
- Inputs can contain personal data. `runtime-content/` is private but shared and content-addressed; cancellation
  and `/graph prune` do not delete its bytes, including unreferenced blobs from a failed init after retention.
  This increment adds no garbage collection. State this explicitly in operator documentation; do not promise
  run-scoped deletion or delete a shared digest when one run is removed. Source provenance remains visible
  only in operator views; file contents themselves are delivered to the selected worker/provider.
- Input-copy permissions deter accidental writes only. Attempt copies can be modified inside the writable
  run directory; retained bytes, verified materialization and fresh copies preserve the cross-attempt source.
  Resource preparation reduces avoidable failures, while missing services, ambiguous intent and unknown
  dependencies remain honest blockers instead of promises of error-free unattended execution.

## 9. Implementation progress

- Plan recorded in `specification.md` and `product.md` before code changes. Restore point: tracked files at
  `7ab87b0dd69bf0f8032b105c7bcfbae155c76b7c`; the untracked handoff was separately copied and verified.
- Implementation and the automated acceptance proofs are complete. Bun is not globally installed; its
  package gate ran using real Bun 1.4.2 from the official npm package in a temporary isolated npm cache.
  That temporary installation and cache were removed after the successful checks; logs remain.
- Preparation needs to carry a repository workspace back through `op=init`, not only home mode. The plan now
  explicitly names `dispatchWorkspaceRoot` for that handoff and a package-private source-capture helper.
- Initial focused proof passes in `agent-output/worker-host-inputs/focused.log`, including real AgentFS reads.
  The first full gate (`node-gate-first.log`) found existing dispatch fixtures initializing without their
  workspace context, plus Pi's existing pathname limit under the sandbox tool's extra temporary-directory
  prefix. Those fixtures now initialize in their real test workspace. The gate runs with `TMPDIR=/tmp`,
  avoiding the extra sandbox-tool directory component without weakening pathname or ownership checks.
  Refusals and their tests now name replacement initialization for a wrong pinned workspace.
- Fresh final gate on 2026-10-04: `node-gate.log` records 700 tests, 689 passed, 0 failed and 11 opt-in skips;
  `typecheck.log`, `pack.log` (89 entries), `publish-dry-run.log` and `diff-check.log` record successful checks.
  `install-rehearsal.log` records the separate Node-only installation proof; the final Node glob also reruns
  that proof. `bun-version.log` and `bun-package.log` record Bun 1.4.2 and 50 passed, 0 failed across the eight
  mandated package test files. All logs are under `agent-output/worker-host-inputs/`.
- AC1–AC5 and AC7–AC8: the named cases pass in `node-gate.log`, including real temporary Git and SQLite,
  full registered-dispatch prompt assembly, an old-run cwd fallback and real AgentFS readability. Provider
  execution alone is faked in the dispatch fixture; no paid adapter compatibility or model behavior is claimed.
- AC6: `shared-lint-reverted.log` records both initialization cases failing when the shared guard is removed.
  The guard was restored byte-for-byte from its verified snapshot, and both cases pass in `node-gate.log`.
  `mutation-pair.log` keeps the paired failing/passing excerpts together.
- Verification source: the `worker-host-inputs` worktree before commit, based on
  `7ab87b0dd69bf0f8032b105c7bcfbae155c76b7c`. At verification, no production store migration, incident
  recovery, commit, push, publication or paid model run had been performed. Input retention and sandbox
  limitations remain as documented.
- The user subsequently authorized a local commit and merge into `main`; this does not authorize a push,
  production migration, publication or paid model run.

## 10. Recovering the incident run (operator action, not part of this change)

The run status and pid in §2 may be stale; verify this before any recovery. This plan authorizes no process
termination or incident-run mutation. For an authorized recovery after this feature is implemented, prefer a
prepared replacement run with the archived script declared as an input and the browser attached as an
appropriate host service. Killing a search alone would not repair the missing-resource references.
