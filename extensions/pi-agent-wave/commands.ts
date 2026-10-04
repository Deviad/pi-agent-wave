import { createHash } from "node:crypto";
import type { GraphStore } from "./store.ts";
import { modelPolicyLabel } from "./herdr.ts";
import { ORPHAN_RECOVERY, readProcessTable, runLiveness } from "./lib/liveness.ts";

const TASK_PREVIEW_CHARS = 120;

/** A fixed-size stand-in for a task: its SHA-256 over the stored UTF-8 text, its size, and a one-line preview. */
export function taskSummary(task: string | null | undefined): string {
	if (!task) return "-";
	const digest = createHash("sha256").update(task).digest("hex");
	const line = task.replace(/\s+/g, " ").trim();
	const preview = line.length > TASK_PREVIEW_CHARS ? `${line.slice(0, TASK_PREVIEW_CHARS)}…` : line;
	return `task sha256=${digest} bytes=${Buffer.byteLength(task)} "${preview.replaceAll("|", "/")}"`;
}

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

/**
 * Renders the on-demand supervisor dashboard without starting timers or polling. Its size follows the
 * run's progress, not its tasks: each task is a `taskSummary`, and `taskOf` appends one operation's full text.
 */
export function renderStatus(store: GraphStore, runId: string, options: { taskOf?: string; processes?: () => readonly string[] | null } = {}): string {
	const state = store.getState(runId);
	const frozen = store.policy(runId);
	const policy = modelPolicyLabel(frozen.input);
	const workspace = store.getRun(runId).workspace_root;
	const agents = store.agents(runId);
	const operations = store.operations(runId, true);
	const latestByAgent = new Map<string, PolicyEvent>();
	for (const event of store.events(runId, 10_000)) {
		const selected = eventPolicy(JSON.parse(event.payload_json) as Record<string, unknown>);
		if (event.agent_id && selected) latestByAgent.set(event.agent_id, selected);
	}
	const lines = [
		`run ${runId} | graph=${state.graph} | node=${state.currentNode} | status=${state.status} | round=${state.round} | fix=${state.fixIteration} | policy=${policy} | digest=${frozen.digest}${workspace ? ` | workspace=home:${workspace}` : ""}`,
		"agent | node | transport | policy | tier | model | attempt | status | current task | last activity",
	];
	{
		for (const operation of store.next(runId).operations) {
			const attempt = operation.runtimeAttempt;
			if (attempt) lines.push(`${operation.id} | process=${attempt.processState} | acceptance=${attempt.acceptance} | cleanup=${attempt.cleanup} | candidate=${attempt.candidateId ?? "-"} | capture=${attempt.observation?.captureStatus ?? "-"} | session=${attempt.observation?.sessionOrigin ?? "-"} | decision=${attempt.decision ? `${attempt.decision.decision}: ${attempt.decision.reason}` : "-"}`);
		}
	}
	for (const input of store.runInputs(runId)) lines.push(`input ${input.name} | sha256=${input.sha256} | bytes=${input.bytes} | source=${input.sourcePath}`);
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
				taskSummary(agent.current_task),
				agent.last_activity_at,
			]
				.map(cell)
				.join(" | "),
		);
	}
	if (operations.length > 0) {
		const liveness = runLiveness(store, runId, options.processes ?? readProcessTable);
		let orphaned = 0;
		lines.push("", "current operations:");
		for (const operation of operations) {
			const route = store.routeForNode(runId, operation.node);
			const blocker = (operation.status === "failed" || operation.status === "blocked") && operation.last_error ? ` | blocker=${operation.last_error}` : "";
			const live = liveness.get(operation.id);
			if (live?.state === "orphaned") orphaned += 1;
			const shown = live?.state === "orphaned" ? `orphaned (${live.reason})` : operation.status;
			lines.push(`${operation.id} | ${operation.node} | ${shown}${blocker} | policy=${policy} | tier=${cell(route?.tier)} | chain=${cell(route?.chain.join(","))} | ${taskSummary(operation.task)}`);
		}
		if (orphaned) lines.push(`orphaned workers: ${orphaned}; ${ORPHAN_RECOVERY}`);
	}
	if (options.taskOf) {
		const operation = store.getOperation(options.taskOf);
		if (operation.run_id !== runId) throw new Error(`operation ${options.taskOf} does not belong to run ${runId}`);
		lines.push("", `task ${operation.id} sha256=${createHash("sha256").update(operation.task).digest("hex")}:`, operation.task);
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
