import type { NodeName } from "../types.ts";

/** Marker prefix written by `scripts/acpx-worker.ts` when a Pi worker exits 0 without authoring its own report. */
export const PROJECTED_REPORT_MARKER = "Supervisor projection:" as const;

/** Nodes whose verdict is a semantic judgement about the task, not proof that a command ran. */
export const SEMANTIC_GRAPH_NODES: readonly NodeName[] = Object.freeze([
	"thinker_plan",
	"thinker_split",
	"thinker_synthesize",
	"implement",
	"review",
	"test",
	"audit",
	"search",
] as const);

interface ReportLike {
	readonly claims?: readonly { readonly statement?: unknown }[];
}

export function isSemanticGraphNode(node: NodeName): boolean {
	return SEMANTIC_GRAPH_NODES.includes(node);
}

/** True when a report carries the execution-only projection for a node that requires a real semantic verdict. */
export function isProjectedSemanticReport(report: ReportLike | undefined, node: NodeName): boolean {
	if (!isSemanticGraphNode(node)) return false;
	return (report?.claims ?? []).some((claim) => typeof claim?.statement === "string" && claim.statement.startsWith(PROJECTED_REPORT_MARKER));
}

/**
 * Reason a settled attempt must be retried instead of accepted, or null when the settlement is usable.
 * A Pi worker whose model call died still exits 0 with a completed terminal, so the missing report is the
 * only observable signal that the attempt produced nothing; accepting it would freeze the chain at a dead model.
 */
export function projectedAttemptFailure(node: NodeName, report: unknown): string | null {
	if (!isProjectedSemanticReport(report as ReportLike | undefined, node)) return null;
	return "worker exited without authoring its report (report-missing): the settled attempt carries only the execution-only projection";
}
