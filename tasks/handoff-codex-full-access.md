# Handoff: Codex workers cannot run commands inside AgentFS on macOS

**Recorded:** 2026-10-04
**Found by:** the Codex live checks in `tasks/handoff-host-services.md` §6 and `tasks/handoff-codex-trust-selfwrite.md`.
**Affects:** every Codex worker on macOS. Pi and Claude workers are unaffected.
**Not a PRD.** This file is a work order. Read it with `AGENTS.md` (the Codex `sandbox-exec` note) and
`scripts/delegate_core.py:provider_runtime_environment`.

**Status:** opened 2026-10-04; the operator decided the same day to set Codex workers to full access inside AgentFS;
implemented the same day, every criterion checked below.

## 1. Cause (verified 2026-10-04, macOS 26.7.1, `agentfs v0.6.4`, `codex-cli 0.154.0`, `codex-acp 1.10.0`)

- macOS refuses to apply a sandbox inside a process that is already sandboxed: `sandbox-exec -p '(version 1)(allow
  default)' /usr/bin/true` exits 0 on the host and exits 71 with `sandbox-exec: sandbox_apply: Operation not
  permitted` inside `agentfs run --no-default-allows --allow <dir>`.
- Codex wraps each command in its own Seatbelt sandbox in its default modes, so every command fails inside AgentFS
  with that message; the workers of `run_74f0fb3e`, `run_58bd8c47`, `run_122b19d2` and `run_5a50f5c7` all hit it.
- `codex-acp` 1.10.0 (`@agentclientprotocol/codex-acp`, which `acpx` launches) chooses its initial session mode from
  the environment variable `INITIAL_AGENT_MODE`. Its modes: `read-only` and `agent` (the default) use the
  `workspace-write` sandbox; `agent-full-access` uses `danger-full-access` with approval policy `never`. Codex's own
  help describes `danger-full-access` as "intended solely for running in environments that are externally
  sandboxed".

## 2. Change

`provider_runtime_environment` adds `INITIAL_AGENT_MODE=agent-full-access` to the environment of a Codex worker only.
The worker environment reaches the agent (verified live for Codex in `handoff-host-services.md` §6), so Codex then
runs commands without its own sandbox, confined by AgentFS like Pi and Claude workers.

Consequences, accepted by the operator: Codex commands get network access, as Pi and Claude commands already have;
the AgentFS limits recorded in `AGENTS.md` (`/tmp` writes reach the host, every host file is readable) now apply to
Codex commands as they do to the others; Codex asks for no approvals, which graph workers could not answer anyway
(`--non-interactive-permissions fail`).

The variable is internal to `codex-acp`; a later adapter version may rename it. The live criterion is what proves it
on the installed version.

## 3. Acceptance criteria

- [x] A Codex worker's environment carries `INITIAL_AGENT_MODE=agent-full-access`; Pi and Claude workers' do not.
  Proof: a test of `provider_runtime_environment`, red before the change. Evidence: `test/codex-trust-selfwrite.test.ts`
  "only a Codex worker starts in codex-acp's agent-full-access mode", red on `2e4240f` (both models `null`). It
  exercises Codex and Claude; the Pi path is not run in the test, because it materializes credentials through the
  real `pi` command, and the variable is set only under `agent == "codex"`.
- [x] One live Codex attempt runs `node` inside AgentFS and settles with empty `postSettlementFailures`. Proof: run id,
  the command output in the answer, and the collect result. Authorized by the operator. `run_2646d844-cb77-4f3d-911a-e738dcec3b21`,
  `op_ebea2c69-3024-4baa-8f1e-16b50917af4d`, `openai-codex/gpt-5.6-luna`: the answer is `node v24.21.0` and
  `sandbox=macos-sandbox` (the host's Node is v24.21.0), where the four earlier Codex workers got
  `sandbox_apply: Operation not permitted`; exit 0, settled, `postSettlementFailures` `[]`, cleanup audit passed,
  one tolerated `config.toml` trust entry. Evidence: `agent-output/live-codex-full-access-20261004/`.
- [x] `AGENTS.md` (the Codex `sandbox-exec` note), `specification.md` and the README describe the setting and why.
  Evidence: the `AGENTS.md` result-contract entry, spec §5.2 step 3, README "Adapters".
- [x] Gate green with counts from the run made. 2026-10-04 on `2e4240f` plus this change: 689 tests, 678 passed, 0
  failed, 11 skipped; `git diff --check` clean; typecheck exit 0. Bun package checks not run: `bun` is not installed
  on this host.
