# A settlement that cannot reach its storage must say so, not report a bare ENOENT

**Status:** Planned (2026-09-16). Governs `extensions/pi-agent-wave/lib/runtime-content.ts`, `extensions/pi-agent-wave/lib/runtime-staging.ts`, `extensions/pi-agent-wave/scripts/runtime-settle.ts` and the two live drivers under `extensions/pi-agent-wave/test/support/`. Subordinate to `tasks/prd-runtime-owned-results.md`, which owns the `runtime-v1` contract. No graph topology, join, retry budget, evidence gate or model-policy change.

Attempts: 0.

## Field evidence

The first authorized live build run on 2026-09-16 (`runtime-measure.ts --graph build --execute`) reported this, and the run parked in `awaiting_user` after one retry:

```
attempt failed without a candidate: … runtime settlement failed: …
ENOENT: no such file or directory, lstat '/private/var/folders/bf/bg8nrdrx27z4cmyv4bm5z5_m0000gn/T/.ctx-mode-W28znN'
ACPX cancel/close error: command failed (1): ['cancel-acpx.sh']
```

The worker had **succeeded**: the retained failure record shows `outcome.kind: "exited"`, `exitCode: 0`, `captureStatus: "complete"`, `answerBytes: 2602`, `diagnostics: []`. A complete answer was thrown away and a provider turn was re-spent because settlement could not reach its own storage.

The message names a directory that belongs to neither the graph nor the worker. It is the agent sandbox's per-call `TMPDIR`. Directly verified on this host: a marker written under `$TMPDIR` in one sandboxed call was gone in the next, along with the directory itself, with a different `TMPDIR` in effect. The driver had been launched with `nohup` so it outlived the call that started it.

## Root cause, pinned by reproduction

The throwing call is `realpathSync(dirname(dbPath))` in `RuntimeContentStore`'s constructor (`lib/runtime-content.ts:11`). Three facts establish this and were each reproduced rather than reasoned:

