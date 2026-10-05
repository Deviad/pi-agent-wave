import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { resolveAgentDir } from "../lib/agent-paths.mjs";
import { approveWorkspaceRecipe, revokeWorkspaceRecipe, workspaceRecipeStatus } from "../lib/workspace-preparation.ts";

/** Operator-only approval; dispatch never interprets a repository file or worker answer as consent. */
export function preparationCli(argv: readonly string[]): unknown {
	const [action, ...args] = argv;
	let workspace: string | undefined;
	let hostAccess = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--workspace" && args[index + 1] && !workspace) workspace = args[++index];
		else if (arg === "--host-access" && !hostAccess && action === "approve") hostAccess = true;
		else throw new Error(`unknown/duplicate preparation argument: ${arg}`);
	}
	if (!workspace || !["approve", "revoke", "status"].includes(action ?? "")) throw new Error("usage: workspace-preparation.ts approve|revoke|status --workspace <root> [--host-access]; approval attests complete scriptInputs and arbitrary host access");
	const agentDir = resolveAgentDir();
	if (action === "approve") return { approvalPath: approveWorkspaceRecipe(agentDir, workspace, hostAccess), ...workspaceRecipeStatus(agentDir, workspace) };
	if (action === "revoke") revokeWorkspaceRecipe(agentDir, workspace);
	return workspaceRecipeStatus(agentDir, workspace);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { console.log(JSON.stringify(preparationCli(process.argv.slice(2)))); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
