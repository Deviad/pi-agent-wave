# Handoff: a worker that cannot open its ACPX session leaves nothing to diagnose, and the failure is now deterministic

**Recorded:** 2026-10-04
**Reported by:** the operator, from `run_53c62590-5cef-4a89-a6b5-686e803c1614` (story `ats-adapters-us006`,
build graph, Herdr transport, thinker `op_c0e72b75-1a86-4c4d-b049-be0ecbe7b308`, model
`alibaba/deepseek-v4.1-flash`), dispatched from a supervisor session in `~/projects/job-hunter-public`.
**Affects:** every attempt on this host since at least 2026-10-04 10:12 CEST, on the Herdr transport (headless
not tried). No worker has started since then.
**Follows:** `tasks/handoff-worker-startup-failure.md` (implemented in `6e52885`). That work order made a failed
start settle fast and retry as `transient / worker-startup-failure`; that part works (see §2). It left the root
cause open because the fault looked intermittent and 15 reproductions did not trigger it. This work order is
about the two things that still stop anyone finding that cause.
**Not a PRD.** This file is a work order. Read it with `specification.md` (§1.3, §1.6, §4.1) and the work order
it follows.

**Status:** opened 2026-10-04. The design is recorded in §4a and was implemented the same day on the uncommitted tree over `6e52885`. All seven criteria are checked with evidence. **Root cause identified** (§4 item 4): `pi` cannot create its session directory once the AgentFS working directory reaches 253 characters, and run directories under the graph home cross that length. The fix is chosen (shorter run-directory names, plus a dispatch guard) and implemented; its evidence is in §4 item 4. Committed on branch `worker-session-ensure-diagnostics` and merged into `main` at the operator's request, 2026-10-04.

## 1. Summary

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | The failure bundle reads `stderrTail` from `<attempt>/worker.stderr.txt`, but a failed start writes its stderr to `<attempt>/runtime-output/worker.stderr.txt` | Every startup-failure bundle has an empty `stderrTail` |
| 2 | Settlement then deletes the attempt directory and the attempt's ACPX home | The `runtime-output/` stderr and the `pi-acp` npm logs, the only evidence of why `pi-acp` died, are gone before anyone can read them |
| 3 | A deterministic startup failure still spends the whole transient budget, and would then fall through the model chain | Each attempt costs a Herdr tab, about 6 s of launch and a 40-60 s back-off. A model fallback cannot help, because `sessions ensure` fails before any model is called |

Defect 3 is a judgement call; defects 1 and 2 are plain bugs. Fixing 1 and 2 first is what makes the root cause findable.

## 2. Evidence (2026-10-04)

All five recorded attempts since 10:12 CEST failed the same way; none started a worker.

| Run | Attempt | Dispatched (UTC) | Run directory | Outcome |
| --- | --- | --- | --- | --- |
| `run_d0caa7e3…` | thinker `0:0` | 08:12:20 | graph home | ensure failed (per the previous work order §2) |
| `run_53c62590…` | thinker `0:0` | 10:38:23 | graph home | ensure failed after 6.4 s |
| `run_53c62590…` | thinker `0:1` | 10:38:44 | graph home | ensure failed after 5.3 s |
| `run_53c62590…` | thinker `0:2` | 10:53:55 | graph home | ensure failed after 6.1 s |
| `run_53c62590…` | thinker `0:3` | 10:58:31 | graph home | ensure failed after 6.4 s, after this checkout was on `main` at `6e52885`, clean tree |

The error was the same each time: `ACPX session ensure failed after 2 attempt(s): {"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error: Cannot call write after a stream was destroyed","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}`.

For contrast, `run_fc6b6c33…` on 2026-10-03, with its run directory under `/private/tmp`, started both of its workers, and each ran for about ten minutes. The startup failures begin after `b189cd1` moved run directories into the graph home. That is a correlation, not an established cause: see §3.

What `6e52885` fixed, observed working:
- Each attempt settled within seconds with outcome `{"kind":"failed","exitCode":1,"error":…}`.
- `classifier_reason` was `worker-startup-failure`.
- `op=retry` scheduled transient attempts 1, 2 and 3 with back-offs of 4 s, 57 s and 41 s.

