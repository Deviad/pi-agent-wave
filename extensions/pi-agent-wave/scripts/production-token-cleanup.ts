#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function removeEphemeralClaudeToken(path: string | undefined): { deleted: boolean; pathClass: string } {
	if (!path) throw new Error("PI_CLAUDE_OAUTH_TOKEN_FILE is required");
	const resolved = resolve(path);
	if (!resolved.startsWith("/private/tmp/") || !existsSync(resolved) || !statSync(resolved).isFile() || (statSync(resolved).mode & 0o077) !== 0) throw new Error("refusing to remove non-private Claude token file");
	rmSync(resolved);
	return { deleted: !existsSync(resolved), pathClass: "private-tmp-mode-600" };
}

function main(): void {
	const result = removeEphemeralClaudeToken(process.env.PI_CLAUDE_OAUTH_TOKEN_FILE);
	console.log(JSON.stringify(result));
	if (!result.deleted) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
