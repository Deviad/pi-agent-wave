import { describe, expect, test } from "./harness.ts";
import { decideTransition } from "../graph-core.ts";
import type { TransitionInput } from "../types.ts";

function build(node: TransitionInput["currentNode"], verdict?: string, round = 1, fixIteration = 0): TransitionInput {
	return { runId: "run", graph: "build", currentNode: node, round, fixIteration, status: "active", allComplete: true, verdict };
}

describe("build graph", () => {
	test("follows plan, implement join, review, test, and audit", () => {
		expect(decideTransition(build("thinker_plan")).nextNode).toBe("implement");
		expect(decideTransition({ ...build("implement"), allComplete: false }).kind).toBe("stay");
		expect(decideTransition(build("implement")).nextNode).toBe("review");
		expect(decideTransition(build("review", "PASS")).nextNode).toBe("test");
		expect(decideTransition(build("test", "GREEN")).nextNode).toBe("audit");
		expect(decideTransition(build("audit", "PASS")).kind).toBe("terminal");
	});

	test("review feedback loops twice then blocks", () => {
		const first = decideTransition(build("review", "FAIL", 1, 0));
		const second = decideTransition(build("review", "FAIL", 1, 1));
		const capped = decideTransition(build("review", "FAIL", 1, 2));
		expect([first.nextNode, first.fixIteration]).toEqual(["implement", 1]);
		expect([second.nextNode, second.fixIteration]).toEqual(["implement", 2]);
		expect(capped.kind).toBe("blocked");
	});

	test("tester NOT_OK always returns through implement and respects three rounds", () => {
		const retry = decideTransition(build("test", "NOT_OK", 1, 1));
		expect([retry.nextNode, retry.round, retry.fixIteration]).toEqual(["implement", 2, 0]);
		expect(decideTransition(build("test", "NOT_OK", 3, 0)).kind).toBe("blocked");
	});
});

describe("research graph", () => {
	test("splits, joins read-only searchers, and synthesizes", () => {
		const split: TransitionInput = { runId: "run", graph: "research", currentNode: "thinker_split", round: 1, fixIteration: 0, status: "active", allComplete: true };
		expect(decideTransition(split).nextNode).toBe("search");
		expect(decideTransition({ ...split, currentNode: "search", allComplete: false }).kind).toBe("stay");
		expect(decideTransition({ ...split, currentNode: "search" }).nextNode).toBe("thinker_synthesize");
		expect(decideTransition({ ...split, currentNode: "thinker_synthesize" }).kind).toBe("terminal");
	});
});
