# PRD: Headless Pi ACP Stdio Lifecycle

## Overview

The real Codex and Claude headless paths pass, but the real Pi path failed three bounded attempts while `acpx sessions ensure` reported `Cannot call write after a stream was destroyed`. The same Pi adapter passed the existing foreground lifecycle matrix and Herdr presentation path. The bounded foreground comparison proved the initial matrix model was not advertised by the isolated Pi ACP server; an advertised model ensured successfully. The detached stream error was a follow-on failure after model rejection, not evidence that Herdr or a terminal is required.

## Goals

- Reproduce foreground versus detached Pi ACP behavior with one harmless session.
- Preserve ACP JSON-RPC stdio for the full worker lifetime without Herdr or a terminal UI.
- Make one corrected real Pi headless attempt after the mechanism test passes.

## User Stories

### US-001: Rehearse the exact detached launch mechanism

**Description:** As a maintainer, I want a deterministic foreground/detached comparison so that the failure is fixed at the process boundary rather than retried blindly.

**Acceptance Criteria:**

- [x] A persisted fixture under `extensions/pi-agent-wave/test/support/` runs the exact AgentFS → acpx-worker → ACPX Pi argv in foreground and detached modes against temporary homes and records stdin/stdout/stderr/session-lifetime differences without provider response bodies.
- [x] `extensions/pi-agent-wave/test/headless-pi-stdio.test.ts` proves argv, environment assignment, process-group lifetime, file-descriptor ownership, result persistence, and exit propagation for a fake Pi ACP server before any real retry.
- [x] One bounded real `acpx pi sessions ensure/status/close` foreground-versus-detached diagnostic identifies whether the failure is adapter, environment, or descriptor lifetime; sanitized evidence is stored under `agent-output/air-headless-orchestration/pi-stdio/`.

### US-002: Harden detached diagnostics and select an advertised Pi model

**Description:** As a Pi worker, I want model incompatibility and early process exit reported directly so that a route error is not misdiagnosed as a Herdr/stdio requirement.

**Acceptance Criteria:**

- [x] `delegate_core.py` persists detached stdout/stderr paths and the child PID, launches every headless adapter through the same private non-visible PTY supervisor, and fails immediately with bounded diagnostics if the worker exits before `acpx-worker.ts` writes its result, while `start` still returns promptly to Air. Because the first detached Pi ensure consistently returns the ACPX runtime transient `Cannot call write after a stream was destroyed` while the same session succeeds on the next foreground invocation, `acpx-worker.ts` may retry session ensure once for that exact generic ACPX transient and no other ensure failure.
- [x] Real-matrix fixtures use a model advertised by the tested isolated Pi ACP adapter; the production selection and private-PTY supervisor remain provider-neutral and do not add a Pi-specific worker branch.
- [x] The fix does not add Herdr, a visible terminal, synthetic evidence, daemon scope, or a provider-specific branch; a focused fake test proves exactly one same-session retry for the stream-destroyed transient and fail-closed behavior for every other ensure error. Fake headless lifecycle, cancellation, and cleanup tests pass with no leaked process.

### US-003: Re-run one real Pi headless proof

**Description:** As a release owner, I want one corrected real Pi attempt so that Phase 1 can continue without exceeding the original circuit breaker.

**Acceptance Criteria:**

- [x] After US-001 and US-002 pass, one real Pi headless report/settlement/cleanup run succeeds with zero AgentFS violations and no Herdr identity.
- [x] The Pi evidence is source-digest-bound and joins the already-passing Codex and Claude headless evidence under `agent-output/air-headless-orchestration/final-matrix/`.
- [x] Cleanup proves no detached supervisor, ACPX queue owner, pi-acp process, AgentFS process, temporary run directory, or token remains.

## Functional Requirements

