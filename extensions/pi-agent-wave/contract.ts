import type { FrozenPolicy, GraphKind } from "./types.ts";

/** Renders the complete frozen per-role route preview before dispatch. */
export function policyPreview(policy: FrozenPolicy | undefined): string {
	if (!policy || policy.routes.length === 0) return "";
	const lines = policy.routes.map((route) => {
		const promotion = route.promoted ? `; promoted-from=${route.promotedFrom ?? "default"}` : "";
		const promotionReason = route.promotionReason ? `; promotion-reason=${route.promotionReason}` : "";
		return `${route.role}: tier=${route.tier}; chain=${route.chain.join(" -> ")}; thinking=${route.thinking}; session=${route.session}; capability-floor=${route.capabilityFloor || "none"}; source=${route.selectionSource}${promotion}${promotionReason}`;
	});
	return `\n\nFrozen model policy (digest ${policy.digest}; input=${JSON.stringify(policy.input)}):\n${lines.join("\n")}`;
}

/** Returns the complete supervisor contract injected by the /delegate command. */
export function supervisorContract(runId: string, graph: GraphKind, task: string, policy?: FrozenPolicy): string {
	const topology = graph === "build"
		? "Thinker -> parallel Implementers (join) -> Reviewer -> Tester -> evidence audits. Reviewer FAIL returns to Implementers (max 2 fix iterations per round). Tester NOT_OK returns through Implementers and Reviewer (max 3 rounds)."
		: graph === "research"
			? "Thinker split -> parallel read-only Searchers (join) -> Thinker synthesis."
			: "Parallel writable Source Searchers (join) -> Thinker synthesis -> evidence audit. Each source worker runs its persisted structured argv before any other execution command.";
	return `Delegate Graph run ${runId} started for: ${task}\n\n${topology}${policyPreview(policy)}\n\nAct as supervisor using only delegate_graph operations for worker lifecycle; never render or execute the delegate launcher with bash or another shell tool, and never use the global delegate tool. The loop for every pending operation: (1) op=next returns pending operations with frozen routes. (2) op=dispatch with runId and operationId; the extension owns transport, private files, launch and registration. (3) op=collect with the same operationId; the extension waits for the worker, settles the attempt from evidence, and returns the retained answer (bounded), its VERDICT line when the node has one, and a decide template. (4) op=decide with decision accepted or rejected and a reason. Nodes review, test, audit and source_search take verdict from the answer's final VERDICT line (PASS/FAIL, GREEN/NOT_OK, PASS/FAIL, DONE/BLOCKED); thinker_plan and thinker_split take payload.slices, each with id, name and task (and ownedPaths on the build graph, disjoint across slices), derived from the answer: every slice becomes one parallel worker at the next node. A coding or operational candidate needs op=integrate for its operationId before op=decide accepted. (5) op=next again; repeat until terminal. op=record is refused on runtime-v1 runs; cancellation is op=cancel, which stops the worker and records the operation cancelled. A failed or interrupted attempt is replaced with op=retry. op=resolve (retry, defer, abort, escalate) applies only to a parked run in awaiting_user, deferred or blocked state and is refused while the run is active; it is not a way to finish a settled candidate. op=cancel stops the exact current worker; op=status and op=watch inspect. Keep modelPolicy and policyDigest from op=next unchanged. Never invent an edge, bypass a join, synthesize settlement facts or author placeholder answers. Continue until terminal, blocked, deferred, or awaiting_user state.`;
}
