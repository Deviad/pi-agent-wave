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

**Status:** opened 2026-10-04. Option 1 (§4) was implemented the same day and then reverted on the operator's
decision, before commit (restore point: stash object `91a9e70`): option 2 is taken instead, generalised to host
services so that a later tool needing what the sandbox denies is not another special case. It is implemented in
`tasks/handoff-host-services.md`. The documented limit (README, `AGENTS.md`, `specification.md` §5.3) and §3's refutation stay;
they hold whichever option is built. Gate after the revert, on `53398ef` plus the doc changes: 653 tests, 642 passed,
0 failed, 11 skipped; `git diff --check` clean; `npm run typecheck` exit 0. §2 is verified on the host; §3's background-process claim is refuted, and the rest of §3 is
the worker's report, not re-verified.

## 1. Summary

| # | Defect | Consequence |
| --- | --- | --- |
| 1 | Inside `agentfs run` on macOS, `IORegisterForSystemPower` fails, and every Chromium build segfaults at startup in `IONotificationPortGetRunLoopSource` | A task that asks for browser tests cannot satisfy that criterion. The worker spends its budget diagnosing the host instead |
| 2 | Nothing tells the worker or the supervisor in advance | The failure looks like a broken browser install. In the reported run the worker read crash reports, tried five binaries and many flags, and finally built a private `DYLD_INSERT_LIBRARIES` shim |
| 3 | ~~The worker reports that a background process does not outlive the tool call that started it~~ Refuted for a plain background process (§3) | None established |

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
  kills background processes when a tool call returns. **Refuted 2026-10-04 for a plain background process.** Pi
  0.87.1's bash tool (`dist/core/tools/bash.js`, `createLocalShellOperations`) spawns each command `detached` and
  calls `killProcessTree` only on abort or timeout. Driving that real function with `nohup sleep 60 >/dev/null 2>&1
  & echo $!`, waiting 3 s and then issuing a second call, the `sleep` was alive before the second call both on the
  host and inside `agentfs run --no-default-allows --allow <scratch>` (`AGENTFS_SANDBOX=macos-sandbox`). Inference,
  not verified: the worker's background browser died for the reason in §2, at startup, before the shim was
  in place. A call the model gives a `timeout` does kill its whole tree when it expires.
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

**Decision (2026-10-04, operator):** option 2, generalised: a supervisor-owned host service attached to an operation,
with the browser as its first entry, because Windows support is a later goal and other tools may need what a
sandbox denies. Option 1 was reverted rather than kept as an interim guard. Evidence for option 2's open question,
verified on macOS: a headless shell started on the host with `--remote-debugging-address=127.0.0.1
--remote-debugging-port=0` was driven from inside `agentfs run --no-default-allows --allow <scratch>` over CDP
(`Page.navigate` to a data URL, then `Runtime.evaluate` returned `"from-sandbox:42"`, HeadlessChrome 134). Linux and
Windows are untested.

Out of scope: the Crashpad warning; Linux hosts (untested).

## 5. Acceptance criteria (option 1, superseded)

Option 1 was reverted; criteria 1 and 4 record what that implementation proved before the revert, and option 2's
criteria belong to its own work order.

- [ ] ~~On macOS, `doctor` reports a `worker-browser-startup` check from a real probe: `IORegisterForSystemPower`
  called through JXA (`osascript -l JavaScript`, present on every macOS, unlike `python3`, which opens an
  installer dialog without the Command Line Tools), first on the host as a control and then inside `agentfs run`
  with the worker's flags and a temporary `HOME`. It is `warn`, never fatal: when denied, it names the cause
  and the workaround; when the control fails, it says the probe is unavailable instead of blaming the sandbox.
  It leaves nothing behind. Proof: a test in `test/` that runs the real probe under real AgentFS, skipping only off
  macOS or without `agentfs`, asserts the host control succeeds and the check agrees with the sandboxed probe,
  plus the `doctor` output from this host. Evidence: `test/doctor.test.ts` "the probe works on the host, and the
  check agrees with the probe inside agentfs run and leaves nothing behind" (red on `53398ef` with no
  `probeSystemPower` export, green after; it also asserts no `dg-doctor-browser-*` directory survives under
  `SCRATCH_ROOT`). Mutations: a probe that always prints `root=0` fails the host-control assertion, and reporting
  `ok` for a denied call fails the agreement assertion. `node scripts/doctor.mjs` on this host prints `[warn]
  worker-browser-startup: browsers cannot start in graph workers on this host: agentfs run denies
  IORegisterForSystemPower, …`. The scratch directory comes from `lib/agent-paths.mjs:makeScratchDir`, as the
  package's no-`os.tmpdir()` rule requires; the session's delta lands under that directory's `HOME` and is removed
  with it. The existing "is read-only" doctor test still passes.~~ Reverted; the implementation is in stash `91a9e70`.
