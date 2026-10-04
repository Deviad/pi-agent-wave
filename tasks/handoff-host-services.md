# Handoff: host services, tools a graph worker uses but cannot run inside its sandbox

**Recorded:** 2026-10-04
**Origin:** `tasks/handoff-worker-browser-sandbox.md` (option 2, decided by the operator the same day). A browser
cannot start inside `agentfs run` on macOS, and later tools may need what a sandbox denies.
**Not a PRD.** This file is a work order. Read it with `specification.md` §5.3 (the sandbox) and §5.2 (dispatch).

**Status:** opened and implemented 2026-10-04 on the uncommitted tree over `53398ef`; every criterion is checked
below, including the authorized live run. Four points changed during implementation and are recorded in §3 as
amendments: the services run beside the first launch only, the backstop identifies a process by its start time,
the absence audit needed no new key, and a failed stop no longer prevents the other stops.

## 1. Decisions (operator, 2026-10-04)

| Question | Decision |
| --- | --- |
| Where services are defined | Their own file, `host-services.jsonc`, beside `model-routing.jsonc` |
| Who attaches a service | The supervisor, at each `op=dispatch`; there is no default per role |
| Windows | A constraint the design must not rule out, not a goal of this work |

## 2. Rules

1. **Only tools that produce no candidate files.** A service runs on the host: its writes bypass the overlay and the
   ownership audit. A browser, a database or an emulator, whose state is disposable, qualifies. A build tool, code
   generator or formatter that writes what a worker hands in does not, and stays inside the sandbox. This is the
   operator's judgment when registering a service; the code cannot check it.
2. **The operator defines services; workers never request them.** Only the operator-owned registry names an
   executable, and only the supervisor's `op=dispatch` attaches one. Nothing a worker writes or says starts a
   process on the host.
3. **Each attachment is private and short-lived.** A fresh port and a fresh state directory per attempt, both on the
   host, and the service is stopped when the attempt's launcher ends.

## 3. Design

**Registry.** `<agent dir>/host-services.jsonc`, or the path in `PI_HOST_SERVICES`. Absent means no services.

```jsonc
{
  "services": {
    "browser": {
      "description": "Throwaway headless Chromium; connect over CDP at $BROWSER_CDP_URL",
      "start": {
        "darwin": { "executable": "/abs/path/headless_shell", "args": ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port={port}", "--user-data-dir={stateDir}", "--no-first-run", "about:blank"] }
      },
      "env": { "BROWSER_CDP_URL": "http://127.0.0.1:{port}" },
      "readyTimeoutSeconds": 30
    }
  }
}
```

- Names match `^[a-z][a-z0-9-]{0,31}$`. `start` is keyed by Node's `process.platform` (`darwin`, `linux`, `win32`),
  so an entry for another platform is configuration, not code. `executable` is absolute; `args` are strings.
- The only placeholders are `{port}` and `{stateDir}`; any other `{…}` is refused.
- `env` names match `^[A-Z][A-Z0-9_]*$`, must not start with `PI_`, and must not be `HOME`, `PATH` or `TMPDIR`:
  the worker's own environment is not the operator's to override.
- `readyTimeoutSeconds` is 1 to 120, default 30. `description` is required: it is what the worker is told.
- One implementation, `lib/host-services.mjs`, parses and validates the file for `op=dispatch` and `doctor`.

**Dispatch.** `op=dispatch` takes `hostServices: string[]`. Unknown names, duplicates, an invalid registry, or a
service with no entry for this platform are refused before `init`, as a parameter error: nothing is created,
recorded or retried. The resolved entries for this platform go to `delegate_core.py start` as
`--host-services-json`, and the dispatch result echoes the attached names.

**Launch.** With services attached, `launch-with-host-services.sh` runs `scripts/host_service_launcher.py` around
the unchanged `launch-acpx.sh`, for the worker's first launch only. `launch-acpx.sh` is byte-identical with and
without services, because later runs of the same session (the close after settlement) reuse it. The wrapper runs on
the host, outside the sandbox, for both transports, because both run that launcher. It:

1. gives each service a free loopback port and a private state directory under
   `<attempt>/host-services/<name>/`, and starts it in its own process group, logging to
   `<attempt>/host-services/<name>.log`;
2. records `{name, pid, started, executable}` in `<attempt>/host-services/running.json` before waiting, where
   `started` is the process's `ps -o lstart=` start time;
3. waits until `127.0.0.1:<port>` accepts a connection, within `readyTimeoutSeconds`. If a service exits or times
   out, it stops every service it started, prints `host service <name> did not become ready …` naming the log's
   last line, and exits 70 without starting the worker;
