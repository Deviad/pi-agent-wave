#!/usr/bin/env -S node --experimental-strip-types
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DelegateTransport = "herdr" | "panel";

export interface Invocation {
	file: string;
	args: string[];
}

function commandExists(name: string): boolean {
	return spawnSync("/usr/bin/env", ["which", name], { stdio: "ignore" }).status === 0;
}

/** Select Herdr by default only when its visible workspace identity is complete. */
export function selectTransport(env = process.env, requested: "auto" | DelegateTransport = "auto", exists = commandExists): DelegateTransport {
	if (requested === "herdr") {
		if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID || !env.HERDR_TAB_ID || !exists("herdr")) throw new Error("Herdr transport requested but its workspace identity is unavailable");
		return "herdr";
	}
	if (requested === "panel") return "panel";
	if (env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID && env.HERDR_TAB_ID && exists("herdr")) return "herdr";
	return "panel";
}

export function delegateInvocation(transport: DelegateTransport, args: string[], env = process.env): Invocation {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	if (transport === "herdr") return { file: env.PYTHON ?? "python3", args: [resolve(scriptDir, "herdr_delegate.py"), ...args] };
	return { file: process.execPath, args: ["--experimental-strip-types", resolve(scriptDir, "panel.ts"), ...args] };
}

function parse(argv: string[]): { requested: "auto" | DelegateTransport; rest: string[] } {
	let requested: "auto" | DelegateTransport = "auto";
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--transport") requested = argv[++index] as "auto" | DelegateTransport;
		else if (argv[index] === "--") { rest.push(...argv.slice(index + 1)); break; }
		else rest.push(argv[index]);
	}
	if (!rest.length) throw new Error("usage: delegate.ts [--transport auto|herdr|panel] -- <transport arguments>");
	return { requested, rest };
}

function main(): void {
	try {
		const parsed = parse(process.argv.slice(2));
		const transport = selectTransport(process.env, parsed.requested);
		const invocation = delegateInvocation(transport, parsed.rest);
		const result = spawnSync(invocation.file, invocation.args, { stdio: "inherit", env: process.env });
		process.exitCode = result.status ?? 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