What was missing, observed:
- `evidence/run_53c62590…/failure-op_c0e72b75….json` has `stderrTail: ""`, `recentEvents: []`, `selectedModel: null` and `reason: "attempt aborted before cleanup"`.
- All four `runtime-capture-*.ndjson` files are 0 bytes.
- `cleanup-dg-run-53c6-thinker-c63b7c5b.json` reports `attemptDirectoryAbsent: true` and `acpxSessionFilesAbsent: true`.
- No `worker.stderr.txt`, `worker-result.json` or `_logs/*.log` dated today exists anywhere under `~/.local/share/delegate-graph`.
- `~/.local/share/delegate-graph/runs/` is empty.

Code, read on `6e52885`:
- **Where a failed start writes its stderr.** `scripts/acpx-worker.ts:202-207`: on a failed ensure, the stderr goes to `join(dirname(config.resultPath), "runtime-output")`, that is `<attempt>/runtime-output/worker.stderr.txt`.
- **Where the failure bundle reads it.** `scripts/delegate_core.py:1603` builds `stderrTail` from `attempt_dir / "worker.stderr.txt"`, the `stderrPath` of the worker config (`:785`). `acpx-worker.ts` writes that file only on the close/status path (`:194`), never on the ensure-failure path.
- **What gets deleted.** `delegate_core.py:1650` (abort) and `:1917-1918` (settle) delete the attempt directory and the ACPX home. The previous work order found two `npm exec pi-acp@^0.0.31` logs there that ended `verbose exit 0`, the only trace of the `pi-acp` child.
- **The retry.** `acpx-worker.ts:153-161` retries the ensure once on this exact text, hence "after 2 attempt(s)".
- **The budget.** `store.ts:1650` allows three transient attempts, and `:1668` then moves to the next model in the frozen chain.

Host probes, run from `~/projects/job-hunter-public` on 2026-10-04, outside Delegate Graph, with the real `HOME`. `acpx` is 0.13.2 and `pi` 0.87.1; `pi` reports v1.0.2 available.
- `acpx --cwd <empty tmp dir> --format text --max-turns 1 pi exec "Reply with exactly the word: ok"` exited 0, and the output ended `ok [done] end_turn`.
- `acpx --cwd <dir> --format json pi sessions ensure --name probe-len-<n>` exited 0 with `session_ensured`, both from a 12-character `/tmp` directory and from a 200-character directory under `~/.local/share/delegate-graph/`. Both sessions were closed afterwards and the directories removed.

The probes rule out the length of the working directory on the host, and they show ACPX, `pi` and `pi-acp` can open a named session. They do not run inside `agentfs run` and do not use the attempt's own `HOME` or ACPX home. The previous work order's 15 reproductions did both, from copies of a run directory, and also succeeded. So the live dispatch path differs from every reproduction tried so far, in some way not yet identified.

## 3. Hypotheses for the root cause (none tested)

Ordered by how cheaply the §4 diagnostics would confirm or rule each one out.

1. **The run directory's location.** Something specific to the graph-home path, inside `agentfs run`, breaks `pi-acp`'s stdio: an AgentFS overlay rule, or a socket or queue path under the attempt's ACPX home exceeding the 104-byte macOS limit. The earlier reproductions used copies of the run directory, possibly at a different path.
2. **The dispatching process's environment.** The live launch inherits the supervisor's Herdr pane environment (`HERDR_*`, `PI_DELEGATION_*`, `PATH` with an embedded `npm bin` message, as the previous work order noted) and the reproductions did not.
3. **State left by earlier attempts.** ACPX or `pi-acp` state outside the attempt directory, for example an `npm exec` cache entry or a session record, left behind by a killed worker.
4. **`pi-acp` exits while starting.** `pi-acp@^0.0.31` resolves to a newer build, or `pi` 0.87.1 started at the attempt's `HOME` exits early, for example on a missing or invalid configuration under the materialized home. ACPX then writes to a closed stdin, which is exactly this error.

