# Failover verification scope — three options, one decision needed

Status: **open decision, no implementation.** This records what model failover currently pins, what
is untested, and three concrete ways to close the gap, so the choice is made on evidence rather than
on which test is easiest to write. Nothing here authorizes a worker dispatch or a live provider call;
it describes what would be needed to prove each option.

## What failover is today

Transient, infrastructure-shaped failures advance an operation to the next model in its frozen chain
after the current model's budget is spent. Semantic verdicts never trigger failover, and an
exact-model lock never advances. Same-model retry keeps `modelAttempt`; cross-model fallback
advances it by exactly one and requires a `fallbackReason`. Both guards are enforced: a recorded
attempt outside "same or +1" is rejected, and `selectedModel` must equal the frozen chain entry.

## Three classification lanes, not two

The comment above `APPROVAL_BLOCK_PATTERN` in `retry.ts` says provider HTTP errors are classified
separately in `lib/model-failover-native.mjs` and that the two lanes must not disagree, with
`test/approval-block-routing.test.ts` pinning that agreement. There is a third lane that comment
does not mention: `classify_launch_failure()` in `scripts/delegate_core.py`, which scans its own
`TRANSIENT_LAUNCH_PATTERNS` and defaults to `permanent/unclassified`.

> Annotated 2026-09-10, after implementation. That "third lane" was not a lane: the function has no
> caller, so there was never a second consumer for it to disagree with. The paragraph above is kept
> as written because it is what prompted the check; the finding is in "Resolution of the two open
> questions" below, and the code was removed on 2026-09-10.

No test references `classify_launch_failure`, and no test calls `preflight_provider_credential()`
either, which sits directly in the worker path one function below. So the two unproven places are
(a) whether the Python lane agrees with the TypeScript lanes on the same input, and (b) whether the
live credential preflight is ever exercised past a fixture.

`model-failover.ts` is not dead code: it is a declared Pi extension entry (package.json `pi`
lists `index.ts`, `questionnaire.ts`, `cmux-session.ts`, `model-failover.ts`) and it exports
`modelFailoverExtension(pi)`, using Pi's own `@earendil-works/pi-ai/compat` retryability checks.
Its header says delegate workers are armed from their frozen route while interactive sessions opt in
with `/failover enable <tier>`. That header claim is not verified at runtime here, and it is the
load-bearing unknown: if worker attempts really do consult the Pi extension, then a transient failure
can be handled in three places on the way to the supervisor, and the untested Python lane sits
between two tested ones. If they do not, the extension only covers interactive sessions and the
worker-path story is entirely `retry.ts` plus `classify_launch_failure()`. Which one is true changes
what any rehearsal could assert, so it gets resolved by reading and instrumenting before anything is
built.

> Resolved on 2026-09-10, second branch: workers do not consult the extension. See the next section.

## The extension question is answered, and it removes most of the premise

**A worker never loads `model-failover.ts`.** `worker_pi_settings()` (`scripts/delegate_core.py:414`)
builds the worker's `settings.json` from `{"packages": []}` plus copied keys (`defaultProvider`,
`defaultModel`, `defaultThinkingLevel`, `compaction`, `retry`). Its docstring says the supervisor's real
settings must never reach a worker precisely because that packages list loads pi-agent-wave, whose entry
point fails closed without Herdr identity and kills the worker's ACP server. Exactly one call site writes
that file (`delegate_core.py:620`), so there is no second worker route that receives packages.

Two things follow that the options above were written without:

- Worker-side classification happens in **one** place, `retry.ts`. The three-places worry in the paragraph
  above was wrong even before `classify_launch_failure` was removed, and the extension lane only governs
  interactive sessions that opt in with `/failover enable <tier>`. A rehearsal therefore cannot exercise
  cross-lane agreement, because no input reaches two classifiers.
- The zero-packages invariant is **already guarded**, so it is not the gap it looks like. The matrix in
  `test/headless-pi-stdio.test.ts` seeds a real `settings.json` containing `packages: ['npm:x',
  '/abs/pi-agent-wave']`, calls `delegate_core.provider_runtime_environment(...)` against it, and asserts
  the materialised worker settings are `packages: []` with mode 600 and no symlink. That is a real call
  into the launcher, not a mirror of it, so a change forwarding the supervisor's settings would fail here
  rather than only at runtime.

What survives of the options: Option A's shared-corpus half stays declined for the reachability reason,
now with a stronger cause (shape separation plus the loader fact above); its preflight-branch half is
unaffected, because `preflight_provider_credential()` and `materialize_pi_credentials` are launcher code
and genuinely reachable. Option B is unchanged in principle — its three assertions are about the launcher's
credential seam and the installed CLI, none of which route through the extension — but it needs provider
calls, so it waits for both authorization and a provider health check. Option C is unaffected and parked.

