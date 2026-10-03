import { existsSync } from "node:fs";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<ExecResult>;

export interface FocusableAgent {
	name: string;
	node: string;
	role?: string | null;
	transport?: "headless" | "herdr";
	herdr_agent: string | null;
	tab_id?: string | null;
	herdr_pane_id?: string | null;
	acpx_cancel_script?: string | null;
	acp_agent?: string | null;
	acpx_session_id?: string | null;
	acpx_record_id?: string | null;
	acpx_attempt_key?: string | null;
	acpx_state?: string | null;
	agentfs_session_id?: string | null;
	agentfs_db_path?: string | null;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "run";
}

/** Builds the stable role-bearing identity shown by Herdr. */
export function herdrAgentName(story: string, role: string, ordinal = 1): string {
	return `dg-${slug(story)}-${slug(role)}-${ordinal}`;
}

/** Returns a model ID's short display name for tab labels (last provider/model segment). */
export function shortModelName(model: string): string {
	const parts = model.split("/");
	return parts[parts.length - 1] || model;
}

/** Formats a frozen policy input for compact status, log, and transport labels. */
export function modelPolicyLabel(input: { kind: string; preset?: string; tier?: string; model?: string } | string): string {
	if (typeof input === "string") return input;
	if (input.kind === "preset") {
		const preset = input.preset ?? "preset";
		return preset.charAt(0).toUpperCase() + preset.slice(1);
	}
	if (input.kind === "tier") return `Tier: ${input.tier ?? "unknown"}`;
	if (input.kind === "model") return "Exact";
	return input.kind.charAt(0).toUpperCase() + input.kind.slice(1);
}

/** Builds the Herdr tab label while retaining the story and role identity. */
export function herdrTabLabel(story: string, role: string, ordinal = 1, model?: string, policy?: string): string {
	const base = `${story}: ${role}${ordinal > 1 ? `-${ordinal}` : ""}`;
	const policySuffix = policy ? ` [${policy}]` : "";
	return model ? `${base}${policySuffix} @ ${shortModelName(model)}` : `${base}${policySuffix}`;
}

/** Focuses an existing named Herdr agent without polling or changing graph state. */
export async function focusHerdrAgent(agent: string, exec: CommandExecutor): Promise<void> {
	const result = await exec("herdr", ["agent", "focus", agent]);
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `failed to focus Herdr agent ${agent}`);
}

async function cancelRegisteredAttempt(agent: FocusableAgent, exec: CommandExecutor, launcherExists: (path: string) => boolean = existsSync): Promise<void> {
	if (typeof agent.acpx_cancel_script !== "string" || !agent.acpx_cancel_script) return;
	// abort_acpx_attempt removes the launcher with the attempt directory after a completed teardown, so an
	// absent launcher means there is nothing left to cancel; a repeat cancel converges instead of reporting it.
	// (pi.exec spawns with shell:false, so a missing path surfaces as a generic code 1, not 127.)
	if (!launcherExists(agent.acpx_cancel_script)) return;
	const cancelled = await exec(agent.acpx_cancel_script, []);
	if (cancelled.exitCode !== 0) throw new Error([cancelled.stdout, cancelled.stderr].filter(Boolean).join("\n") || `failed to cancel ACPX attempt ${agent.acpx_attempt_key ?? "unknown"}`);
	let observed = false;
	for (const line of cancelled.stdout.trim().split("\n").reverse()) {
		try {
			const value = JSON.parse(line) as Record<string, unknown>;
			if (value.action === "cancel_attempt" && value.sessionName === agent.acpx_session_id && value.recordId === agent.acpx_record_id && value.attemptKey === agent.acpx_attempt_key && value.cancelled === true && value.structuredCancelled === true && value.closed === true && value.noSession === true) { observed = true; break; }
		} catch { continue; }
	}
	if (!observed) throw new Error(`incomplete structured ACPX cancellation for ${agent.acpx_attempt_key ?? "unknown"}`);
}

/** Cancels the exact persisted ACPX attempt without requiring a presentation capability. */
export async function cancelRegisteredAgent(agents: FocusableAgent[], target: string, exec: CommandExecutor, launcherExists: (path: string) => boolean = existsSync): Promise<void> {
	const agent = agents.find((candidate) => candidate.name === target || candidate.node === target);
	if (!agent) throw new Error(`unknown Delegate Graph agent or node: ${target}`);
	await cancelRegisteredAttempt(agent, exec, launcherExists);
}

