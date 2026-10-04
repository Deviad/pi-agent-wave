# Handoff: a graph worker cannot start Chromium inside the AgentFS sandbox

**Recorded:** 2026-10-04
**Reported by:** the operator, from the live output of `run_4b30826b-b84f-4f11-ad0c-2354cd3643fc` (story
`ats-adapters-us006`, build graph, Herdr transport, implement operation `op_b7c4d0f8-29b7-4c04-bd82-e67170be7c0e`,
AgentFS session `dg-implementer-0-0-31b577394471`, model `alibaba/deepseek-v4.1-flash`), supervised from
`~/projects/job-hunter-public`.
**Affects:** every worker on macOS whose task needs a Chromium-family browser (CDP browser tests, page fixtures,
screenshots). Both transports, since both launch the worker through `agentfs run`. Workers without a browser are
unaffected.
**Not a PRD.** This file is a work order. Read it with `specification.md` (worker sandbox), `AGENTS.md` (the two
"Known open hazard" entries on `agentfs run`) and `tasks/handoff-durable-worker-record.md` §7 question 5.

**Status:** opened 2026-10-04, not implemented. §2 is verified on the host; §3 is the worker's report and is
partly unverified.

## 1. Summary

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | Inside `agentfs run` on macOS, `IORegisterForSystemPower` fails, and every Chromium build segfaults at startup in `IONotificationPortGetRunLoopSource` | A task that asks for browser tests cannot satisfy that criterion. The worker spends its budget diagnosing the host instead |
| 2 | Nothing tells the worker or the supervisor in advance | The failure looks like a broken browser install. In the reported run the worker read crash reports, tried five binaries and many flags, and finally built a private `DYLD_INSERT_LIBRARIES` shim |
| 3 | The worker reports that a background process does not outlive the tool call that started it | A browser, or any other server, has to be started, used and stopped inside one shell command |

## 2. Evidence (verified 2026-10-04, host macOS 26.7.1, `agentfs v0.6.4`)

The probe is a 6-line Python `ctypes` call of `IORegisterForSystemPower`. The browser is Playwright's
`chromium_headless_shell-1161/chrome-mac/headless_shell` (HeadlessChrome 134), run with
`--user-data-dir=<scratch> --no-first-run --dump-dom about:blank`.

| Where | `IORegisterForSystemPower` | `headless_shell --dump-dom` |
| --- | --- | --- |
| Host shell | valid root (`7171`), valid port | exit 0, prints `<html><head></head><body></body></html>` |
| `agentfs run --no-default-allows --allow <scratch>` (the worker's flags, `lib/agentfs-sandbox.ts:85`) | `0`, null port | exit 139 |
| `agentfs run` with default allows | `0` | not run |

- Inside the sandbox, `AGENTFS_SANDBOX=macos-sandbox`.
- Crash report `~/Library/Logs/DiagnosticReports/headless_shell-2026-10-04-142425.ips`: `EXC_BAD_ACCESS SIGSEGV`,
  `KERN_INVALID_ADDRESS at 0x10`, top frame `IOKit IONotificationPortGetRunLoopSource + 48`. The worker's eleven
  reports from 13:44 to 13:48 (`headless_shell-*`, `Chromium-*`, `chrome-headless-shell-*`, `Google Chrome-*`)
  are in the same directory.
- The denial does not depend on our flags: with AgentFS's default allows the call still returns 0. `agentfs run
  --help` (0.6.4) has no option that grants IOKit or Mach-service access.
- Inference, not verified: Chromium's macOS power monitor registers for system power at startup and does not check
  for failure, so the null port is dereferenced. This matches the frame and the `0x10` address.

## 3. The worker's report (not re-verified here)

- Google Chrome 154 (`/Applications/Google Chrome.app`) also exited 139 inside the sandbox with an explicit
  `--user-data-dir`. Without one, it failed earlier with "Failed to create headless user data directory container".
- `open -a` is refused inside the sandbox (error -54), so the browser cannot be started outside it.
- A scratch dylib that wraps `IORegisterForSystemPower` to return a valid `IONotificationPortCreate` port, injected
  with `DYLD_INSERT_LIBRARIES`, made `headless_shell` run. This works only because that binary is ad-hoc signed
  without the hardened runtime. Whether it was tried on Chrome 154 is not recorded.
- A `nohup … &` browser was gone by the next tool call, with an empty log; the worker inferred that the harness
  kills background processes when a tool call returns. It is not established whether Pi's bash tool, ACPX or AgentFS
  does this.
- Crashpad could not write to `~/Library/Application Support/Chromium/Crashpad` under the real home ("Operation not
  permitted"). That is a warning, not the cause.

## 4. Options (to decide before implementation)

1. **Say it up front (minimum).** `doctor` probes `IORegisterForSystemPower` inside `agentfs run` and reports
   "browsers cannot start in graph workers on this host". The worker instruction, or the README's limits for
   supervisors, says the same, so a browser criterion is routed to the supervisor rather than dispatched.
2. **Supervisor-hosted browser.** The supervisor starts a throwaway headless browser outside the sandbox, with a
   fresh profile, a loopback CDP port and a lifetime bound to the operation, and passes the port to the worker.
   This needs proof that a worker can reach host loopback from inside `agentfs run` (the worker's own same-call
   test suggests it can; not verified here). Every page the browser loads then runs outside the sandbox, which
   widens what injected content can reach (`AGENTS.md`, second hazard).
3. **Package the shim as test support.** Ship a tiny wrapper-library source plus a launcher for browser tests.
   It is fragile: it depends on an unhardened, ad-hoc-signed binary and a Chromium code path, and
   it patches a sandbox denial instead of resolving it. Not recommended beyond a private test aid.
4. **Upstream.** Report to AgentFS that its macOS profile denies the IOKit power-management service, which breaks
   every Chromium, and ask for an allow option. This complements 1; it does not replace it.

Recommendation, unverified as to effort: 1 now and 4 in parallel; 2 only if browser criteria in worker tasks are
common enough to justify a new supervisor-owned resource.

Out of scope: the Crashpad warning; Linux hosts (untested).

## 5. Acceptance criteria (for option 1; revise if another option is chosen)

- [ ] `doctor` reports whether a browser can start inside `agentfs run`, from a real probe on this host: it fails on
  macOS 26.7.1 with `agentfs v0.6.4` and names the cause. Proof: a test in `test/` that runs the real probe under
  real AgentFS, skipping only when `agentfs` is absent, plus the `doctor` output from this host.
- [ ] The background-process claim in §3 is reproduced or refuted, and the part (Pi's bash tool, ACPX or AgentFS)
  that kills the process is named. Proof: a bounded experiment recorded here.
- [ ] The README's supervisor guidance and `AGENTS.md` state the limit: a browser criterion is not dispatched to a
  graph worker on an affected host, and a worker that needs a server starts and stops it in one command.
- [ ] Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` and `git diff --check`
  green, with counts from the run made.

## 6. Operator workaround until this lands

Keep browser-test criteria out of worker slices. Run them in the supervisor session after integration, where a
throwaway `headless_shell` with a fresh `--user-data-dir` starts normally (verified in §2). If a worker must run one,
start the browser, the tests and the cleanup in a single shell command (§3).