- FR-1: The fix must preserve ACP stdio ownership for the complete Pi adapter session.
- FR-2: Start must remain non-blocking to the Air-controlled Pi supervisor.
- FR-3: No fourth blind retry is allowed; the next real attempt follows passing mechanism proof.
- FR-4: Codex, Claude, cancellation, settlement, and cleanup behavior must remain unchanged.

## Non-Goals

- Changing models, providers, Pi routing, ACPX or AgentFS versions.
- Introducing the Phase 2 daemon.
- Using Herdr or a visible/user-managed terminal as the headless fix. A private implementation-owned PTY is allowed only when applied uniformly to all headless adapters and proven leak-free.

## Success Metrics

- Deterministic mechanism tests pass.
- One corrected real Pi headless attempt passes.
- No process or temporary resource leaks.

### US-004: Stop poisoning the worker Pi with the supervisor's extension list

**Description:** As a headless Pi worker, I want an execution-only Pi agent configuration so that supervisor extensions cannot fail-closed inside the worker and kill its ACP server.

**Root cause (proven by bisection, 2026-08-31):** `provider_runtime_environment` symlinks the real `~/.pi/agent/settings.json` into the worker's `PI_CODING_AGENT_DIR`. The worker Pi launched by `pi-acp` therefore loads the supervisor's full `packages` list, including the pi-agent-wave extension from the read-only original workspace, whose entry point fails closed without Herdr identity. The worker Pi dies during initialization and acpx surfaces `Cannot call write after a stream was destroyed`. A bounded `acpx pi sessions ensure` matrix against temporary homes proved: `packages: []` → ensured; only the pi-agent-wave package → stream destroyed; all packages except pi-agent-wave → ensured. AgentFS, the private PTY supervisor, `start_new_session` detachment, and the minimal environment were each individually exonerated by the same matrix. Sanitized evidence: `agent-output/air-headless-orchestration/pi-stdio/root-cause-bisection.json`.

**Acceptance Criteria:**

- [ ] `provider_runtime_environment` no longer symlinks the supervisor's `settings.json`; it writes a synthesized private (mode 600) worker `settings.json` carrying only `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `compaction`, and `retry` from the real settings when present, with `packages: []`, and registers no `provider_links` entry for it (`verify_provider_links` requires symlinks).
- [ ] `test/acpx-real-matrix.test.ts` stops linking the real `settings.json` and uses the same execution-only synthesis so the real matrix exercises the corrected worker configuration.
- [ ] A focused test proves the synthesized worker settings: empty `packages`, copied defaults, mode 600, no symlink, and no `provider_links` registration.
- [ ] A bounded rehearsal of the exact production stack (AgentFS `run` + `headless_supervisor.py` PTY + `start_new_session` + minimal environment + synthesized settings) returns `session_ensured` with exit 0.

## Verification Status

- Foreground unadvertised model: rejected with ACPX `RUNTIME` and an explicit model-advertisement diagnostic.
- Foreground advertised model `anthropic/claude-fable-5`: `session_ensured`, exit 0.
- Sanitized evidence: `agent-output/air-headless-orchestration/pi-stdio/diagnostic.json`, `agent-output/air-headless-orchestration/pi-stdio/root-cause-bisection.json`.
- Full production stack (AgentFS + PTY supervisor + detachment + minimal env + real settings symlink): reproduced `Cannot call write after a stream was destroyed` deterministically.
- Bisection: the failure follows the real `settings.json` `packages` entry for the original-workspace pi-agent-wave extension and nothing else.

## Open Questions

None.

## Decision

**DONE (2026-08-31).** Root cause: the worker Pi loaded the supervisor's symlinked `settings.json` and its `packages` list loaded the original-workspace pi-agent-wave extension, whose Herdr fail-closed gate killed the worker's ACP server — never a stdio, PTY, AgentFS, or detachment defect. After the US-004 fix (execution-only synthesized worker settings), the real Pi headless matrix passed alongside Codex and Claude in all three suites (lifecycle cancel/reconnect, production, headless), with evidence bound to the final production source digest under both `final-matrix/` locations. US-001 through US-004 are complete.