## Verified environment facts (2026-09-09, this machine)

- `pi auth check --provider <p> --json --no-refresh` exists and works in the installed Pi 0.84.1:
  `openai-codex` returns `{"status":"ready","provider":"openai-codex","authType":"oauth"}` in 0.43s
  with exit 0. An earlier internal note claiming the command does not exist was wrong and is
  superseded by this run.
- Providers are reachable, not proxied away: `api.openai.com` and `api.anthropic.com` both answer
  401 without a key, which is a live server response.
- Four providers are configured in `~/.pi/agent/auth.json` (anthropic, claude-code, openai-codex,
  opencode-go) and `model-routing.jsonc` contains chains that span providers, so a cross-provider
  advance is in principle observable here rather than only theoretical.
- Without `--json` the command prints bare `ready`, which the production parser reads as
  `status=unparseable`. The flag is therefore load-bearing, and nothing pins that it stays.

## Option A — pin the untested lanes offline

Assert that the Python and TypeScript classifiers agree on one shared corpus of messages, and
exercise `preflight_provider_credential()` through an injected runner across its real branches:
ready passthrough, non-ready reason, unparseable output, and the `--json` flag being present.

Cost is small and deterministic, needs no network and no credential. It proves branch logic and
cross-lane agreement, which is genuinely what is missing. It does **not** prove anything about how a
real provider behaves, so per the rehearsal rule it proves the launch mechanism, not the computation.

## Option B — add an opt-in live preflight rehearsal

A gated check that runs the real `pi auth check` against configured providers and asserts three
things a fixture cannot: the live JSON keeps the shape the parser expects, `--no-refresh` leaves
`auth.json` byte-identical, and the preflight result actually selects the worker's auth shape.

Feasible today on evidence. It must stay opt-in because it reads credential state and touches the
network, and it must not run in the default suite; results are time-sensitive, so it reports rather
than asserts a fixed credential set. What it proves is the integration seam, which is where silent
drift would appear. What it cannot prove is failover itself, since nothing here emits a transient
error on demand.

## Option C — add a live failover rehearsal

Drive a real 429 or 5xx through a real provider and assert the operation advances to the next chain
model with a `fallbackReason`, sessions are not reused, and exclusions reset.

This is what Q4 originally pointed at, and its blockers are real rather than assumed: no provider
here emits a genuine transient failure on command, driving one anyway means manufacturing load
against a live account, and the project rule bars worker dispatch during verification. Faking the
provider would prove only the wiring, which Option A already covers more cheaply. Doing this
properly needs a decision to change that rule plus a controllable second provider, so it is not
offered as something to build now.

## Recommendation

A, plus B as an opt-in gate. Together they cover both places that currently have zero coverage, and
neither depends on a provider cooperating. C should stay parked unless the no-dispatch rule is
formally changed. The prerequisite this section used to name — whether a worker attempt consults the Pi
failover extension — is now answered: it does not. A rehearsal therefore exercises the supervisor's own
classification and the launcher's credential seam, and nothing else. Read the resolution above before
building any of the three.

## Resolution of the two open questions (2026-09-10, by reading and instrumenting)

Both questions this file opened with are now answered, and neither answer supports Option A as
originally written.

**The lanes are shape-separated, not agreeing and not diverging in practice.** `classifyFailure` in
`retry.ts` takes a bare string recorded by the supervisor; `classifyFailoverError` in
`lib/model-failover-native.mjs` takes an assistant message and only runs at all when
`role === "assistant"`, `stopReason === "error"` and `errorMessage` is non-empty
(`model-failover-native.mjs:109-112`). Grepping `errorMessage` across `index.ts`, `scripts/` and
`lib/` outside tests returns **nothing**: the text handed to `store.ts` comes from wrapper reasons
(`index.ts:276,501,564,605` build it from `reason` / `projectedFailure` plus a diagnostics path).
So there is no production input on which both classifiers decide the same failure.

There are kind-level differences on paper — `provider credential target changed`, `report-missing`,
`ACPX worker failed` and friends are transient in `retry.ts` and fall to the terminal default in the
native lane — but every one of those strings is emitted by launch or transport code
(`delegate_core.py:1061`, `delegate_core.py:1240`, `lib/projected-report.ts:39`, `index.ts:262`),
not by a provider response. They cannot arrive as an `errorMessage`. That makes the shared-corpus
half of Option A a test over unreachable combinations, which is declined rather than deferred: it
would pin paths no caller can take, in the same category as the owned-path normalisation case.

