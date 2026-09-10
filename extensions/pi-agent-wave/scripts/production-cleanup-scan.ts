#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCleanup } from "./production-audit.ts";

// The four leak checks live in production-audit.ts, which also runs this file as an audit command,
// so a local copy of the process and temp-path patterns here would be a second probe free to drift.
// Exit non-zero on any leak: this is a gate, not a report.
function main() {
	const cleanup = readCleanup();
	console.log(JSON.stringify(cleanup));
	if (cleanup.leakedTabs.length || cleanup.agentFsProcesses || cleanup.temporaryDirectories.length || cleanup.tokenFilePresent) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();