4. runs the worker command as a child with each service's `env` entries expanded, and forwards SIGTERM, SIGINT and
   SIGHUP to it;
5. when the worker exits, stops each service's process group (SIGTERM, then SIGKILL after 5 s), removes
   `running.json`, and exits with the worker's status. A stop that raises is reported and the others still run;
   `running.json` is then kept for the backstop.

**Backstop.** A launcher killed with SIGKILL cannot stop its services. `delegate_core.stop_host_services` reads
`running.json` and stops each recorded process group whose start time still matches the recorded one. It runs
before the attempt directory is removed, both when a settled attempt is cleaned up and in `abort_acpx_attempt`, and
reports a service it could not stop as a cleanup failure.

Amendments made during implementation (2026-10-04):
- *Identity by start time, not command.* The plan compared the process's command with the recorded executable.
  The test caught that a framework build of Python on macOS shows up in `ps` under
  `…/Python.app/Contents/MacOS/Python`, not the executable it was started as, so the backstop took the live
  service for a reused pid and left it running. The start time survives a re-exec and changes with pid reuse.
- *No `hostServicesAbsent` key.* The absence audit's `ownedProcessesAbsent` already matches every process whose
  command line names the attempt directory, which includes a service started with `{stateDir}`. A service whose
  arguments never name `{stateDir}` is covered only by the launcher and the backstop.
- *First launch only* (found by the live run, §5). The plan put the wrapper inside `launch-acpx.sh`. Settlement
  reruns that script through `run_acpx_again` to close the ACPX session, so the close started the services a
  second time, crashed on the existing state directory (`FileExistsError: 'browser'`), and left the session
  unclosed: `postSettlementFailures` named the crash, `ownedProcessesAbsent` and `sessionClosed` failed. The
  wrapper now lives in its own script, used only by the first launch (`first_launcher`).
- *EPERM means gone.* `os.killpg(pid, 0)` intermittently raised `PermissionError` once a service's group had
  emptied (about one run in three), which crashed the launcher mid-stop and once left a browser group running.
  The explanation that macOS answers a group of only zombies with EPERM is recalled, not verified here; both stop
  paths now treat EPERM like ESRCH, and `stop_all` keeps going after a failed stop.

**Instruction.** The worker's prompt gets one paragraph per attached service: its name and description, the
environment variable names that hold its endpoint, that it runs outside the sandbox so anything it writes is not
part of the candidate, and that it is stopped when the worker finishes. No path or port appears in the prompt.

**Not in scope:** defaults per role; process handling on Windows (the wrapper uses POSIX process groups, so a
Windows entry also needs a code change there); the job-hunter tests' own browser launch; a `doctor` start probe
(`doctor` validates the registry and checks that each executable for this platform exists).

## 4. Known assumptions

- The environment reaches the worker's tools. `acpx-worker.ts` passes `process.env` to `acpx`, and `acpx`
  (`buildAgentEnvironment`) passes its environment to the agent. Verified live for the Pi adapter (§5); for Codex
  and Claude it is inferred, not verified.
- A worker inside `agentfs run` reaches host loopback: verified on macOS (`handoff-worker-browser-sandbox.md` §4,
  Decision). Linux and Windows are untested.
- The free port is found by binding port 0 and closing it before the service binds it. Another process could take
  it in between; the readiness check would then connect to the wrong process. This is accepted as unlikely on a
  single-user host.

## 5. Acceptance criteria

- [x] The registry parser accepts the example above and refuses each invalid case in §3 with a message naming the
  service and field; an absent file means no services. Proof: `test/host-services.test.ts` "host service
  registry" (13 cases). These tests were written after `lib/host-services.mjs`, not before it.
- [x] `op=dispatch` with an unknown or unavailable service is refused before `init`, and no run directory is
  created. Proof: "an unknown service is a parameter error: nothing is launched, created or recorded" (no
  launcher invocation, no run directory, operation still `pending` with 0 transient attempts), and "a registered
  service reaches the launcher resolved for this platform" for the accepted path. An unavailable platform is
  refused by `attachHostServices`, covered in the registry cases rather than through the tool.
- [x] `prepare_acpx_attempt` with services writes the spec and the wrapping launcher, and the prompt names the
  service and environment variables without a path or port; without services the launcher text is unchanged.
  Proof: "wraps the unchanged worker command, writes the spec, and tells the worker the variables but no path or
  port" (the wrapped command equals the plain one after normalising the private directory).