## 4. Proposed design (to confirm before implementation)

1. **Read the right stderr.** In the failure bundle, take `stderrTail` from `<attempt>/runtime-output/worker.stderr.txt` when the config `stderrPath` is missing or empty. Better, keep both under separate keys.
2. **Keep startup-failure evidence past cleanup.** When an attempt ends with `worker-startup-failure`, copy these into `evidence/<run>/startup-failure-<operation>-<transient>-<model>/` before settlement deletes the attempt directory and the ACPX home:
   - `runtime-output/worker.stderr.txt`;
   - the `worker-config.json` (it holds no credentials; check before copying);
   - the ACPX home's `_logs/*.log` and any session or queue records;
   - the launch environment, with values reduced to names for everything outside an allowlist (`PATH`, `HOME`, `TMPDIR`, `NODE_*`, `npm_config_*`, `ACPX_*`, `PI_*` names only);
   - `agentfs`, `acpx`, `pi`, `node` and resolved `pi-acp` versions.

   Never copy `auth.json` or the materialized credential file (product invariant). Put the evidence path into the failure bundle.
3. **Stop on a repeated identical startup failure.** When two consecutive attempts of the same operation fail with `worker-startup-failure` and identical redacted messages, park the operation for the operator instead of spending the rest of the transient budget and the model chain. The parked record names the evidence directories from item 2. A startup failure happens before any model is called, so a model fallback cannot change the result.
4. **Root-cause fix:** to be recorded here once item 2 has captured a live failure and §3 has been narrowed. Not before.

   **Root cause (2026-10-04, from the criterion 4 capture and no-cost probes).** Hypotheses 1 and 4 are both confirmed, as one mechanism. Hypotheses 2 and 3 are ruled out: the failure reproduces with neither a Herdr environment nor earlier state. `pi` 0.87.1 keeps each working directory's sessions in `<PI_CODING_AGENT_DIR>/sessions/--<cwd with "/" replaced by "-">--`. That is a single path component of length `len(cwd) + 3`, so it exceeds the 255-byte filename limit once the working directory reaches 253 characters. `pi` then exits on `ENAMETOOLONG` at `mkdir`. `npm exec pi-acp` still exits 0 (both captured npm logs end `verbose exit 0`), so ACPX writes into a closed pipe: `Cannot call write after a stream was destroyed`. A worker's working directory is the AgentFS mount `<attempt>/agentfs-home/.agentfs/run/<session>/mnt`, which `b189cd1` moved from `/tmp` into the graph home:
   - Captured working directory of the live attempt: 287 characters (`environment.json`, `cwdLength`).
   - The same layout under `~/.local/share/delegate-graph/runs` is 257 characters, so the session directory name would be 260 bytes and every attempt fails. That is the job-hunter run in §2.
   - Under `/private/tmp`, before `b189cd1`, it is 215 characters (a 218-byte name), which is why `run_fc6b6c33` on 2026-10-03 started.
   - The limit depends on the user's home path length, which is why other hosts and the earlier copied-directory reproductions may not have hit it.

   Probes, run with `agentfs run` and `acpx pi sessions ensure`, plus the production `provider_runtime_environment` (no prompt, no provider call):
   - Working directories of 243, 249 and 251 characters opened a session.
   - 253, 254, 258, 272, 286 and 302 failed with the live error.
   - `pi --mode rpc` alone, outside AgentFS and ACPX, in a 264-character directory exited 1 with `Error: ENAMETOOLONG: name too long, mkdir '…/providers/pi-agent/sessions/--private-tmp-…'`.

   **Proposed fix, not chosen.** Shorten the mount path, and guard the limit at dispatch:
   (a) Give the AgentFS home a short fixed spelling under the graph home, for example `<graph home>/m/<12-hex>/`, instead of nesting it under `runs/delegate-graph-herdr-<run uuid>-<op uuid>.<rand>/acpx/<agent>/`. This removes about 150 characters.
   (b) Add a `[dispatch_precondition]` refusal when the computed mount path plus 3 exceeds 255, naming the length and the remedy, so a long home can never again burn attempts silently.
   (a) alone is the minimal mechanical fix; (b) is the guard. Both need the operator's choice before implementation.

   **Chosen (2026-10-04, operator: both, (a) first), recorded before implementation.** One finding changed (a)'s spelling, though not its intent. `store.ts:prune` finds a run's transient directories as three levels above `cancel-acpx.sh`, and `collect` reclaims an attempt by removing its run directory. An AgentFS home outside the run directory would therefore escape both whenever a `collect` throws. (a) instead shortens the run directory's own name and leaves the layout alone:
   - **(a)** `delegate_core.py:command_init` names the directory from `run_dir_slug(run_label)`. That is the slugified label with every UUID reduced to its first 8 hex characters, capped at 40 characters, so `run_<uuid>-op_<uuid>` becomes `run-d34d01f4-op-ed00d5ce` instead of 77 characters. `run_label` itself is still stored whole in `state.json`, where the run-id fallback and the Herdr tab title read it. This saves 56 characters: the measured layout under `~/.local/share/delegate-graph/runs` goes from a 257-character working directory to about 201. Proof: a test that `init` with a live-shaped label yields a directory name of at most 55 characters, still accepted by `require_run_dir`; red before.
   - **(b)** `prepare_acpx_attempt` computes the worker's working directory, `<agentfs home resolved>/.agentfs/run/<session>/mnt`, before it materializes any credential. For a `pi` worker whose `len + 3 > 255`, it raises `[dispatch_precondition]` naming the length, the limit and the remedy (a shorter `DELEGATE_GRAPH_DB` location). `index.ts` treats a `start` failure carrying that marker like a credential-preflight block: the launch error goes through `retryRuntimeAttempt`, where it classifies permanent `dispatch-precondition` and parks the run. The run directory is discarded, and the result is `blocked: "precondition"`. Codex and Claude are not guarded: their limits were not measured. Proof: a Python-level test that a run directory deep enough to overflow refuses before any credential file exists, and that a normal one does not; and a store-level classification check. Red before.
   - **Not in scope:** `/tmp` run directories from earlier versions keep their names; `require_run_dir` still accepts them.

   **Implemented (2026-10-04, uncommitted tree on `6e52885`).**
   - **(a)** `delegate_core.py:run_dir_slug`, used by `command_init`. Proof: `test/durable-run-root.test.ts` "a run directory's name reduces the run and operation UUIDs to 8 characters…". The name `delegate-graph-herdr-run-d34d01f4-op-ed00d5ce.<random>` is at most 55 characters, `require_run_dir` accepts it, and `state.json` keeps the full label. Red before: the name was the 110-character full-UUID form.
   - **(b)** `delegate_core.py:worker_cwd_precondition`, called in `prepare_acpx_attempt` before `provider_runtime_environment`, and the `[dispatch_precondition]` branch for `start` failures in `index.ts`. Proof, two tests, both red before (each reached the credential preflight first, `worker preflight: … no usable credential`):
     - `test/durable-run-root.test.ts` "a pi worker whose AgentFS working directory would overflow…": a deep run directory refuses with the named length, and no `providers/` directory or `auth.json` exists. A short `pi` path and a deep Codex path are not refused.
     - `test/dispatch-owned-path-precondition.test.ts` "a graph home deep enough to overflow…": through `op=dispatch` the result is `blocked: "precondition"`, classifier `dispatch-precondition`, the run `awaiting_user`, the launcher invoked, the run directory discarded, and no agent or attempt row.

     `privateRunDirsFor` in that file matched run directories by the full run UUID. It would have passed vacuously after (a), so it now matches `run-<first 8>`.
   - **Proof on this host, ensure-only and without a provider call.** The setup was `agentfs run` with the production `provider_runtime_environment`, a graph home of the same 49-character length as `~/.local/share/delegate-graph`, and the live session name `dg-thinker-0-0-d46d4476e79d`:
     - The new name gives a 201-character working directory; the guard passes and `session_ensured`.
     - The old name gives a 257-character working directory; the guard computes 257 and refuses, and the unguarded ensure fails with the live `Cannot call write after a stream was destroyed`.

     The probe directories, which held materialized `auth.json` copies, were removed, and no mount or process remained.
   - **Docs:** spec §5.1, the package README run-directory row, `product.md` §run files and the storage bullet, and `AGENTS.md` runtime storage.
   - **Gate:** Node suite exit 0, 649 tests, 638 pass, 0 fail, 11 skipped; `npm run typecheck` exit 0; `git diff --check` clean. Logs are `agent-output/worker-session-ensure-diagnostics-20261004/node-suite-fix.log` and `typecheck-fix.log`.
   - **Not done:** no live research run was repeated after the fix, because it would start cleanly and so spend provider credit, which needs its own authorization. The operator's `run_53c62590…` is untouched; it can be resumed now that its worker's working directory would be 201 characters.