**The third lane is dead code.** `classify_launch_failure` and its `TRANSIENT_LAUNCH_PATTERNS` have
no caller anywhere. The only hits are the definition itself (`delegate_core.py:328`, `:340`, the
loop at `:341`) and copies of that file under `agent-output/`. Nothing in `scripts/`, `lib/`,
`test/` or the README invokes it. It is therefore not a lane that could drift, and the right change
is removal, not a guard — see the decision request at the end.

Correction of record: an earlier note in this file's draft lineage described a
`check-unavailable: Pi auth check returned contaminated provider selection` result. The string
`contaminated` does not appear anywhere in this repository. That observation did not come from this
code and is withdrawn; do not build on it.

## What is actually untested, and what gets built

`preflight_provider_credential()` is live on every Pi worker launch — called at
`delegate_core.py:509` from the agent preflight and at `:535` from `materialize_pi_credentials`,
which `:607` calls while building an attempt — and it has no test at any level. Verified by grepping
`test/` for `auth check`, `--no-refresh`, `provider_preflight_environment`,
`preflight_provider_credential` and `materialize_pi_credentials`: zero hits. The three-way
`agent_for_model` / `agentForModel` / `selectAcpAgent` agreement that the development contract asks
for is already pinned (`test/provider-credential-snapshot.test.ts`, `test/acpx-doctor.test.ts`,
`test/acpx-routing.test.ts`), so that is not duplicated here.

### Built: `test/credential-preflight.test.ts` with `test/support/credential-preflight-driver.py`

Status: implemented, 8 tests, green from the package directory and the repository root.

Two things the driver deliberately does not fake: the injected runner is passed to the production
function as `command_runner`, so the real branches execute rather than a re-implementation of them;
and every key in a fixture is a literal placeholder, never material taken from a real store.

The `no-usable-credential` and override cases run with a failing `print-api-key` so that consulting
it at all is observable — the override case asserts exactly one runner call, which is what proves a
seeded live entry is used directly instead of being looked up.

### Built: Option B as `PI_RUN_LIVE_PREFLIGHT`-gated, skipped by default

Status: implemented in `test/credential-preflight-live.test.ts`, verified both ways.

With the gate off the file reports 1 test, 0 pass, **1 skipped** — it does not fail, and it does not
quietly run. With `PI_RUN_LIVE_PREFLIGHT=1` it ran in 2.2 seconds and reported the machine's four
configured providers rather than an assumed list:

| Provider | authType | reason | store unchanged |
| --- | --- | --- | --- |
| anthropic | oauth | — | yes |
| claude-code | unknown | `credentials_not_configured` | yes |
| openai-codex | oauth | — | yes |
| opencode-go | api_key | — | yes |

### Guards were mutated, not just written

Every guard here was checked by breaking the thing it protects and requiring a failure, then
restoring `scripts/delegate_core.py` from git.

| Break | Result |
| --- | --- |
| drop `--json` and `--no-refresh` from the argv | 2 tests fail |
| treat `status: "ready"` as usable at exit code 1 | 1 fails |
| let the preflight inherit the caller's `HOME` / `PI_CODING_AGENT_DIR` | 1 fails |
| make a not-ready check block a launch that does hold a credential | 1 fails |

The same break applied to the live test is stronger evidence than the offline one: with `--json`
removed, the real Pi CLI returns plain text, the probe reports `status=unparseable exit=0`, and the
live test fails. That confirms against the installed tool — not only against a fixture — that the
flag is load-bearing and that dropping it degrades every launch's credential answer to unknown.

### Gate state after this slice

Node completion gate: **463 tests, 451 pass, 0 fail, 12 skipped**, identical from the repository
root and the package directory (it was 454 / 443 / 0 / 11 before; the nine added tests are these
two files, and the twelfth skip is the live probe). Bun package gate: 46 pass, 0 fail.
`npm run typecheck`: exit 0. `git diff --check`: clean. Test files are excluded from the npm
tarball, so no fixture or driver enters the published artifact.

### Declined

The shared-corpus agreement test, for the reachability reason above. Option C stays parked for the
reasons already in this file.

## Decision taken

Asked on 2026-09-10 whether to remove the unreachable lane; the answer was to remove it, so
`classify_launch_failure` and `TRANSIENT_LAUNCH_PATTERNS` are gone — 18 lines, `scripts/delegate_core.py`.
Verified before deleting: the only references anywhere were the definition, its own loop, and
frozen copies of the file under `agent-output/` (generated evidence, which is not edited and is not
packaged). Verified after deleting: the file still parses, `re` remains in use by five other sites
so the import stays, and the completion gate is unchanged at 463 tests / 451 pass / 0 fail /
12 skipped. Nothing was counting on that code, which is the point of it being unreachable.

The reference at the top of this file stays as written and is annotated rather than rewritten,
because it is the reason the check happened.
