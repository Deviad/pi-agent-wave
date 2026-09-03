import { requireAcpx } from "./require-acpx.ts";
import { requireAgentFs } from "./require-agentfs.ts";

/** Stops package registration unless mandatory ACPX and AgentFS runtimes are complete. */
export function requireRuntime(env: NodeJS.ProcessEnv = process.env): void {
	requireAcpx(env);
	requireAgentFs(env);
}
