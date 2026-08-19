import type { GraphStore } from "./store.ts";
import { modelPolicyLabel } from "./herdr.ts";

function cell(value: unknown): string {
	return value === null || value === undefined || value === "" ? "-" : String(value);
}

interface PolicyEvent {
	policyDigest?: string;
	inputKind?: string;
	preset?: string;
	role?: string;
	tier?: string;
	selectedModel?: string;
	attempt?: number;
	chainLength?: number;
	fallbackReason?: string;
}

function eventPolicy(payload: Record<string, unknown>): PolicyEvent | undefined {
	const value = payload.policy;
	if (value && typeof value === "object") return value as PolicyEvent;
	return "selectedModel" in payload || "policyDigest" in payload ? (payload as PolicyEvent) : undefined;
}

/** Renders the on-demand supervisor dashboard without starting timers or polling. */
export function renderStatus(store: GraphStore, runId: string): string {
	const state = store.getState(runId);
	const frozen = store.policy(runId);
	const policy = modelPolicyLabel(frozen.input);
	const agents = store.agents(runId);
	const operations = store.operations(runId, true);
	const latestByAgent = new Map<string, PolicyEvent>();
	for (const event of store.events(runId, 10_000)) {
		const selected = eventPolicy(JSON.parse(event.payload_json) as Record<string, unknown>);
		if (event.agent_id && selected) latestByAgent.set(event.agent_id, selected);
	}
	const lines = [
		`run ${runId} | graph=${state.graph} | node=${state.currentNode} | status=${state.status} | round=${state.round} | fix=${state.fixIteration} | policy=${policy} | digest=${frozen.digest}`,
		"agent | node | transport | policy | tier | model | attempt | status | current task | last activity",
	];
	if (agents.length === 0) lines.push("(no agents registered)");
	for (const agent of agents) {
		const route = store.routeForNode(runId, agent.node);
		const selected = latestByAgent.get(agent.id);
		const attempt = selected?.attempt ?? 0;
		const chainLength = selected?.chainLength ?? route?.chain.length ?? 0;
		const model = selected?.selectedModel ?? agent.selected_model ?? route?.chain[Math.min(attempt, Math.max(0, chainLength - 1))];
		lines.push(
			[
				agent.name,
				agent.node,
				agent.transport,
				policy,
				selected?.tier ?? route?.tier,
				model,
				chainLength ? `${attempt + 1}/${chainLength}` : "-",
				agent.status,
				agent.current_task,
				agent.last_activity_at,
			]
				.map(cell)
				.join(" | "),
		);
	}
	if (operations.length > 0) {
		lines.push("", "current operations:");
		for (const operation of operations) {
			const route = store.routeForNode(runId, operation.node);
			lines.push(`${operation.id} | ${operation.node} | ${operation.status} | policy=${policy} | tier=${cell(route?.tier)} | chain=${cell(route?.chain.join(","))} | ${operation.task}`);
		}
	}
	return lines.join("\n");
}

/** Renders a timestamped message and operation timeline. */
export function renderLog(store: GraphStore, runId: string, limit = 50, agent?: string): string {
	const rows = store.events(runId, limit, agent);
	if (rows.length === 0) return `(no events for ${runId})`;
	const frozenLabel = modelPolicyLabel(store.policy(runId).input);
	return rows
		.map((row) => {
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			const selected = eventPolicy(payload);
			const message = payload.task ?? payload.error ?? payload.reason;
			const fallbackReason = selected?.fallbackReason ?? payload.fallbackReason ?? payload.classification;
			return [
				row.ts,
				row.type,
				`${cell(row.from_agent ?? row.from_node)} -> ${cell(row.to_agent ?? row.to_node)}`,
				`reply_to=${cell(row.reply_to)}`,
				`policy=${selected?.preset ? modelPolicyLabel({ kind: "preset", preset: selected.preset }) : selected?.inputKind ?? frozenLabel}`,
				selected?.tier ? `tier=${selected.tier}` : "",
				selected?.selectedModel ? `model=${selected.selectedModel}` : "",
				selected?.chainLength ? `attempt=${(selected.attempt ?? 0) + 1}/${selected.chainLength}` : "",
				selected?.policyDigest ? `digest=${selected.policyDigest}` : "",
				fallbackReason ? `fallback=${cell(fallbackReason)}` : "",
				message ? `message=${cell(message)}` : "",
				row.verdict ? `verdict=${row.verdict}` : "",
			]
				.filter(Boolean)
				.join(" | ");
		})
		.join("\n");
}
