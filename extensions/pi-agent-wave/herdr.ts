export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<ExecResult>;

export interface FocusableAgent {
	name: string;
	node: string;
	herdr_agent: string | null;
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

/** Builds the equivalent visible-panel label from the same frozen identity. */
export function panelModelLabel(story: string, role: string, model: string, policy: string): string {
	return `${story}: ${role} [${policy}] @ ${shortModelName(model)}`;
}

/** Focuses an existing named Herdr agent without polling or changing graph state. */
export async function focusHerdrAgent(agent: string, exec: CommandExecutor): Promise<void> {
	const result = await exec("herdr", ["agent", "focus", agent]);
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `failed to focus Herdr agent ${agent}`);
}

/** Resolves a graph node/agent to Herdr and rejects focus outside Herdr explicitly. */
export async function focusRegisteredAgent(
	agents: FocusableAgent[],
	target: string,
	herdrEnabled: boolean,
	exec: CommandExecutor,
): Promise<void> {
	if (!herdrEnabled) throw new Error("agent focus is unavailable outside Herdr");
	const agent = agents.find((candidate) => candidate.name === target || candidate.node === target);
	if (!agent?.herdr_agent) throw new Error(`no focusable Herdr agent for ${target}`);
	await focusHerdrAgent(agent.herdr_agent, exec);
}
