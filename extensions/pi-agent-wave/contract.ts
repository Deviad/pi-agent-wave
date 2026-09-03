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
	return `Delegate Graph run ${runId} started for: ${task}\n\n${topology}${policyPreview(policy)}\n\nAct as supervisor using only delegate_graph operations for worker lifecycle. Call op=next to obtain pending operations and frozen routes. For each pending operation call op=dispatch with its runId and operationId; the extension owns transport selection, private files, exact argv, ACPX/AgentFS launch, registration, and running-state evidence through pi.exec. Never render or execute the delegate launcher with bash or another model-facing shell tool. After dispatch call op=collect for that operation; the extension waits and returns the audited report plus settlement and cleanup evidence. Then call op=record status=completed with the returned reportPath and payload.acpxSettlementEvidencePath plus any graph result payload required by the node. Use op=cancel for the exact current worker, op=status for inspection, and op=resolve for retry/defer/abort/escalate recovery choices. Keep modelPolicy and policyDigest returned by op=next unchanged when op=record is used directly. Never invent an edge, bypass a join, synthesize settlement booleans, author placeholder reports, or use the global delegate tool. Continue until terminal, blocked, deferred, or awaiting_user state.`;
}
