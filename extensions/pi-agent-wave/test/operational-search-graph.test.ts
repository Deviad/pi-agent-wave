import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideTransition, graphDefinition } from "../graph-core.ts";

describe("operational search graph", () => {
	test("starts with writable source search and has no planning node", () => {
		const graph = graphDefinition("operations");
		assert.equal(graph.initialNode, "source_search");
		assert.deepEqual(graph.nodes.map((node) => node.name), ["source_search", "thinker_synthesize", "audit"]);
		assert.equal(graph.nodes[0]?.role, "searcher");
		assert.equal(graph.nodes[0]?.readOnly, false);
	});

	test("joins sources before synthesis and audit", () => {
		const waiting = decideTransition({ runId: "run", graph: "operations", currentNode: "source_search", round: 1, fixIteration: 0, status: "active", allComplete: false, verdict: "DONE" });
		assert.equal(waiting.kind, "stay");
		const synthesis = decideTransition({ ...waiting, runId: "run", graph: "operations", currentNode: "source_search", status: "active", allComplete: true, verdict: "DONE" });
		assert.equal(synthesis.nextNode, "thinker_synthesize");
		const audit = decideTransition({ ...synthesis, runId: "run", graph: "operations", currentNode: "thinker_synthesize", status: "active", allComplete: true, verdict: "DONE" });
		assert.equal(audit.nextNode, "audit");
		const terminal = decideTransition({ ...audit, runId: "run", graph: "operations", currentNode: "audit", status: "active", allComplete: true, verdict: "PASS" });
		assert.equal(terminal.kind, "terminal");
	});
});
