#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function files(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...files(path)); else result.push(path);
	}
	return result;
}

export function scanProductionEvidence(directory: string): { files: number; findings: number } {
	const paths = files(directory);
	const pattern = /\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/g;
	let findings = 0;
	for (const path of paths) findings += [...readFileSync(path, "utf8").matchAll(pattern)].length;
	return { files: paths.length, findings };
}

function main(): void {
	const result = scanProductionEvidence(resolve(process.argv[2] ?? "agent-output/production-acpx-worker-backend"));
	console.log(JSON.stringify(result));
	if (result.findings) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
