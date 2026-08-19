import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrozenPolicy, GraphKind } from "./types.ts";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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
		: "Thinker split -> parallel read-only Searchers (join) -> Thinker synthesis.";
	const ledgerScript = shellQuote(join(PACKAGE_ROOT, "scripts", "ledger.ts"));
	const delegateScript = shellQuote(join(PACKAGE_ROOT, "scripts", "delegate.ts"));
	return `Delegate Graph run ${runId} started for: ${task}\n\n${topology}${policyPreview(policy)}\n\nAct as supervisor. Use delegate_graph op=next to obtain pending operations and each operation's frozen route. For every dispatch, pass modelPolicy and policyDigest from op=next unchanged, plus the route's concrete selectedModel and zero-based modelAttempt; never choose a tier ad hoc, open another picker, or re-resolve a route. Pass the full frozen chain, tier, and role through the chosen transport's route arguments so the worker inherits automatic runtime failover; exact-model routes must retain their explicit lock. A same-model retry keeps modelAttempt unchanged and records retryReason. A transient cross-model fallback increments modelAttempt and records fallbackReason. Dispatch each operation with its exact task, exact graph node via --node, and private JSON report path; parallelize only fan-out operations. Register dispatch with delegate_graph op=record status=running, an observable transport, and worker identity, then record the audited result; include the transport's reportRepairAttempts and reportRepairDiagnostics in the result payload when present. Immediately append every worker report as JSON with accepted, blocked, or failed outcome (map cancelled, timed-out, and rejected candidates to failed with diagnostics) using node --experimental-strip-types ${ledgerScript} write; terminal success also requires node --experimental-strip-types ${ledgerScript} audit and a fresh semantic ledger audit. Never invent an edge or bypass a join. Never use the global delegate tool or a delegate transport. Use ${delegateScript} as the unified entry point: it invokes herdr_delegate.py when verified Herdr is available and uses panel.ts with PANEL_RUNNER_WORKER=1 only as the visible fallback. Never retain settled worker tabs. If neither observable transport is available, fail closed. Continue until terminal, blocked, deferred, or awaiting_user state.`;
}
