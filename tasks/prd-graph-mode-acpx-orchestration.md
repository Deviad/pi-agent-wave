# Graph mode without Herdr: what is already true, and the one test that settles the rest

Status: proposed, nothing implemented. Written after verification, and it corrects an earlier
draft of this file that was built on unreliable tool output.

Supersedes-in-part: `tasks/issue-014-air-controlled-editor-independent-orchestration.md`, which is
already marked **Closed** with the note that the slice proved the product could not choose a
concrete second location (no configured host, no resolvable SSH target, no reachable
AgentEnvironment, no registered environment, no second Pi or Codex installation).

## Correction of record

An earlier draft of this file asserted: 64 test files import `bun:test` with no script that runs
them; a `PaneController` with an "acpx" implementation and a `createPaneController` fallback to
tmux; `PiTmuxController` driving tmux through `Bun.spawn`; and `doctor.mjs` not reading a routing
or catalogue file.

All four are false, and none of them came from a real command. Re-checked:

- `grep -rl "from \"bun:test\"" test/*.test.ts` → **0 files**. `node:test` → 53 of 72 files.
- `createPaneController` does not exist in `lib/` or `scripts/`. No `Bun.spawn` either.
- acpx is not a stub or a gap: `lib/acpx-{select,events,settlement,settlement-evidence,permissions,types}.ts`,
  `scripts/acpx-plan.ts`, and `test/acpx-*.test.ts` (22 files) are all present.
- `doctor.mjs` does read both: it imports `resolveAgentDir, resolveCatalogPath, resolveFzfPath,
  resolveRoutingPath` from `../lib/agent-paths.mjs`.

## What is actually true

| Claim | Evidence |
| --- | --- |
| Transports are `headless` and `herdr`, and they are **presentation** kinds, not execution backends | `lib/worker-transport.ts:1` — `WORKER_TRANSPORT_KINDS = ["headless","herdr"]` |
| acpx is the execution substrate, independent of that choice | `WorkerAttemptIdentityInput` carries `acpxSessionId`, `acpxRecordId`, `acpxAttemptKey` (`worker-transport.ts:15-17`) |
| Headless attempts get a real identity and a real plan | `scripts/acpx-plan.ts:23` — `if (input.transport === "headless") return createHeadlessAcpxAttemptIdentity(core)` |
| "No panel" therefore does not mean "no acpx" | the two axes are separate types; nothing requires Herdr to launch a worker |
| Default configuration dispatches nothing | `delegate_mode` defaults to `"disabled"` |

So the product question "can a node run with no assistant turn, driven by declarations, with no
panel?" is largely already answered yes by the code. The open part is narrower and is about
*proof and repeatability*, not architecture.

## Gate state at the time of writing

Run from the repository root, all three documented gates pass:

- Node completion gate (`node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`):
  **454 tests, 443 pass, 0 fail, 11 skipped, exit 0.**
- Bun gate (the 8 package/companion files listed in `AGENTS.md`): **46 tests, 0 fail, exit 0.**
  The `MODEL_FAILOVER_BLOCKED` line that appears in that output is fixture payload printed by the
  failover companion's own tests, not a failure.
- Portability scan over the four entry points plus transitively referenced package code:
  **no escape candidates** (no `/Users/…`, `/home/…`, or Windows drive roots).

The 11 skips are not hidden failures. They are deliberate opt-in gates, e.g.
`skip: process.env.PI_RUN_LIVE_HERDR !== "1"` and `PI_RUN_LIVE_JOB_HUNTER !== "1"`.

## The one thing worth doing: run the existing real matrix once

`test/acpx-real-matrix.test.ts` already implements the spike that issue 014 could not run. It is
gated by `RUN_REAL_ACPX_MATRIX=1` **and** `PI_CLAUDE_OAUTH_TOKEN_FILE`, and its two real cases are
"Pi cancel and reconnect" (`anthropic/claude-fable-5`) and "Codex cancel and reconnect"
(`gpt-5.6-sol`), driven through `test/support/acpx-lifecycle-driver.mjs` with AgentFS sandboxing
(`buildAgentFsInvocation`, `auditAgentFsChanges`).

It did not run in the green pass above: both cases were skipped by default. So the accurate
statement today is *"the documented gates pass with the real acpx matrix skipped"*, which is not
the same as *"the acpx path works"*. Running it once is what converts the first into the second,
and it needs two things only the user can supply: consent to spend the turns, and the OAuth token
file.

