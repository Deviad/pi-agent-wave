import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const REQUIRED_AGENTFS_VERSION = "0.6.4";
export const AGENTFS_INSTALL_URL = "https://github.com/tursodatabase/agentfs/releases/tag/v0.6.4";

type AgentFsVersionRunner = (
	command: string,
	args: readonly string[],
	options: { encoding: "utf8"; env: NodeJS.ProcessEnv; shell: false },
) => SpawnSyncReturns<string>;

/** Stops package registration unless the exact external AgentFS sandbox is available. */
export function requireAgentFs(env: NodeJS.ProcessEnv = process.env, run: AgentFsVersionRunner = spawnSync): void {
	const version = run("agentfs", ["--version"], { encoding: "utf8", env, shell: false });
	if (version.error || version.status !== 0) {
		throw new Error(`pi-agent-wave requires AgentFS ${REQUIRED_AGENTFS_VERSION}. Install it first: ${AGENTFS_INSTALL_URL}`);
	}
	const observed = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "";
	if (observed !== REQUIRED_AGENTFS_VERSION) {
		throw new Error(`pi-agent-wave requires AgentFS ${REQUIRED_AGENTFS_VERSION}; found ${observed || "unknown"}. Install it from: ${AGENTFS_INSTALL_URL}`);
	}
}