1. **The syscall identifies the function.** `realpathSync` on a deleted path fails with `syscall: lstat`; `mkdtempSync` fails with `syscall: mkdtemp`. The field error says `lstat`, so it was not a `mkdtemp`. (An earlier diagnosis in this repository's history said "staging's `mkdtemp`"; that was wrong and is corrected here.)
2. **The named path identifies the call shape.** `realpathSync` reports the deleted *ancestor*, not its argument: `realpathSync('<gone>/sub/deep')` reports `path=<gone>`. The field error names the `.ctx-mode-…` root while the actual argument was a directory beneath it, which is the signature of `realpath`, not of a direct `lstat` on the argument.
3. **The failing node had no staging.** The failure was at `thinker_plan`, whose candidate kind is `research`; `stageRuntimeAgentFs` runs only for `coding` and `operational` (`scripts/runtime-settle.ts:103`). The only `realpathSync` on the settlement path for a research candidate is the content store's. Constructing `RuntimeContentStore` against a database whose parent was deleted reproduces the field error exactly: `ENOENT lstat path=/private/tmp/vanish-db-37qi8c`.

Why it was reachable: the measurement driver puts its corpus *and* its `graph.db` under `mkdtempSync(join(tmpdir(), "pi-wave-measure-…"))` (`test/support/runtime-measure.ts:171`), so `DELEGATE_GRAPH_DB` pointed inside the doomed `TMPDIR`.

**The inconsistency worth fixing.** The Python lifecycle refuses to trust `TMPDIR` at all: private run directories are pinned with `TMP_ROOT = Path("/tmp").resolve()` and validated on read (`scripts/delegate_core.py:31`, `:132`). The TypeScript side trusts it: `lib/runtime-staging.ts:60` puts the settlement scratch copy of the AgentFS snapshot in `tmpdir()`. One half of the same lifecycle hardened against this and the other did not.

## Scope decision, recorded before building

Revised 2026-09-16 after the user challenged the first draft, which scoped this as a harness problem. The first draft was wrong about the exposure.

**The database is not the product exposure; the staging scratch is.** A real run resolves `DELEGATE_GRAPH_DB` or `~/.cache/delegate-graph`, neither volatile, so the specific failure the driver hit (database under `tmpdir()`) is harness-only. But the settlement subprocess inherits the supervisor's environment (`delegate_core.py:1711`, `env={**os.environ, …}`), Node's `os.tmpdir()` returns `TMPDIR` verbatim when it is set and falls back to `/tmp` only when it is unset (verified on this host), and `lib/runtime-staging.ts:60` puts its scratch copy of the AgentFS snapshot in `tmpdir()` on every coding and operational settlement. So any launcher that hands Pi a `TMPDIR` with a shorter lifetime than a delegate run — a sandboxed tool wrapper, an IDE or Obsidian Shell Commands launch, a managed terminal tab, a CI runner — controls where that scratch lives. Delegate runs last minutes to hours (the build proof took 450 s); a per-call or per-turn reaper will hit it. The Python half of the same lifecycle already refuses to trust `TMPDIR` (`TMP_ROOT`, `delegate_core.py:31`); the TypeScript half did not. Story 3 is therefore finishing a decision the code already made, not optional hardening.

What could not be verified and is not claimed: `ps -E` returns no environment for the running `pi` processes on this host, so no live Pi session was observed carrying a volatile `TMPDIR`. The exposure rests on the code path plus Node's documented behaviour.

`scripts/init.mjs:216` also uses `tmpdir()`, for a routing-validation file that lives for seconds inside a synchronous `init`. Same pattern, negligible risk; fixed for consistency in story 3.

The prevention goal, in priority order:

- Product, hot path: settlement scratch must not depend on an inherited `TMPDIR` (story 3).
- Product, any storage failure: a settlement that cannot reach its storage must fail with a message naming what was unreachable, before it can strand a completed worker answer (stories 1 and 2).
- Harness: the live drivers must not place run state anywhere that can be reclaimed mid-run, and must refuse to start rather than spend an authorized provider turn on a root that will vanish (story 4). Refuse, not warn, was the user's choice on 2026-09-16.

## User story 1 — an unreachable content store names itself

As an operator reading a settlement failure, I want the error to say the content store's directory is unreachable and name it, so I do not have to identify a syscall to know what broke.

Acceptance criteria:

- [ ] `RuntimeContentStore`'s constructor raises a message naming the content-store root, its database path and the underlying cause when the database's parent directory cannot be resolved; the original error is preserved as `cause`. Proof: a case in `extensions/pi-agent-wave/test/runtime-results.test.ts` that deletes a temporary database's parent and asserts the message names the path and does not surface a bare `ENOENT … lstat`.
- [ ] The check does not weaken the existing privacy and type guarantees: the directory must still be a real private directory, and the existing content-store cases continue to pass unchanged. Proof: the existing `runtime-results.test.ts` and `runtime-settle.test.ts` suites stay green with no assertion edited.

## User story 2 — a settlement checks its storage before it can strand an answer

As the supervisor, I want settlement to verify it can reach its storage before it retains anything, so a completed worker answer is never discarded for a reason that was knowable up front.

Acceptance criteria:

- [ ] `settleRuntimeWorker` establishes the content store before it reads the worker result, so an unreachable store fails with the user story 1 message rather than after parsing. Proof: a case in `extensions/pi-agent-wave/test/runtime-settle.test.ts` asserting the storage message for a settle configuration whose `dbPath` parent has been removed, with a worker result present on disk.
- [ ] The failure remains a settlement failure and nothing is fabricated: no evidence file is published, and no candidate is invented. Proof: the same case asserts the evidence path does not exist afterwards.
- [ ] Ordering is not weakened elsewhere: content retention still precedes session close, provider verification and cleanup, as `tasks/prd-runtime-owned-results.md` requires. Proof: the existing lifecycle case `wait settles a runtime worker by retaining its answer before close` stays green unedited.

## User story 3 — staging scratch does not depend on an inherited TMPDIR

As a maintainer, I want the TypeScript staging scratch to use the same pinned root the Python lifecycle already uses, so the two halves of one lifecycle agree about whether `TMPDIR` is trustworthy.

Acceptance criteria:

- [ ] `stageRuntimeAgentFs` allocates its scratch directory under a root that does not depend on an inherited `TMPDIR`, matching `delegate_core.py`'s `TMP_ROOT` convention, and still removes it on every exit path including failure. Proof: a case in `extensions/pi-agent-wave/test/runtime-staging.test.ts` that runs staging with `TMPDIR` pointed at a deleted directory and asserts staging still succeeds against a real AgentFS snapshot, plus an assertion that no scratch directory survives.
- [ ] `scripts/init.mjs`'s routing-validation temporary uses the same pinned root. Proof: the existing `initial-config*.test.ts` suites stay green, and a grep gate in the same case as above asserts no shipped `.ts`/`.mjs` under `lib/` or `scripts/` calls `tmpdir()` any more.
- [ ] The change is confined to scratch allocation: manifests, digests and staged content are byte-identical to before for an unchanged input. Proof: the existing staging and `runtime-settle.test.ts` coding cases stay green with no assertion edited.

## User story 4 — the live drivers keep run state on stable storage

As the person authorizing a live run, I want the drivers to place their corpus, database and evidence where nothing else can reclaim them mid-run, so an authorized provider spend is not wasted by the harness.

Acceptance criteria:

- [ ] `test/support/runtime-measure.ts` and `test/support/runtime-result-probe.py` allocate their run roots under a stable base rather than an inherited `TMPDIR`, and each records the resolved root in its output so a later reader can tell where the run lived. Proof: a case asserting the resolved root is not under a caller-supplied volatile `TMPDIR` when one is set.
- [ ] Each driver refuses to start when its chosen root is not a writable directory that still exists, with a message naming it. Proof: a case that points the driver's base at a deleted directory and asserts the refusal, with no worker dispatched.

## Non-goals

- No relocation of the graph database, the content store or the integration journal, and no change to `DELEGATE_GRAPH_DB`, `DEFAULT_GRAPH_HOME` or their resolution order. A real dispatch's storage is not volatile, and this issue does not pretend otherwise.
- No retry-classification change. An unreachable content store is a precondition failure, not a transient provider failure, and must not silently consume the same-model budget. If a future observation shows it does, that is its own issue.
- No change to the `output-outside-prompt` capture anomaly or to the empty-candidate rules settled in `tasks/prd-empty-candidate-settlement.md`.
- No attempt to make the agent sandbox's `TMPDIR` durable. The sandbox behaves as designed; the product simply must not be silently dependent on it.

## Containment

Every test uses temporary Pi homes and temporary databases outside the repository. Nothing writes `~/.cache/delegate-graph/delegate-graph.db` or the real Pi installation. No worker is dispatched by the automated proofs, and no provider spend occurs without separate authorization.

## What was built

To be filled in during implementation.

## Verification

To be filled in during implementation: gate counts from the run actually made, a mutation check binding each new assertion, and `git diff --check`.