Rehearsal boundary, kept honest: the fake-acpx tests (`support/fake-acpx.mjs`, copied to a mode
`0755` `acpx` in a temp bin) prove launch mechanism — argv, FD wiring, exit codes, settlement
parsing. They do not prove the computation, and per the project's own rule a faked target proves
the mechanism only. That is exactly why the real matrix matters.

## Live run: the matrix was executed, and the acpx path works

Run on 2026-09-10 from the repository root with `RUN_REAL_ACPX_MATRIX=1`, a temp `HOME` per case,
real `acpx 0.13.2` and `agentfs v0.6.4` (both matching the runtimes the test records), and
`MATRIX_EVIDENCE_DIR=agent-output/graph-mode-acpx`. Total wall clock: about 100 seconds across two
executions.

First execution (default token path): 3 tests, 2 pass, 1 fail.

| Case | Result | Evidence |
| --- | --- | --- |
| Pi (`anthropic/claude-fable-5`) | **pass** — all five lifecycle stages true, exit 0 | `agent-output/graph-mode-acpx/pi.json` |
| Codex (`gpt-5.6-sol`) | **pass** — all five stages true, exit 0 | `agent-output/graph-mode-acpx/codex.json` |
| Claude (`claude-opus-5`) | **fail** | no copy under `agent-output/graph-mode-acpx/` — see the correction below |

Both passes also recorded `agentFs.changes: 0`, `owned: 0`, `violations: 0`, and
`credentialBoundary.valuePersisted: false`. `git status` after the runs showed no worktree change,
which is consistent with that audit; `agent-output/` is gitignored, so the evidence does not enter
commits.

### Correction to the table above, and a re-verification (same day)

The parenthetical was wrong about mechanism. `acpx-lifecycle-driver.mjs` writes
`${agent}-result.json` unconditionally, before it sets a failing exit code, into the throwaway
temp dir the test makes; the copy into `MATRIX_EVIDENCE_DIR` happens only after the lifecycle
assertions pass, and `afterEach` deletes the temp dir. So the failing run's diagnostics did exist
— they are what the assertion message printed — but they land nowhere durable. Anyone
reproducing this should read the assertion output rather than looking for a file.

Re-running the Claude case alone on 2026-09-10 gave the same shape: exit 1, no terminal
`end_turn`, a `session/prompt` request with one `session/update` and neither a result nor an
error object. That repetition is weaker than it looks: Claude's service was reported to be having
technical difficulties at the time, so this run cannot separate a provider-side fault from a local
one. It reproduces the symptom, which is not evidence about the cause. Two hypotheses were still
eliminated on the way.

- *Missing Claude credential.* Wrong. `~/.claude/.credentials.json` exists at mode 600, the
  `claude` CLI is on PATH, and `queued` and `cancelled` passed inside the same run, which needs
  working auth. An earlier note here said the credential was unavailable; that came from reading
  the wrong key (`claude` instead of `claude-code`) in `auth.json`.
- *A permanent gap in Claude session resume.* Not supported. A `final-matrix/claude.json` dated
  2026-09-01 records all five stages true, including `reconnected`. Its `runtimes` block is
  **hardcoded in the test**, not measured, so it does not prove the two runs used the same acpx
  or agentfs build, and the earlier file predates the current assertion set. Reading it as proof
  of a regression would be unsupported: whether anything actually regressed is unknown.

One cheap probe was attempted and discarded as invalid: invoking `acpx` directly with the model
flag set to `claude-opus-5` but placed before the agent name, which never reached Claude at all. The
reply was `the ACP agent did not advertise that model. Available models: gpt-6-astra, ...` — the
request went to the default agent, and the guard that binds a model to its own agent
(`agent_for_model` / `agentForModel` / `selectAcpAgent`) refused it. That confirms the routing
guard works; it says nothing about resume, and it is not a faithful way to probe this case
because it skips the `CLAUDE_CONFIG_DIR` and token wiring the harness supplies.

What is still open, stated as open: whether the cancel step leaves a Claude session in a state
the next prompt cannot resume. Settling it needs an instrumented run through the harness with
real Claude calls, which costs money, so it is left for a decision rather than done quietly.

