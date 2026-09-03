import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseAcpxNdjson } from "../lib/acpx-events.ts";
import { reconcileAcpxSettlement, reconcileAcpxSettlementSummary } from "../lib/acpx-settlement.ts";

const completed = parseAcpxNdjson([
	JSON.stringify({ jsonrpc: "2.0", id: "r", method: "session/prompt", params: { sessionId: "s", prompt: [] } }),
	JSON.stringify({ jsonrpc: "2.0", id: "r", result: { stopReason: "end_turn" } }),
].join("\n"));

const base = {
	processExitCode: 0,
	events: completed,
	acpxState: "idle" as const,
	herdrVisible: true,
	identityMatches: true,
	reportValid: true,
	graphStatus: "running" as const,
	ledgerValid: true,
};

describe("fail-closed ACPX settlement", () => {
	test("completes only when every independent signal agrees", () => {
		assert.deepEqual(reconcileAcpxSettlement(base), { outcome: "completed", blockers: [] });
	});

	for (const [name, patch, blocker] of [
		["Herdr", { herdrVisible: false }, "Herdr identity"],
		["identity", { identityMatches: false }, "identity mismatch"],
		["report", { reportValid: false }, "report audit"],
		["graph", { graphStatus: "pending" as const }, "graph operation"],
		["ledger", { ledgerValid: false }, "ledger audit"],
		["session", { acpxState: "no-session" as const }, "cannot settle"],
	] as const) {
		test(`blocks completion when ${name} disagrees`, () => {
			const decision = reconcileAcpxSettlement({ ...base, ...patch });
			assert.equal(decision.outcome, "blocked");
			assert.ok(decision.blockers.some((item) => item.includes(blocker)));
		});
	}

	test("settles headless work from verified presentation identity without Herdr visibility", () => {
		const { herdrVisible: _herdrVisible, ...transportNeutral } = base;
		const headless = { ...transportNeutral, transport: "headless" as const, presentationVerified: true };
		assert.deepEqual(reconcileAcpxSettlement(headless), { outcome: "completed", blockers: [] });
		assert.equal(reconcileAcpxSettlement({ ...headless, presentationVerified: false }).outcome, "blocked");
	});

	test("requires AgentFS export and zero violations in supervisor settlement summary", () => {
		const summary = { processExitCode: 0, terminalKind: "completed" as const, acpxState: "alive" as const, herdrVisible: true, identityMatches: true, reportValid: true, graphStatus: "running" as const, ledgerValid: true, agentFsExported: true, agentFsViolationCount: 0 };
		assert.equal(reconcileAcpxSettlementSummary(summary).outcome, "completed");
		assert.equal(reconcileAcpxSettlementSummary({ ...summary, agentFsExported: false }).outcome, "blocked");
		assert.equal(reconcileAcpxSettlementSummary({ ...summary, agentFsViolationCount: 1 }).outcome, "blocked");
	});

	test("keeps nonterminal work running and maps process failure independently", () => {
		assert.equal(reconcileAcpxSettlement({ ...base, events: completed.slice(0, 1) }).outcome, "running");
		assert.deepEqual(reconcileAcpxSettlement({ ...base, processExitCode: 17 }), { outcome: "failed", blockers: ["ACPX process exited 17"] });
	});
});