/** Resolves a graph node/agent to Herdr and rejects focus outside Herdr explicitly. */
export async function focusRegisteredAgent(
	agents: FocusableAgent[],
	target: string,
	herdrEnabled: boolean,
	exec: CommandExecutor,
	launcherExists: (path: string) => boolean = existsSync,
): Promise<void> {
	const agent = agents.find((candidate) => candidate.name === target || candidate.node === target);
	if (!agent) throw new Error(`unknown Delegate Graph agent or node: ${target}`);
	if (agent.transport === "headless") throw new Error(`focus is unavailable for headless worker ${target}; use /graph status or /graph log`);
	if (!herdrEnabled) throw new Error("agent focus is unavailable outside Herdr");
	if (!agent.herdr_agent) throw new Error(`no focusable Herdr agent for ${target}`);
	const attemptIdentity = [agent.role, agent.tab_id, agent.herdr_pane_id, agent.acpx_cancel_script, agent.acp_agent, agent.acpx_session_id, agent.acpx_record_id, agent.acpx_attempt_key, agent.acpx_state, agent.agentfs_session_id, agent.agentfs_db_path];
	if (attemptIdentity.some((value) => value !== undefined && value !== null)) {
		if (attemptIdentity.some((value) => typeof value !== "string" || !value.trim())) {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(`incomplete ACPX/AgentFS identity for ${target}`);
		}
		const attemptParts = agent.acpx_attempt_key!.split(":");
		if (agent.acpx_record_id !== agent.acpx_session_id || agent.agentfs_session_id !== agent.acpx_session_id || attemptParts.length < 7 || attemptParts[2] !== agent.role || attemptParts.at(-1) !== agent.acp_agent) {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(`ACPX attempt identity mismatch for ${target}`);
		}
		if (agent.acpx_state !== "alive") {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(`ACPX session for ${target} is ${agent.acpx_state ?? "unknown"}, expected alive`);
		}
		const observed = await exec("herdr", ["pane", "get", agent.herdr_pane_id!]);
		if (observed.exitCode !== 0) {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(observed.stderr || `Herdr pane ${agent.herdr_pane_id} is unavailable`);
		}
		let pane: unknown;
		try { pane = JSON.parse(observed.stdout); }
		catch {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(`invalid Herdr pane observation for ${target}`);
		}
		const record = typeof pane === "object" && pane !== null ? pane as Record<string, unknown> : {};
		const result = typeof record.result === "object" && record.result !== null ? record.result as Record<string, unknown> : {};
		const value = typeof result.pane === "object" && result.pane !== null ? result.pane as Record<string, unknown> : {};
		if (value.pane_id !== agent.herdr_pane_id || value.tab_id !== agent.tab_id) {
			await cancelRegisteredAttempt(agent, exec, launcherExists);
			throw new Error(`Herdr pane identity mismatch for ${target}`);
		}
	}
	await focusHerdrAgent(agent.herdr_agent, exec);
}

/** What happened to one worker tab a run recorded: closed now, already gone, kept because its label is not this run's, or a failed close. */
export interface TabCleanup {
	readonly agentName: string;
	readonly tabId: string;
	readonly outcome: "closed" | "absent" | "not-owned" | "failed";
	readonly detail?: string;
}

interface ListedTab {
	readonly tab_id: string;
	readonly label: string;
}

function listedTabs(stdout: string): ListedTab[] {
	const value: unknown = JSON.parse(stdout);
	const root = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const container = typeof root.result === "object" && root.result !== null ? (root.result as Record<string, unknown>) : root;
	const tabs = Array.isArray(container.tabs) ? container.tabs : [];
	return tabs.flatMap((tab: unknown) => {
		if (typeof tab !== "object" || tab === null) return [];
		const { tab_id, label } = tab as Record<string, unknown>;
		return typeof tab_id === "string" ? [{ tab_id, label: typeof label === "string" ? label : "" }] : [];
	});
}

/**
 * Closes the Herdr worker tabs a run's agent rows recorded and that are still open. A tab is closed only
 * when its current label still starts with `<runId>-`, the run label every worker tab is created with,
 * because Herdr reuses tab ids: a recorded id may now name an unrelated tab, which is reported, not closed.
 */
export async function closeRunTabs(runId: string, agents: readonly Pick<FocusableAgent, "name" | "transport" | "tab_id">[], exec: CommandExecutor): Promise<TabCleanup[]> {
	const recorded = agents.filter((agent): agent is typeof agent & { tab_id: string } => agent.transport === "herdr" && typeof agent.tab_id === "string" && agent.tab_id.length > 0);
	if (!recorded.length) return [];
	let tabs: ListedTab[];
	try {
		const listed = await exec("herdr", ["tab", "list"]);
		if (listed.exitCode !== 0) throw new Error(listed.stderr || listed.stdout || "herdr tab list failed");
		tabs = listedTabs(listed.stdout);
	} catch (error) {
		const detail = `tab list unavailable: ${error instanceof Error ? error.message : String(error)}`;
		return recorded.map((agent) => ({ agentName: agent.name, tabId: agent.tab_id, outcome: "failed", detail }));
	}
	const report: TabCleanup[] = [];
	for (const agent of recorded) {
		const tab = tabs.find((candidate) => candidate.tab_id === agent.tab_id);
		if (!tab) { report.push({ agentName: agent.name, tabId: agent.tab_id, outcome: "absent" }); continue; }
		if (!tab.label.startsWith(`${runId}-`)) { report.push({ agentName: agent.name, tabId: agent.tab_id, outcome: "not-owned", detail: `label ${JSON.stringify(tab.label)}` }); continue; }
		try {
			const closed = await exec("herdr", ["tab", "close", agent.tab_id]);
			report.push(closed.exitCode === 0 ? { agentName: agent.name, tabId: agent.tab_id, outcome: "closed" } : { agentName: agent.name, tabId: agent.tab_id, outcome: "failed", detail: (closed.stderr || closed.stdout).trim() });
		} catch (error) {
			report.push({ agentName: agent.name, tabId: agent.tab_id, outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return report;
}