Deferred on 2026-09-10 rather than run, because the provider was degraded and a probe cannot
attribute a failure while the service itself is unhealthy. Any future attempt should establish
provider health first — one trivial no-tool prompt on a fresh session, checked against the
expected reply — and only treat a full-sequence failure as local if that control passes. Running
the sequence against an unhealthy provider yields a result readable neither way, which is why
nothing was spent on it.

That settles the architectural question this file was opened to ask. A no-panel worker launch, a
cancel mid-run, a reconnect after the cancel, and a session close all work against the real acpx
backend on real models. The premise that acpx background mode "leaves no persistent handle" is
contradicted by observation: `sessions ensure` / `cancel` / `--session` / `sessions close` all
returned success for pi and codex.

### The claude case, and what is still unknown

Two executions of the claude case, both failing identically at one stage:

| Stage | exit | outcome |
| --- | --- | --- |
| `sessions ensure` | 0 | ok |
| queue (no-wait) | 0 | ok |
| `cancel` | 0 | ok |
| reconnect prompt | **1** | `reconnectStopReasons: []` — no `end_turn` |
| `sessions close` | 0 | ok |

Across both runs, every diagnostic line carried `errorKeys: []`, `errorKind: null`,
`errorCode: null`, `errorClass: null`. So this is not a protocol error and not an auth rejection
reported by the agent; the resumed turn simply never produced a terminal stop reason, and
`reconnected` is therefore false.

What was ruled out by checking rather than assuming:

- The `claude` runtime is installed here (`~/.brew/bin/claude`), so it is not a missing binary.
- The first run used `~/.claude/.credentials.json`, which is a JSON bundle, while the driver does
  `readFileSync(tokenFile).trim()` and passes the whole file as `CLAUDE_CODE_OAUTH_TOKEN`. That was
  a mistake in how the run was launched, not a product defect.
- A second run with a correctly extracted raw 108-character token (temp file, mode 600) failed the
  same way at the same stage, so the credential format was not the cause.
- `acpx claude …` is a valid invocation form: the driver uses the agent name as a subcommand, and
  `--agent <command>` exists separately as a raw-agent escape hatch.

Still unknown, and deliberately not guessed at: whether the reconnect failure is the Claude agent
not resuming an ACP session, the model id `claude-opus-5` not existing in this configuration, or
the `--deny-all` plus empty allowed-tools combination interacting with that agent. Three further
lives runs would be needed to separate those, and that is a decision rather than a default.

Incident worth recording: while extracting the token, a 17-character prefix of the OAuth token was
printed to the terminal before masking was tightened. Only a prefix of one token, and the file was
mode 600 and has since been deleted, but it was a real leak of partial credential material and is
recorded here rather than quietly dropped.

## Explicitly not proposed

- No new "air control plane" subsystem, no `air-control` module, no second execution mode. The
  pieces this idea assumed were missing either exist (`worker-transport.ts`, `acpx-plan.ts`) or are
  external by design (Herdr, AgentFS, acpx).
- No change to graph topology, joins, retry budgets, the evidence gate, or the rule that a worker
  which exits without a report leaves the operation to be redispatched. Those invariants are the
  reason the current design looks the way it does.
- No making acpx or any transport the default. `delegate_mode` stays `"disabled"`.
- No new test tiers for their own sake. If a repeatable `test:acpx` script is wanted, it wraps the
  existing env-gated matrix rather than duplicating it.

## Open decision

The matrix has now been run, so the remaining question is narrower than the one this file opened
with. Two things are worth deciding, in order of cost:

1. Whether to chase the claude reconnect failure. It is one stage of one of three cases, and the
   cheapest next step is not more live runs but a look at what `acpx claude --session …` does to a
   resumed prompt, which may be answerable without spending any model turns.
2. Whether a repeatable `test:acpx` npm script is wanted, so this matrix can be run by name
   instead of by reading the test source to discover two environment variables and a token file.

Building the larger declarative/cross-host design still needs a concrete second location, which
issue 014 recorded as absent. Nothing downstream of that can be planned credibly without a named
host or resolvable SSH target.
### The credential used by both Claude runs had already expired (2026-09-10, measured)

Checked before any further failure analysis, as this file's own precondition requires.

Measured, not inferred:

- `~/.claude/.credentials.json` carries `claudeAiOauth.expiresAt = 1788705752829` = **2026-09-06T14:42:32Z**,
  and its mtime is 2026-09-06T06:42:32Z. At the control run it was **94.9 h past expiry** and had never
  been refreshed. Pi's `auth.json` `claude-code` entry holds the *same* expiry value; its file was last
  written 2026-09-08T19:58Z. Pi's `anthropic` entry expired 2026-09-09T03:53Z; `openai-codex` is valid
  until 2026-09-15T08:44Z.
