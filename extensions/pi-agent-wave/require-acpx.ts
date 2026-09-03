import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const REQUIRED_ACPX_VERSION = "0.13.2";
export const ACPX_INSTALL_COMMAND = `npm install -g acpx@${REQUIRED_ACPX_VERSION}`;

type AcpxVersionRunner = (
	command: string,
	args: readonly string[],
	options: { encoding: "utf8"; env: NodeJS.ProcessEnv; shell: false },
) => SpawnSyncReturns<string>;

/** Stops package registration unless the exact external ACPX runtime is available. */
export function requireAcpx(env: NodeJS.ProcessEnv = process.env, run: AcpxVersionRunner = spawnSync): void {
	const version = run("acpx", ["--version"], { encoding: "utf8", env, shell: false });
	if (version.error || version.status !== 0) {
		throw new Error(`pi-agent-wave requires ACPX ${REQUIRED_ACPX_VERSION}. Install it first: ${ACPX_INSTALL_COMMAND}`);
	}
	const observed = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? "";
	if (observed !== REQUIRED_ACPX_VERSION) {
		throw new Error(`pi-agent-wave requires ACPX ${REQUIRED_ACPX_VERSION}; found ${observed || "unknown"}. Install it with: ${ACPX_INSTALL_COMMAND}`);
	}
}
