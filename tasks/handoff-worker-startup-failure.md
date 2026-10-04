# Handoff: a worker that dies before its prompt is noticed late, and classified as permanent

**Recorded:** 2026-10-04
**Reported by:** the operator, from the live output of `run_d0caa7e3-0f60-4704-81b2-5b1373c31830`
(story `ats-adapters-us002`, build graph, Herdr transport, thinker `op_bd40d8dc…`, model
`alibaba/deepseek-v4.1-flash`).
**Affects:** every attempt whose ACPX session cannot be opened. The wait part affects the Herdr
transport only; headless already watches the worker's pid.
**Not a PRD.** This file is a work order. Read it with `specification.md` (§1.3, §5.2, §5.5, §4.1) and
`tasks/handoff-unattended-run-reliability.md` (§4 liveness, §8a worker-gone).

**Status:** opened and implemented 2026-10-04 on the uncommitted tree over `b189cd1`; every criterion below is checked with its evidence. Not committed: the operator has not asked.

## 1. Summary

A worker that fails to open its ACPX session dies in seconds, but the run learns of it only after up to
an hour, and then parks for the operator instead of retrying.

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | `acpx-worker.ts` throws on a failed `sessions ensure` without writing a worker result | Nothing on disk says the attempt is over; `collect` has to wait |
| 2 | The Herdr wait never checks whether the worker process is alive | The wait runs to `WAIT_TIMEOUT_MS` (default 3600 s) while Herdr keeps reporting the pane's agent as `working` |
| 3 | `ACPX session ensure failed … Cannot call write after a stream was destroyed` classifies `permanent / unclassified` | Even once recorded, `retry` parks the run in `awaiting_user` instead of spending the transient budget |

## 2. Evidence (2026-10-04, 10:12–10:19 CEST)

