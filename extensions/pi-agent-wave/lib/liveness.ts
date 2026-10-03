import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRow, GraphStore } from "../store.ts";

/**
 * Read-time liveness of a running operation's worker, for reporting only: nothing here settles,
 * retries or cancels. `acpx_state` is deliberately not read, because it is written at registration
 * and never revised, so it still says `alive` for a worker that died days ago.
 */
export type Liveness =
	| { readonly state: "alive" }
	| { readonly state: "awaiting-collect" }
	| { readonly state: "unknown"; readonly reason: "process-table-unreadable" | "attempt-directory-unrecorded" }
	| { readonly state: "orphaned"; readonly reason: OrphanReason };

export type OrphanReason = "attempt-directory-missing" | "worker-process-gone";

/** How long after registration a worker may be absent from the process table: Herdr starts the launcher in its pane after the attempt is registered. */
export const LAUNCH_GRACE_MS = 60_000;

/** The documented verbs that settle and replace an orphaned attempt. */
export const ORPHAN_RECOVERY = "op=collect records the attempt failed, then op=retry; once the run parks, op=resolve retry or abort";

/** Every process's full argv as one line each, or null when the table cannot be read (a sandbox may refuse `ps`). */
export function readProcessTable(): readonly string[] | null {
	const result = spawnSync("ps", ["-Ao", "command="], { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
	if (result.error || result.status !== 0) return null;
	return result.stdout.split("\n").filter(Boolean);
}

type WorkerIdentity = Pick<AgentRow, "acpx_cancel_script" | "agentfs_session_id" | "last_activity_at">;

/**
 * Classifies one registered worker whose attempt is unsettled. The worker's own result file wins over
 * every other fact, a missing attempt directory is final, and an absent process counts only after the
 * launch grace and only when the process table was read.
 */
export function workerLiveness(agent: WorkerIdentity, processes: () => readonly string[] | null, nowMs: number): Liveness {
	if (!agent.acpx_cancel_script) return { state: "unknown", reason: "attempt-directory-unrecorded" };
	const attemptDirectory = dirname(agent.acpx_cancel_script);
	if (existsSync(join(attemptDirectory, "worker-result.json"))) return { state: "awaiting-collect" };
	if (!existsSync(attemptDirectory)) return { state: "orphaned", reason: "attempt-directory-missing" };
	if (nowMs - Date.parse(agent.last_activity_at) < LAUNCH_GRACE_MS) return { state: "alive" };
	const table = processes();
	if (table === null) return { state: "unknown", reason: "process-table-unreadable" };
	const markers = [agent.agentfs_session_id, attemptDirectory].filter((marker): marker is string => Boolean(marker));
	return table.some((line) => markers.some((marker) => line.includes(marker))) ? { state: "alive" } : { state: "orphaned", reason: "worker-process-gone" };
}

/**
 * Liveness of every current `running` operation of a run whose attempt is registered and unsettled.
 * The process table is read at most once, and only when some worker needs it.
 */
export function runLiveness(store: GraphStore, runId: string, processes: () => readonly string[] | null = readProcessTable, nowMs = Date.now()): Map<string, Liveness> {
	const result = new Map<string, Liveness>();
	let table: readonly string[] | null | undefined;
	const once = () => (table === undefined ? (table = processes()) : table);
	const agents = store.agents(runId);
	for (const operation of store.operations(runId, true)) {
		if (operation.status !== "running") continue;
		const attempt = store.runtimeAttemptByOperation(operation.id);
		if (!attempt || attempt.outcome || attempt.supersededAt) continue;
		const agent = agents.find((candidate) => candidate.id === (attempt.agentId ?? operation.agent_id));
		if (!agent) continue;
		result.set(operation.id, workerLiveness(agent, once, nowMs));
	}
	return result;
}
