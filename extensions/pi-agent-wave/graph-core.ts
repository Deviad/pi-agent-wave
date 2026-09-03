import type {
	GraphDefinition,
	GraphKind,
	NodeName,
	TransitionDecision,
	TransitionInput,
} from "./types.ts";

export const BUILD_GRAPH: GraphDefinition = {
	name: "build",
	initialNode: "thinker_plan",
	nodes: [
		{ name: "thinker_plan", role: "thinker", fanOut: false, readOnly: true },
		{ name: "implement", role: "implementer", fanOut: true, readOnly: false },
		{ name: "review", role: "reviewer", fanOut: false, readOnly: true },
		{ name: "test", role: "tester", fanOut: false, readOnly: true },
		{ name: "audit", role: "auditor", fanOut: false, readOnly: true },
	],
};

export const RESEARCH_GRAPH: GraphDefinition = {
	name: "research",
	initialNode: "thinker_split",
	nodes: [
		{ name: "thinker_split", role: "thinker", fanOut: false, readOnly: true },
		{ name: "search", role: "searcher", fanOut: true, readOnly: true },
		{ name: "thinker_synthesize", role: "thinker", fanOut: false, readOnly: true },
	],
};

export const OPERATIONS_GRAPH: GraphDefinition = {
	name: "operations",
	initialNode: "source_search",
	nodes: [
		{ name: "source_search", role: "searcher", fanOut: true, readOnly: false },
		{ name: "thinker_synthesize", role: "thinker", fanOut: false, readOnly: true },
		{ name: "audit", role: "auditor", fanOut: false, readOnly: true },
	],
};

/** Returns the immutable graph definition stored with each run. */
export function graphDefinition(kind: GraphKind): GraphDefinition {
	if (kind === "build") return BUILD_GRAPH;
	if (kind === "research") return RESEARCH_GRAPH;
	return OPERATIONS_GRAPH;
}

function decision(
	input: TransitionInput,
	kind: TransitionDecision["kind"],
	nextNode: NodeName,
	replyTo: string,
	reason: string,
	changes: Partial<Pick<TransitionDecision, "round" | "fixIteration">> = {},
): TransitionDecision {
	return {
		kind,
		nextNode,
		round: changes.round ?? input.round,
		fixIteration: changes.fixIteration ?? input.fixIteration,
		replyTo,
		reason,
	};
}

/** Computes one deterministic graph edge from current state and a canonical verdict. */
export function decideTransition(input: TransitionInput): TransitionDecision {
	if (!input.allComplete) {
		return decision(input, "stay", input.currentNode, `join:${input.currentNode}`, "waiting for node join");
	}

	const verdict = input.verdict?.toUpperCase();
	if (input.graph === "research") {
		switch (input.currentNode) {
			case "thinker_split":
				return decision(input, "advance", "search", "search", "research plan split accepted");
			case "search":
				return decision(input, "advance", "thinker_synthesize", "thinker_synthesize", "all searchers completed");
			case "thinker_synthesize":
				return decision(input, "terminal", "terminal", "user", "research synthesis completed");
			default:
				return decision(input, "blocked", input.currentNode, "user", `invalid research node ${input.currentNode}`);
		}
	}

	if (input.graph === "operations") {
		switch (input.currentNode) {
			case "source_search":
				return verdict === "DONE"
					? decision(input, "advance", "thinker_synthesize", "thinker_synthesize", "all source searches completed")
					: decision(input, "blocked", input.currentNode, "user", `source search verdict ${verdict ?? "missing"}`);
			case "thinker_synthesize":
				return verdict === "DONE"
					? decision(input, "advance", "audit", "audit", "operational synthesis completed")
					: decision(input, "blocked", input.currentNode, "user", `synthesis verdict ${verdict ?? "missing"}`);
			case "audit":
				return verdict === "PASS"
					? decision(input, "terminal", "terminal", "user", "operational evidence audit passed")
					: decision(input, "blocked", input.currentNode, "user", `audit verdict ${verdict ?? "missing"}`);
			default:
				return decision(input, "blocked", input.currentNode, "user", `invalid operations node ${input.currentNode}`);
		}
	}

	switch (input.currentNode) {
		case "thinker_plan":
			return decision(input, "advance", "implement", "implement", "plan accepted");
		case "implement":
			return decision(input, "advance", "review", "review", "all implementers completed");
		case "review":
			if (verdict === "PASS") {
				return decision(input, "advance", "test", "test", "review passed");
			}
			if (verdict === "FAIL") {
				if (input.fixIteration >= 2) {
					return decision(input, "blocked", input.currentNode, "user", "review fix-iteration cap reached");
				}
				return decision(input, "advance", "implement", "implement", "review feedback requires fixes", {
					fixIteration: input.fixIteration + 1,
				});
			}
			return decision(input, "blocked", input.currentNode, "user", `unsupported review verdict ${verdict ?? "missing"}`);
		case "test":
			if (verdict === "GREEN") {
				return decision(input, "advance", "audit", "audit", "tests passed");
			}
			if (verdict === "NOT_OK") {
				if (input.round >= 3) {
					return decision(input, "blocked", input.currentNode, "user", "semantic implementation-round cap reached");
				}
				return decision(input, "advance", "implement", "implement", "tester feedback requires a new implementation round", {
					round: input.round + 1,
					fixIteration: 0,
				});
			}
			return decision(input, "blocked", input.currentNode, "user", `unsupported test verdict ${verdict ?? "missing"}`);
		case "audit":
			return verdict === "PASS"
				? decision(input, "terminal", "terminal", "user", "evidence audits passed")
				: decision(input, "blocked", input.currentNode, "user", `audit verdict ${verdict ?? "missing"}`);
		default:
			return decision(input, "blocked", input.currentNode, "user", `invalid build node ${input.currentNode}`);
	}
}