- Live output in the worker's pane (`w2:pG`): `ACPX session ensure failed after 2 attempt(s):
  {"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error: Cannot call write after a
  stream was destroyed","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}`, thrown
  at `scripts/acpx-worker.ts:198` after the one built-in retry (`ensureAcpxSession`, `:152-161`, which
  retries this exact text once after 100 ms; `specification.md` §1.3 documents it as a known
  intermittent).
- The attempt directory, now durable under the graph home, holds no `worker-result.json` and no
  `runtime-output/`. The two `npm exec pi-acp@^0.0.31` logs in its ACPX home are 2.4 s apart and both
  end `verbose exit 0`, so `pi-acp` was installed and started both times.
- No process carried the attempt's AgentFS session (`dg-thinker-0-0-80cb32853c85`) and no mount
  remained, yet `herdr agent get w2:pG` answered `agent_status: "working"` at 10:18:39, six minutes
  after the death: the pane's shell was alive at its prompt.
- `op=status` reported the operation `orphaned (worker-process-gone)` (`lib/liveness.ts`), so the
  store-side reaper saw what the wait did not.
- `scripts/delegate_core.py:wait_for_settled_agent` (`:1156`) on Herdr leaves its loop only when the
  result file appears, the attempt directory disappears, or `herdr_agent_registered(pane)` is false;
  otherwise it runs to `WAIT_TIMEOUT_MS` (`:45`). Read from the code, not exercised to the hour.
- `retry.ts:classifyFailure` on the full message returns `{"kind":"permanent","reason":"unclassified"}`
  (run 2026-10-04).
- Not reproduced: 15 reproductions of the same `acpx … pi sessions ensure` inside `agentfs run` with the
  worker's recorded environment, from copies of its run directory, all returned `session_ensured`:
  2 with the run directory under `$HOME`, 2 under `/tmp`, 2 with the `PATH` cleaned of an embedded
  `npm bin` error message, 3 with an empty npm cache, 3 with a TTY on stdin, 3 with both. `pi --mode rpc
  --no-themes` alone stays up in the same conditions. The trigger is intermittent and unidentified; this
  work order makes the system converge on it, it does not claim to remove it.
- Unblocked by hand: the dead worker's tab `w2:tG` was closed at the operator's request, after checking it
  was not the operator's own tab, that its label named this operation, and that no worker process or
  mount remained; `herdr agent get w2:pG` then answered `agent_not_found`.

## 3. Chosen design (2026-10-04, recorded before implementation)

1. **Classification.** `retry.ts:TRANSIENT_PATTERNS` gains `worker-startup-failure`, matching
   `ACPX session ensure failed` and `Cannot call write after a stream was destroyed`. It is an
   infrastructure fault of the session layer, the same class as `worker-runtime-failure`, and it spends
   the existing budget: three same-model attempts, then the frozen chain.
2. **A failed start still writes its result.** When `ensureAcpxSession` fails, `runAcpxWorker` writes the
   schema-2 runtime-v1 worker result it writes after a prompt, with an outcome of
   `{"kind":"failed","exitCode":null,"error":<the ensure message>}`, an empty capture and an empty answer,
   through the same temporary-file-and-rename path, and then exits non-zero. Settlement already turns a
   failed outcome with no answer into a failed attempt with no candidate, so `collect` settles at once and
   `retry` applies item 1. The ensure stderr is also kept as `worker.stderr.txt` in the output directory.
3. **The Herdr wait watches the process.** While no result exists, `wait_for_settled_agent` on Herdr also
   asks whether any process carries the attempt's AgentFS session name or attempt directory — the markers
   `lib/liveness.ts:workerLiveness` uses — after the same 60 s launch grace, at the existing liveness
   interval. A positively empty answer raises `Herdr worker process gone before result: <agent>`; an
   unreadable process table is not evidence and keeps the wait going. The message matches
   `worker-gone` (§8a of the unattended work order) by adding `process gone before result` to that pattern.

Out of scope: finding the intermittent's root cause (needs a reproduction), changing ACPX or `pi-acp`, and
headless (its wait already raises `headless worker exited before result` from the pid).

## 4. Acceptance criteria

- [x] Both messages classify `transient / worker-startup-failure`, and `Herdr worker process gone before
  result` classifies `transient / worker-gone`. Proof: `test/retry.test.ts`, red before.
  Evidence: `test/retry.test.ts` "a worker whose ACPX session could not be opened is transient" (the full
  live message, a bare ensure message and a bare stream message) and the added line in "a worker gone
  before its result…"; both failed before the `retry.ts` patterns (23 pass, 2 fail) and pass after (25 of 25).
- [x] A worker whose ensure fails writes a parseable schema-2 result with a `failed` outcome carrying the
  message, and settlement of it yields a failed attempt with no candidate. Proof: a test driving
  `runAcpxWorker` with an ACPX shim that fails `sessions ensure` (as `test/runtime-probe-gate.test.ts`
  does), then `settleRuntimeWorker` on its output; red before.
  Evidence: `test/worker-startup-failure.test.ts`, an ACPX shim printing the live JSON-RPC error and
  exiting 1: before the change `runAcpxWorker` threw the message and wrote nothing; after, it returns
  non-zero, `worker-result.json` is schema 2 with outcome `failed` and the message, `worker.stderr.txt`
  holds the ACPX output, `settleRuntimeWorker` yields outcome `failed` with no candidate, and the error
  classifies transient. `test/runtime-probe-gate.test.ts` (missing `acpx`: throws, no result) still passes.
- [x] On Herdr, a wait whose worker process is gone, with the pane still registered, ends with the new
  message within one liveness interval after the grace instead of at `WAIT_TIMEOUT_MS`; an unreadable
  process table keeps it waiting. Proof: a test with a Herdr shim that keeps reporting the agent and a
  stubbed process table, red before; the bound asserted in seconds.
  Evidence: `test/herdr-worker-liveness.test.ts` "fails within seconds when the worker process is gone
  although its pane still reports the agent" (pane answers `working`, process table without the session:
  ends with `Herdr worker process gone before result: worker` in under 3 s; before the change it ran into
  the 10 s probe timeout) and "a live worker process, or an unreadable process table, keeps the wait
  going" (both cases wait for the result; before, the process table was never consulted). The 60 s grace
  is set to 0 in these two tests; the seven existing cases pass unchanged.
- [x] `specification.md` §1.3 and §4.1, `product.md`, `extensions/pi-agent-wave/README.md` and `AGENTS.md`
  list the new transient reason and the process check.
  Evidence: spec §1.3 (failed ensure writes a result), §1.6 (the process-table probe on the Herdr wait),
  §4.1 (`worker-startup-failure`, `process gone before result`); `product.md` transient list;
  package README worker-recovery paragraph and transient list; `AGENTS.md` transient list.
- [x] Gate: full Node suite, `npm run typecheck`, `git diff --check` green, counts from the run made.
  Evidence (2026-10-04, uncommitted tree on `b189cd1`): `node --experimental-strip-types --test
  extensions/pi-agent-wave/test/*.test.ts` exit 0, 643 tests, 632 pass, 0 fail, 11 skipped (opt-in);
  `npm run typecheck` exit 0; `git diff --check` clean; logs in
  `agent-output/worker-startup-failure-20261004/`. Bun package checks not run (Bun is not installed on
  this host). No live worker was run: the fix is proven against shims and the real wait loop, not
  against a reproduction of the intermittent, which 15 attempts did not trigger.
