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
formally changed. Before any of the three, resolve the open question above about whether a worker
attempt actually consults the Pi failover extension, because that determines whether a rehearsal
would exercise failover or only the supervisor's own classification.

## What is needed from the user

One choice: A only, A plus B, B only, or park the whole thing. If A or B is chosen, the shared
corpus and the gate variable get specified in this file before any test is written, and the
third-lane question gets answered by reading rather than by assumption.