- [x] The background-process claim in §3 is reproduced or refuted, and the part (Pi's bash tool, ACPX or AgentFS)
  that kills the process is named. Proof: a bounded experiment recorded here. Refuted (§3): nothing kills a plain
  background process between calls; Pi's bash tool kills a call's tree only on abort or timeout.
- [x] The README's supervisor guidance and `AGENTS.md` state the limit: a browser criterion is not dispatched to a
  graph worker on an affected host. Evidence (after the revert): README "Known limitations" ("No browser inside
  a worker on macOS"), `AGENTS.md` "Known open limit, verified 2026-10-04", `specification.md` §5.3 "What the sandbox
  denies that a worker may need".
- [ ] ~~Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` and `git diff --check`
  green, with counts from the run made. 2026-10-04 on `53398ef` plus this change: 655 tests, 643 passed, 0 failed,
  12 skipped (the 11 opt-in skips and "is not reported off macOS"); `git diff --check` clean; `npm run typecheck`
  exit 0. The first run failed 1 test, "no shipped module reaches for tmpdir()", which this change then obeyed.
  Bun package checks not run: `bun` is not installed on this host.~~ Superseded with option 1; the gate after the
  revert is recorded under Status.

## 6. What to do now

Attach a browser to the worker as a host service (`tasks/handoff-host-services.md`, README "Host services"):
register it in `host-services.jsonc` and dispatch with `hostServices: ["browser"]`. Without a registry entry, run
browser tests in the supervisor session after integration, where a throwaway `headless_shell` with a fresh
`--user-data-dir` starts normally (verified in §2).

## 7. Draft upstream report (option 4, not filed)

Filing is externally visible and needs the operator. Tracker: `https://github.com/tursodatabase/agentfs/issues`, the
repository the package README cites for `v0.6.4`; on 2026-10-04 it had issues enabled, was not archived, held 75
open issues and was last pushed 2026-06-03. Duplicate check the same day (GitHub issue search in that repository):
nothing for `IORegisterForSystemPower`, `chrome`, `IOKit`, `puppeteer` or `playwright`; `chromium` and `browser`
match only unrelated issues (#322, #94, #245). Related: #178, "agentfs run: Use macOS Sandbox for filesystem
isolation", which introduced the profile. Not filed: `gh` is not authenticated on this host, and filing needs the
operator's explicit go. To file: `gh auth login`, then `gh issue create --repo tursodatabase/agentfs --title
"<title below>" --body-file <the quoted body>`.

> **macOS sandbox denies `IORegisterForSystemPower`; every Chromium-based browser segfaults inside `agentfs run`**
>
> `agentfs v0.6.4`, macOS 26.7.1. Inside `agentfs run` (`AGENTFS_SANDBOX=macos-sandbox`), with or without
> `--no-default-allows`, `IORegisterForSystemPower(NULL, &port, NULL, &notifier)` returns 0 and leaves the port
> null; on the host it returns a valid root. Chromium's power monitor then dereferences the null port, and the
> browser crashes at startup with `EXC_BAD_ACCESS` at `0x10` in `IONotificationPortGetRunLoopSource`. Seen with
> Playwright's Chromium headless shell (HeadlessChrome 134); Google Chrome 154 was reported to fail the same way.
> Reproduce:
>
> ```sh
> agentfs run osascript -l JavaScript \
>   -e "ObjC.import('IOKit')" \
>   -e "ObjC.bindFunction('malloc', ['void*', ['int']])" \
>   -e "ObjC.bindFunction('IORegisterForSystemPower', ['unsigned int', ['void*','void*','void*','void*']])" \
>   -e "'root=' + \$.IORegisterForSystemPower(null, \$.malloc(8), null, \$.malloc(8))"
> ```
>
> This prints `root=0` inside the sandbox and a non-zero root outside it. Could the macOS profile allow the IOKit
> power-management service, or could `agentfs run` take an option that does?

The command above was run as written on 2026-10-04: `root=0` inside, `root=16643` on the host. Before filing, check
the Chrome sentence, which is the worker's report (§3).