- [x] The wrapper, around a real `agentfs run`, starts a real loopback service, the sandboxed command reaches it
  through the expanded environment variable, and after exit no service process and no `running.json` remain.
  Proof: `test/host-service-launcher.test.ts` "a sandboxed worker reaches the service through its variable, and
  nothing is left afterwards" (Python `http.server`; a Node `fetch` inside `agentfs run` gets status 200).
- [x] A service that never becomes ready makes the wrapper exit 70 with the named message, without running the
  worker and without leaving a process. A SIGTERM to the wrapper stops both the worker and the service. Proof:
  "a service that never becomes ready stops the launch before the worker runs" and "SIGTERM to the launcher stops
  the worker and every service" (exit 143).
- [x] `stop_host_services` stops a recorded live service whose launcher was killed with SIGKILL, and leaves alone
  a recorded pid whose start time no longer matches; the absence audit reports a leaked service. Proof: "after the
  launcher is killed outright, stop_host_services stops what it left", "stop_host_services leaves alone a recorded
  pid that now runs something else", "the absence audit reports a leaked service as an owned process".
- [x] Browser, end to end on macOS: the registry's browser entry under the wrapper and real `agentfs run`, driven
  over CDP from inside the sandbox, evaluates JavaScript in a page. Proof: "a worker inside agentfs drives the
  registered browser over CDP" prints `evaluated from-sandbox:42 in macos-sandbox` and leaves no browser process;
  five repeats clean.
- [x] `doctor` reports `host-services`: the number registered, an invalid registry, or a missing executable for
  this platform, as warnings. Proof: "reports none, an invalid registry, a missing executable, and a usable
  registry".
- [x] One live graph worker dispatched with `hostServices: ["browser"]` drives the browser and settles. Proof: run
  and operation ids and the answer's evidence. Authorized by the operator 2026-10-04; two runs, research graph,
  `thinker_split`, `alibaba/qwen3.8-flash` on the Pi adapter, headless, temporary graph home, registry through
  `PI_HOST_SERVICES`. Run 1 (`run_6ef2ebed-2a81-4ea4-996a-d3ee1f52596a`, `op_c1201b80-…`): the worker read
  `BROWSER_CDP_URL` and returned the browser's user agent from inside `macos-sandbox`, but settlement reported
  the close defect above. Run 2 after the fix (`run_50bcd525-de70-4f0b-8bf0-6d2f0ea194ff`,
  `op_3a48c18d-2e9b-4bd4-bfd2-a400a5578a71`, about 35 s): exited 0, settled, `postSettlementFailures` empty,
  cleanup evidence with every absence check true and `sessionClosureEvidence: close-proved`; the answer reports
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)
  HeadlessChrome/134.0.6998.35 Safari/537.36` and `sandbox=macos-sandbox`, and the installed headless shell
  reports `Chromium 134.0.6998.35`. Limit of this proof: a complete capture retains only the answer, not the
  tool stream, so the user agent is evidenced by an exact build string a model is unlikely to guess, not by a
  retained tool result. This also settles §4's first assumption for Pi: the variable reached the agent's shell
  tool. Codex and Claude remain unproven. Evidence: `agent-output/live-host-service-browser-20261004/`
  (`run1-defect/`, `run2-fixed/`). The run 1 worker wrote its script to `/tmp/cdp_query.mjs` on the host, the
  known `/tmp` hazard; it was removed.
- [x] `specification.md`, `extensions/pi-agent-wave/README.md`, `AGENTS.md` and `product.md` (Windows as a later
  goal) describe host services; the browser limit's advice names them. Proof: spec §5.2 steps 4 and 6, §5.3 "Host
  services", §7 `PI_HOST_SERVICES`, test inventory; README "Host services", `dispatch` row, environment table,
  "Doctor", "Known limitations"; AGENTS.md "Host services" and configurable paths; product.md "Windows is
  unsupported". The supervisor contract (`contract.ts`) names `hostServices` too.
- [x] Gate: `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`, `git diff --check`
  and `npm run typecheck` green, with counts from the run made. 2026-10-04 on `53398ef` plus this change: 678
  tests, 667 passed, 0 failed, 11 skipped; `git diff --check` clean; typecheck exit 0; `npm pack --dry-run` 87
  entries including `lib/host-services.mjs`, `lib/host-services.d.mts` and `scripts/host_service_launcher.py`, no
  test file. Mutations, each restored byte for byte: dropping the launcher's stop, the forwarded signal, the
  environment, the backstop's start-time check, or the backstop itself each fail at least one case; after the
  first-launch fix, pointing `worker_launcher` back at the wrapper fails the preparation case. Rerun after that
  fix, same counts: 678 tests, 667 passed, 0 failed, 11 skipped; typecheck and `git diff --check` clean. Bun
  package checks not run: `bun` is not installed on this host.
