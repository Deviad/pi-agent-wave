#!/usr/bin/env -S node --experimental-strip-types
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function parse(argv: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
		values[key.slice(2)] = argv[++index] ?? "";
	}
	for (const required of ["uid", "label", "plist", "pi", "prompt"]) if (!values[required]) throw new Error(`missing --${required}`);
	return values;
}

export function runDeferred(argv: string[]): number {
	const args = parse(argv);
	try {
		const result = spawnSync(args.pi, ["-p", args.prompt], { stdio: "inherit" });
		return result.status ?? 1;
	} finally {
		spawnSync("launchctl", ["bootout", `gui/${args.uid}/${args.label}`], { stdio: "ignore" });
		rmSync(args.plist, { force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { process.exitCode = runDeferred(process.argv.slice(2)); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