Out of scope: changing ACPX or `pi-acp` themselves; the headless transport's behaviour, except that criterion 5 compares against it.

### 4a. Chosen design (2026-10-04, recorded before implementation)

A finding made while choosing: `<attempt>/worker.stderr.txt` is written by no mode at all. A prompt or a failed
ensure writes its stderr through `RuntimeOutputFiles` into `<attempt>/runtime-output/worker.stderr.txt`, and a
close run writes `<attempt>/worker-close.stderr.txt` (`run_acpx_again` renames its paths). So every bundle's
`stderrTail` has been empty, not only a startup failure's. A second finding: the bundle reads
`resource["selected_model"]`, a key no resource has (the frozen model is `resource["model"]`), which is why
`selectedModel` was `null`; that one-word fix is in scope because the bundle is this work order's subject.

1. **Stderr.** `stderrTail` reads the worker's own stderr nearest first, as `worker_stream_source` reads its
   stream: `runtime-output/worker.stderr.txt`, then `<attempt>/worker.stderr.txt`. A separate `closeStderrTail`
   carries `worker-close.stderr.txt`, the close run's stderr, which a startup failure also produces.
2. **Evidence directory.** `write_failure_diagnostics`, which both the candidate-less settle and the abort call
   before anything is deleted, also retains startup evidence when the attempt's `worker-result.json` holds a
   `failed` outcome whose error starts `ACPX session ensure failed`. It writes
   `<graph home>/evidence/<runId>/startup-failure-<operationId>-<transient>-<model>/` directly (the store's own
   evidence home, so `finalizeRunDirectory` need not copy a directory, and `prune` reclaims it with the run),
   where each name component has every character outside `[A-Za-z0-9_-]` replaced by `-`. Contents, each a
   private file, text redacted with `redact_failure_text` and capped at 256 KiB (tail):
   - `worker.stderr.txt` from `runtime-output/`;
   - `environment.json`, written by `acpx-worker.ts` into `runtime-output/` on a failed ensure: the working
     directory and ACPX home it ran with (and their lengths, for hypothesis 1), and the environment it gave
     ACPX, with values kept only for `PATH`, `HOME`, `TMPDIR`, `NODE_*`, `npm_config_*` and `ACPX_*` and only
     when the name does not look like a secret (`TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `AUTH`, `CREDENTIAL`);
     every other name, `PI_*` and `HERDR_*` included, is listed without its value;
   - `worker-config.json` (paths and flags only; it names the Claude token file's path, never its content);
   - `_logs/` from the ACPX home's `.npm/_logs/*.log`, and `acpx-state/` from its `.acpx/` tree (session and
     queue records, which carry `last_agent_exit_code` and `last_agent_disconnect_reason`);
   - `versions.json`: `agentfs`, `acpx` (the configured executable), `pi` and `node` `--version`, each bounded
     to 10 s, and every `pi-acp` version resolved under the ACPX home's `.npm/_npx/`.
   Only those sources are read; a file named `auth.json`, `.credentials.json`, `setup-token` or `.claude.json`
   is skipped even inside them. A second call for the same attempt adds files not yet retained and rewrites
   none, so the abort after a failed close cannot replace the prompt-time `worker-config.json`. The bundle
   names the directory as `startupFailureEvidence`.
3. **Stop on a repeated failure.** In `retryRuntimeAttempt`, before the transient branch: when the current
   failure classifies `worker-startup-failure`, the operation's `classifier_reason` (set by the previous
   automatic retry or fallback, cleared by an operator retry) is also `worker-startup-failure`, and the two
   messages are identical after redaction (lines naming retained diagnostics dropped, absolute paths and ACPX
   session names masked), the operation parks exactly as an exhausted budget does: `failed`, run
   `awaiting_user`, no supersede. The event is `startup_failure_repeated` with the evidence directories in its
   payload, and `last_error` appends `retained startup evidence: <dir>; <dir>`, naming the directories of the
   current and the previous attempt that exist (the store derives them from the attempts' frozen identities
   with the same naming rule as item 2). An operator retry resumes as today.

## 5. Acceptance criteria

- [x] The failure bundle of a startup failure carries the ensure stderr. Proof: extend `test/worker-startup-failure.test.ts`. Its ACPX shim prints the live JSON-RPC error and exits 1; assert that the bundle's stderr field contains that message. Red before: the field is `""` today.
  Evidence: `test/worker-startup-failure.test.ts` "a failed start's bundle carries the ensure stderr, and its evidence survives settlement and cleanup", driven by `test/support/startup-failure-driver.py` (the real `prepare_acpx_attempt`, `acpx-worker.ts`, headless supervisor, `settle_runtime_attempt` and absence audit; ACPX is a shim and AgentFS is not used). It asserts that `stderrTail` matches `Cannot call write after a stream was destroyed` and that `selectedModel` is the frozen model. Red before: run against the `6e52885` versions of `delegate_core.py` and `acpx-worker.ts`, it failed with `actual: ''`; both files were then restored byte-for-byte (`cmp`).
- [x] A startup failure's evidence survives settlement. After settling and cleaning the shim attempt from criterion 1, the evidence directory exists, holds `worker.stderr.txt`, the ACPX `_logs` and the redacted environment, and contains neither `auth.json` nor the materialized credential file. Proof: a test asserting those files, and asserting that `cleanup-*.json` still reports `attemptDirectoryAbsent: true`. Red before.
  Evidence: the same test. The directory equals `store.ts:startupFailureEvidenceDirectory(...)` (which pins the Python and TypeScript naming rules to each other), has mode `0o700`, and holds `worker.stderr.txt`, `environment.json`, `worker-config.json`, `versions.json`, `_logs/<npm log>` and `acpx-state/sessions/index.json`. It holds no file named `auth.json`, `.credentials.json`, `setup-token` or `.claude.json`, and neither the materialized Codex credential's value nor a `PI_*_TOKEN` environment value; the environment keeps that name with a null value. The cleanup evidence reports `attemptDirectoryAbsent: true` and `acpxSessionFilesAbsent: true`. It was red before as part of the same failing run (that run stopped at the first assertion). Finding: a fixture in `test/support/acpx-cleanup-driver.py` set the nonexistent `selected_model` key, so it had locked in the bundle bug. It now sets `model`, the key `command_start` writes.
- [x] Two consecutive identical startup failures park the operation for the operator, naming both evidence directories. A startup failure followed by a different error still retries as today. Proof: a test in `test/retry.test.ts` or the store tests, driving the `store.ts:1650` path. Red before.
  Evidence: `test/runtime-results.test.ts` "two consecutive identical startup failures park the operation…" covers several cases. The second identical failure (differing only in a retained-diagnostics path) gives `exhausted: true`, the operation `failed` at transient 1 and model attempt 0, and the run `awaiting_user`. `last_error` ends `retained startup evidence: <dir0>; <dir1>`, and a `startup_failure_repeated` event lists both directories. An operator retry resumes, and the next startup failure retries again. A second test, "a startup failure followed by a different error, or by a different startup failure, still retries", covers `HTTP 503` and a different ensure message: both retry to transient 2 with no park event. Red before: with the new branch disabled, the first test failed (`actual: false`). The second test passes either way, because it guards against over-parking.
- [x] With criteria 1 and 2 in place, one live attempt on this host captures a startup failure, or starts cleanly. Proof: the evidence directory's contents, quoted in this work order, and the hypothesis in §3 they confirm or rule out, recorded under §4 item 4. If the attempt starts cleanly, record that instead and leave item 4 open.
  Evidence: authorized live run at 13:17 CEST, `runtime-measure.ts --graph research --execute --repeats 1 --transport herdr --model alibaba/deepseek-v4.1-flash`. Its run root was under `~/.local/share` (not `/tmp`), so the paths match the graph home. The run is `run_1b8243e1-87cf-4bb8-ae8d-401445dab92e`. It ended `awaiting_user` after 21992 ms with 2 dispatches and 1 retry: the park from criterion 3 fired live, and `last_error` and the `startup_failure_repeated` event name both directories. No model was called. Contents of `startup-failure-op_b027bde3-…-0-alibaba-deepseek-v4-1-flash/`:
  - `worker.stderr.txt` holds the live JSON-RPC error.
  - `versions.json`: `acpx 0.13.2`, `agentfs v0.6.4`, `node v24.21.0`, `pi 0.87.1`, `piAcp ["0.0.31"]`.
  - `environment.json`: `cwdLength 287`, `acpxHomeLength 239`.
  - Two `_logs/*.log`, 2.3 s apart, each `npm exec pi-acp@^0.0.31` ending `verbose exit 0`.
  - `acpx-state/sessions/index.json` with no entries.

  These confirmed hypothesis 4 (`pi-acp` exits while starting). The length then pointed at hypothesis 1, confirmed by the probes in §4 item 4. The evidence is copied to `agent-output/worker-session-ensure-diagnostics-20261004/live-herdr/`.
- [x] One headless dispatch of the same operation, on the same host and at the same time as criterion 4, records whether the failure follows the Herdr transport. Proof: the operation's outcome and evidence path.
  Evidence: the same command with `--transport headless` at 13:18 CEST. It produced `run_d34d01f4-a5f7-48d3-945c-8e2548e80a35`, which ended `awaiting_user` after 34945 ms with 2 dispatches, 1 retry and the operation `failed / worker-startup-failure` at transient 1. `worker.stderr.txt` is identical, and `cwdLength` is again 287. Its evidence is under `startup-failure-op_ed00d5ce-…-{0,1}-alibaba-deepseek-v4-1-flash/`, copied to `agent-output/worker-session-ensure-diagnostics-20261004/live-headless/`. The failure does not follow the Herdr transport. Deviation: the request was for the same operation, but this used the measurement driver's fresh run rather than resuming the operator's `run_53c62590…`, so that run is untouched. Both run roots, and the probe directories holding materialized `auth.json` copies, were removed after their evidence was copied. No mount, process or Herdr tab remained.
- [x] `specification.md` §1.3 and §4.1, `extensions/pi-agent-wave/README.md` and `AGENTS.md` describe the evidence directory and the stop on a repeated failure.
  Evidence: spec §1.3 (the environment record and the evidence directory), §4.1 (the pointer to the park), §4.2 (the park rule, its event and `last_error`); package README worker-recovery paragraph and the storage table row; `AGENTS.md` transient-failure bullet; `product.md` transient list and storage bullet.
- [x] Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` and `git diff --check` green, with counts from the run made.
  Evidence (2026-10-04, uncommitted tree on `6e52885`): Node suite exit 0, 646 tests, 635 pass, 0 fail, 11 skipped (opt-in); `npm run typecheck` exit 0; `git diff --check` clean. Logs are in `agent-output/worker-session-ensure-diagnostics-20261004/`. Bun package checks were not run (Bun is not installed on this host).

## 6. Operator workaround until this lands

Supervisors implement directly instead of dispatching. The open run `run_53c62590…` is left `active` with its thinker operation pending, so it can be resumed once criterion 4 shows a clean start.
