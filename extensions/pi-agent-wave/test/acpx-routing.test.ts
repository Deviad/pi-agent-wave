import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ACPX_AGENTS, ACPX_STATES, acpxAttemptKey, createAcpxAttemptIdentity, parseAcpAgent, parseAcpxState, sameAcpxAttempt } from "../lib/acpx-types.ts";
import { acpxModelArgument, selectAcpAgent } from "../lib/acpx-select.ts";
import { resolveAcpxPlan } from "../scripts/acpx-plan.ts";

describe("ACPX routing and attempt identity", () => {
	test("models finite immutable delegation-context Value Objects", () => {
		assert.deepEqual(ACPX_AGENTS, ["pi", "codex", "claude"]);
		assert.deepEqual(ACPX_STATES, ["idle", "alive", "no-session"]);
		assert.throws(() => parseAcpAgent("gemini"), /unsupported ACPX agent/);
		assert.throws(() => parseAcpxState("running"), /unsupported ACPX state/);
		assert.equal(parseAcpAgent("codex"), parseAcpAgent("codex"));
		assert.equal(Object.isFrozen(ACPX_AGENTS), true);
	});

	test("selects the ACP agent once from the frozen model provider", () => {
		assert.equal(selectAcpAgent("openai-codex/gpt-5.6-sol"), "codex");
		assert.equal(selectAcpAgent("claude-code/claude-opus-5"), "claude");
		assert.equal(selectAcpAgent("alibaba/qwen3.8-max"), "pi");
		assert.equal(selectAcpAgent("opencode-go/glm-5.2"), "pi");
		assert.equal(acpxModelArgument("openai-codex/gpt-5.6-sol", "codex"), "gpt-5.6-sol");
		assert.equal(acpxModelArgument("claude-code/claude-opus-5", "claude"), "claude-opus-5");
		assert.equal(acpxModelArgument("alibaba/qwen3.8-max", "pi"), "alibaba/qwen3.8-max");
	});

	test("uses the shared TypeScript plan for agent, session, and Herdr identity", () => {
		const plan = resolveAcpxPlan({ runId: "run", operationId: "op", role: "reviewer", modelAttempt: 1, transientAttempt: 0, selectedModel: "claude-code/claude-opus-5", herdrAgent: "herdr-reviewer", herdrTabId: "tab-reviewer", herdrPaneId: "pane-reviewer" });
		assert.equal(plan.agent, "claude");
		assert.equal(plan.herdrAgent, "herdr-reviewer");
		assert.equal(plan.herdrTabId, "tab-reviewer");
		assert.equal(plan.herdrPaneId, "pane-reviewer");
	});

	test("creates a headless plan without synthetic Herdr identity", () => {
		const plan = resolveAcpxPlan({ runId: "run", operationId: "op", role: "reviewer", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", transport: "headless" });
		assert.deepEqual(plan.presentation, { kind: "headless" });
		assert.equal(plan.herdrAgent, null);
		assert.equal(plan.herdrTabId, null);
		assert.equal(plan.herdrPaneId, null);
	});

	test("creates immutable unique sessions per operation attempt", () => {
		const base = { runId: "run_1", operationId: "op_1", role: "implementer", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: parseAcpAgent("codex"), herdrAgent: "herdr-worker", herdrTabId: "tab-worker", herdrPaneId: "pane-worker" };
		const first = createAcpxAttemptIdentity(base);
		const equal = createAcpxAttemptIdentity(base);
		const retry = createAcpxAttemptIdentity({ ...base, transientAttempt: 1 });
		const fallback = createAcpxAttemptIdentity({ ...base, modelAttempt: 1, selectedModel: "claude-code/claude-opus-5", agent: parseAcpAgent("claude") });
		assert.equal(Object.isFrozen(first), true);
		assert.equal(sameAcpxAttempt(first, equal), true);
		assert.notEqual(first.sessionName, retry.sessionName);
		assert.notEqual(first.sessionName, fallback.sessionName);
		assert.notEqual(acpxAttemptKey(first), acpxAttemptKey(retry));
		assert.match(first.sessionName, /^dg-/);
		assert.equal(first.agentFsSession, first.sessionName);
	});
});
