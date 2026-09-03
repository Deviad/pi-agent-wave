#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function scanProductionCleanup(): { leakedTabs: string[]; agentFsProcesses: number; temporaryDirectories: string[]; tokenFilePresent: boolean } {
	const tabList = spawnSync("herdr", ["tab", "list", "--workspace", process.env.HERDR_WORKSPACE_ID ?? ""], { encoding: "utf8" });
	let leakedTabs: string[] = [];
	try {
		const tabs = JSON.parse(tabList.stdout).result?.tabs ?? [];
		leakedTabs = tabs.filter((tab: { label?: string }) => /production-acpx/i.test(tab.label ?? "")).map((tab: { tab_id: string }) => tab.tab_id);
	} catch { leakedTabs = ["unparseable-herdr-tab-list"]; }
	const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	const agentFsProcesses = `${ps.stdout ?? ""}`.split("\n").filter((line) => /agentfs run.*dg-/.test(line)).length;
	const temporaryDirectories = readdirSync("/private/tmp").filter((name) => /delegate-graph-herdr-production-acpx|production-acpx-(pi|codex|claude)-real/.test(name));
	const tokenFilePresent = !!process.env.PI_CLAUDE_OAUTH_TOKEN_FILE && existsSync(process.env.PI_CLAUDE_OAUTH_TOKEN_FILE);
	return { leakedTabs, agentFsProcesses, temporaryDirectories, tokenFilePresent };
}

function main(): void {
	const result = scanProductionCleanup();
	console.log(JSON.stringify(result));
	if (result.leakedTabs.length || result.agentFsProcesses || result.temporaryDirectories.length || result.tokenFilePresent) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
