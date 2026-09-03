import type { AcpxLifecycleEvent } from "./acpx-events.ts";
import type { AcpxState, AcpxAttemptIdentity } from "./acpx-types.ts";
import type { WorkerTransportKind } from "./worker-transport.ts";

interface PresentationSettlementSignals {
	readonly transport?: WorkerTransportKind;
	readonly presentationVerified?: boolean;
	readonly herdrVisible?: boolean;
}

export interface AcpxSettlementSignals extends PresentationSettlementSignals {
	readonly processExitCode: number;
	readonly events: readonly AcpxLifecycleEvent[];
	readonly acpxState: AcpxState;
	readonly identityMatches: boolean;
	readonly reportValid: boolean;
	readonly graphStatus: "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
	readonly ledgerValid: boolean;
}

export interface AcpxSettlementDecision {
	readonly outcome: "running" | "completed" | "cancelled" | "failed" | "blocked";
	readonly blockers: readonly string[];
}

export interface AcpxSettlementSummary extends PresentationSettlementSignals {
	readonly processExitCode: number;
	readonly terminalKind: "completed" | "cancelled" | "failed";
	readonly acpxState: AcpxState;
	readonly identityMatches: boolean;
	readonly reportValid: boolean;
	readonly graphStatus: "running";
	readonly ledgerValid: boolean;
	readonly agentFsExported: boolean;
	readonly agentFsViolationCount: number;
}

function presentationBlockers(signals: PresentationSettlementSignals): string[] {
	const transport = signals.transport ?? "herdr";
	if (transport === "herdr") return signals.herdrVisible === true ? [] : ["Herdr identity is not visible"];
	return signals.presentationVerified === true ? [] : ["headless presentation identity is not verified"];
}

/** Reconciles independent ACPX, presentation, report, graph, and ledger signals before settlement. */
export function reconcileAcpxSettlement(signals: AcpxSettlementSignals): AcpxSettlementDecision {
	if (signals.processExitCode !== 0) return Object.freeze({ outcome: "failed", blockers: Object.freeze([`ACPX process exited ${signals.processExitCode}`]) });
	const failed = signals.events.find((event) => event.kind === "failed");
	if (failed?.kind === "failed") return Object.freeze({ outcome: "failed", blockers: Object.freeze([failed.message]) });
	if (signals.events.some((event) => event.kind === "cancelled")) return Object.freeze({ outcome: "cancelled", blockers: Object.freeze([]) });
	if (!signals.events.some((event) => event.kind === "completed")) return Object.freeze({ outcome: "running", blockers: Object.freeze([]) });
	const blockers = presentationBlockers(signals);
	if (signals.acpxState !== "idle" && signals.acpxState !== "alive") blockers.push(`ACPX state ${signals.acpxState} cannot settle completed work`);
	if (!signals.identityMatches) blockers.push("graph/ACPX/AgentFS/presentation identity mismatch");
	if (!signals.reportValid) blockers.push("worker report audit is invalid");
	if (signals.graphStatus !== "running") blockers.push(`graph operation is ${signals.graphStatus}, expected running`);
	if (!signals.ledgerValid) blockers.push("evidence ledger audit is invalid");
	return blockers.length
		? Object.freeze({ outcome: "blocked", blockers: Object.freeze(blockers) })
		: Object.freeze({ outcome: "completed", blockers: Object.freeze([]) });
}

export function reconcileAcpxSettlementSummary(summary: AcpxSettlementSummary): AcpxSettlementDecision {
	if (summary.processExitCode !== 0) return Object.freeze({ outcome: "failed", blockers: Object.freeze([`ACPX process exited ${summary.processExitCode}`]) });
	if (summary.terminalKind === "failed") return Object.freeze({ outcome: "failed", blockers: Object.freeze(["ACPX terminal event failed"]) });
	if (summary.terminalKind === "cancelled") return Object.freeze({ outcome: "cancelled", blockers: Object.freeze([]) });
	const blockers = presentationBlockers(summary);
	if (summary.acpxState !== "idle" && summary.acpxState !== "alive") blockers.push(`ACPX state ${summary.acpxState} cannot settle completed work`);
	if (!summary.identityMatches) blockers.push("graph/ACPX/AgentFS/presentation identity mismatch");
	if (!summary.reportValid) blockers.push("worker report audit is invalid");
	if (summary.graphStatus !== "running") blockers.push("graph operation is not running");
	if (!summary.ledgerValid) blockers.push("evidence ledger audit is invalid");
	if (!summary.agentFsExported) blockers.push("AgentFS owned-path export did not complete");
	if (summary.agentFsViolationCount !== 0) blockers.push(`AgentFS reported ${summary.agentFsViolationCount} unowned changes`);
	return blockers.length ? Object.freeze({ outcome: "blocked", blockers: Object.freeze(blockers) }) : Object.freeze({ outcome: "completed", blockers: Object.freeze([]) });
}

export function sameAttemptForRepair(current: AcpxAttemptIdentity, repair: AcpxAttemptIdentity): boolean {
	return current.attemptKey === repair.attemptKey && current.sessionName === repair.sessionName && current.agentFsSession === repair.agentFsSession;
}
