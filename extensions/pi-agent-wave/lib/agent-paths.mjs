import { mkdtempSync } from "node:fs";
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

/**
 * Root for short-lived scratch that must outlive the caller's environment. Deliberately not os.tmpdir():
 * a launcher-supplied TMPDIR can be reclaimed while a delegate run is still in flight, which lost a
 * settlement on 2026-09-16. Mirrors SCRATCH_ROOT in scripts/delegate_core.py; the two must stay identical.
 * Scratch only: run directories live under the graph home (scripts/delegate_core.py:run_root), because
 * /tmp does not survive a reboot.
 */
export const SCRATCH_ROOT = "/tmp";

/** Create a private scratch directory under SCRATCH_ROOT, or fail naming the root when it is unusable. */
export function makeScratchDir(prefix) {
	try {
		return mkdtempSync(join(SCRATCH_ROOT, prefix), { mode: 0o700 });
	} catch (error) {
		throw new Error(`scratch root ${SCRATCH_ROOT} is unusable for ${prefix}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