- Both recorded Claude attempts are dated 2026-09-10, i.e. **3.4 to 3.6 days after that credential died**,
  including the second attempt that used a correctly extracted raw 108-character token. So the line above
  this section — "the credential format was not the cause" — is right about format and silent about age.
- A fresh control run today at 15:32-15:33 local, new session, `--allowed-tools ""`, `--deny-all`, temp
  `HOME` and `CLAUDE_CONFIG_DIR` with the credentials symlinked and **no** `CLAUDE_CODE_OAUTH_TOKEN`:
  `sessions ensure` succeeded, then the prompt returned `{"error":{"code":-32000,"message":"Authentication
  required"}}` with `usage_update used: 0, cost 0` and no `end_turn`. Zero tokens were requested or spent.

Two things this settles and one it does not:

1. The recorded shape and today's control shape are **different**. The recorded runs carried
   `errorKeys: []` / `errorClass: null` — silence. A run with no credential at all produces an explicit
   auth error. So the recorded failure was not simply "credential absent": with a stale-but-present token
   the resumed turn produced no terminal stop reason and no error object. If anything, that is a clue that
   a stale token degrades into silence rather than into a clean rejection.
2. An at-rest-expired entry does **not** automatically block the lifecycle: `pi.json` and `codex.json` were
   both written on 2026-09-10, after their own credentials' expiry, and both record `reconnected: true`.
   So "expired at rest" is a confounder to remove, not a proven cause, and it must not be written as one.
3. Therefore neither open question can be answered from existing data — not "the Claude agent does not
   resume an ACP session", not "claude-opus-5 does not exist here". Both need one rerun with a credential
   that is currently valid, which needs a re-login or a fresh token file; neither is mine to do.

Operational note for the next probe, because the first attempt wasted itself on it: `--cwd`, `--format`,
`--json-strict`, `--timeout`, `--model`, `--deny-all` and `--allowed-tools` are **global** options and must
precede the agent subcommand — `acpx --format json … claude "prompt"`, which is why the driver builds
`[...base, agent, ...args]`. Placing them after `claude` exits 1 with `unknown option '--cwd'` and spends
nothing. A prompt also needs a session first (`acpx claude sessions ensure --name <n>`), otherwise the
answer is `NO_SESSION`.

### Credential state as measured on 2026-09-10, and the rerun that settles it

`pi auth check` output, run here, all three verbatim:

| provider | status | reason |
| --- | --- | --- |
| `claude-code` | `not_ready` | `credentials_not_configured` — same with and without `--no-refresh` |
| `anthropic` | `invalid` | `invalid_state` (entry expired 2026-09-09T03:53Z) |
| `openai-codex` | `ready` | — |

So the self-service refresh route does not heal the Claude path: `pi auth check` defaults to refreshing
expired OAuth, ran against `claude-code`, and left `auth.json` byte-identical (mtime still
2026-09-08T19:58Z). The `claude-code` entry being present in `auth.json` is not the same as it being
usable, which is the second time this file's history has been misled by that distinction. Settling the
open question therefore needs a credential that is live now: a Claude Code login that rewrites
`~/.claude/.credentials.json`, or a raw token file handed to `PI_CLAUDE_OAUTH_TOKEN_FILE`.

Rerun recipe, one case only, verified rather than assumed. `--test-name-pattern` was rehearsed against a
two-test fixture and selected only the named case, so this does not quietly spend a Pi or Codex case too:

```bash
PI_CLAUDE_OAUTH_TOKEN_FILE=/tmp/acpx-claude-token.txt RUN_REAL_ACPX_MATRIX=1 \
MATRIX_EVIDENCE_DIR=agent-output/claude-recheck-2026-09-10 \
node --experimental-strip-types --test --test-name-pattern="Claude cancel and reconnect" \
  extensions/pi-agent-wave/test/acpx-real-matrix.test.ts
```

Run from the repository root. `RUN_REAL` needs both variables and an existing token file, otherwise the
case skips and reports as skipped; `npm run test:acpx` is the entry point that says so out loud instead.
The token file must hold the raw token, not the JSON bundle — the driver reads the file and passes its
content as `CLAUDE_CODE_OAUTH_TOKEN`.
