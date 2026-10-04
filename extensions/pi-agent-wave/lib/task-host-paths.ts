import { isAbsolute, relative, sep } from "node:path";
import { realpathExistingPrefix } from "./agentfs-sandbox.ts";

export interface TaskPathIssue {
	readonly token: string;
	readonly workspace: string;
	readonly reason: string;
}

const SLASH_COMMANDS = new Set(["/graph", "/delegate", "/failover"]);

/** Extracts quoted filenames intact; unquoted prose punctuation is not part of a path. */
export function taskPathTokens(task: string): readonly { token: string; commandPosition: boolean }[] {
	const tokens: { token: string; commandPosition: boolean }[] = [];
	const pattern = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`(),;]+|[^\s"'`()=,;]+/g;
	for (const match of task.matchAll(pattern)) {
		const quoted = match[1] ?? match[2] ?? match[3];
		const token = quoted ?? match[0].replace(/[.:]+$/, "");
		let previous = match.index - 1;
		while (previous >= 0 && /[ \t\r]/.test(task[previous])) previous--;
		const commandPosition = previous < 0 || task[previous] === ";" || task[previous] === "\n";
		tokens.push({ token, commandPosition: quoted === undefined && commandPosition });
	}
	return tokens;
}

/** Addressing lint only: existing-prefix resolution detects symlink escapes, not sandbox access. */
export function taskPathIssues(task: string, workspaceRoot: string): TaskPathIssue[] {
	const workspace = realpathExistingPrefix(workspaceRoot);
	const issues: TaskPathIssue[] = [];
	for (const { token, commandPosition } of taskPathTokens(task)) {
		if (/^(?:~\/|\$HOME\/|\$\{HOME\}\/)/.test(token)) {
			issues.push({ token, workspace, reason: "home reference resolves to the worker's private home; prepare the resource" });
			continue;
		}
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue;
		if (commandPosition && SLASH_COMMANDS.has(token)) continue;
		if (!token.startsWith("/") && !token.includes("/")) continue;
		try {
			const resolved = realpathExistingPrefix(isAbsolute(token) ? token : `${workspace}${sep}${token}`);
			const path = relative(workspace, resolved);
			if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) issues.push({ token, workspace, reason: "path resolves outside the worker workspace" });
		} catch (error) {
			issues.push({ token, workspace, reason: `cannot resolve resource path: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return issues;
}

export class TaskPreparationError extends Error {
	readonly pathIssues: readonly TaskPathIssue[];
	constructor(pathIssues: readonly TaskPathIssue[]) {
		super(`[dispatch_precondition] resource preparation required before launching workers: ${pathIssues.map((issue) => issue.token).join(", ")}. Prepare each reference: a required file belongs in inputs, referenced by name; a required program uses an authorized host service (hostServices at dispatch); a prohibition or provenance note keeps its meaning without the host path. The supervising agent should prepare these resources and call op=init again using the selected policy and workspace. Ask the operator only for missing resources, ambiguity or authorization.`);
		this.pathIssues = pathIssues;
	}
}
