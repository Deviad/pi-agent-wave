import { homedir } from "node:os";
import { join } from "node:path";

export const ROUTING_FILENAME = "model-routing.jsonc";
export const CATALOG_FILENAME = "models.json";
export const FZF_FILENAME = "fzf.json";

/** Resolve the Pi agent directory: explicit flag, then PI_CODING_AGENT_DIR, then ~/.pi/agent. */
export function resolveAgentDir(explicit = "") {
	const fromFlag = String(explicit ?? "").trim();
	if (fromFlag) return fromFlag;
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** Resolve the routing path: explicit flag, then PI_MODEL_ROUTING, then <agentDir>/model-routing.jsonc. */
export function resolveRoutingPath(agentDir, explicit = "") {
	const fromFlag = String(explicit ?? "").trim();
	if (fromFlag) return fromFlag;
	return process.env.PI_MODEL_ROUTING?.trim() || join(agentDir, ROUTING_FILENAME);
}

/** Resolve the catalog path: explicit flag, then PI_MODEL_CATALOG, then <agentDir>/models.json. */
export function resolveCatalogPath(agentDir, explicit = "") {
	const fromFlag = String(explicit ?? "").trim();
	if (fromFlag) return fromFlag;
	return process.env.PI_MODEL_CATALOG?.trim() || join(agentDir, CATALOG_FILENAME);
}

/** The pi-fzf settings file lives directly inside the agent directory. */
export function resolveFzfPath(agentDir) {
	return join(agentDir, FZF_FILENAME);
}
