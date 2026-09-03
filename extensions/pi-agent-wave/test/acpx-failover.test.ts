import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAcpxAttemptIdentity, parseAcpAgent } from "../lib/acpx-types.ts";
import { sameAttemptForRepair } from "../lib/acpx-settlement.ts";

describe("ACPX attempt boundaries", () => {
	const base = { runId: "run", operationId: "op", role: "implementer", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: parseAcpAgent("codex"), herdrAgent: "herdr-worker", herdrTabId: "tab-worker", herdrPaneId: "pane-worker" };

	test("same-model retry and cross-model fallback never reuse ACPX or AgentFS sessions", () => {
		const first = createAcpxAttemptIdentity(base);
		const retry = createAcpxAttemptIdentity({ ...base, transientAttempt: 1 });
		const fallback = createAcpxAttemptIdentity({ ...base, modelAttempt: 1, selectedModel: "claude-code/claude-opus-5", agent: parseAcpAgent("claude") });
		assert.notEqual(first.sessionName, retry.sessionName);
		assert.notEqual(first.agentFsSession, retry.agentFsSession);
		assert.notEqual(first.sessionName, fallback.sessionName);
		assert.notEqual(first.agent, fallback.agent);
	});

	test("report repair reuses only the current operation attempt", () => {
		const first = createAcpxAttemptIdentity(base);
		const repair = createAcpxAttemptIdentity(base);
		const retry = createAcpxAttemptIdentity({ ...base, transientAttempt: 1 });
		assert.equal(sameAttemptForRepair(first, repair), true);
		assert.equal(sameAttemptForRepair(first, retry), false);
	});
});
