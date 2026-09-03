#!/usr/bin/env -S node --experimental-strip-types
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseWorkerTransportKind, type WorkerTransportKind } from "../lib/worker-transport.ts";

export type DelegateTransport = WorkerTransportKind;
export interface Invocation { file: string; args: string[]; }

function commandExists(name: string): boolean {
	return spawnSync(name, ["--version"], { stdio: "ignore", shell: false }).status === 0;
}

function completeHerdrIdentity(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_WORKSPACE_ID?.trim() && !!env.HERDR_TAB_ID?.trim();
}

/** Selects headless by default and uses Herdr only when its full optional capability is available. */
export function selectTransport(env: NodeJS.ProcessEnv = process.env, requested: "auto" | DelegateTransport = "auto", exists = commandExists): DelegateTransport {
	if (requested === "headless") return "headless";
	const herdrAvailable = completeHerdrIdentity(env) && exists("herdr");
	if (requested === "herdr") {
		if (!herdrAvailable) throw new Error("Herdr transport is unavailable; install Herdr and run Pi inside a complete Herdr workspace");
		return "herdr";
	}
	if (requested !== "auto") parseWorkerTransportKind(requested);
	return herdrAvailable ? "herdr" : "headless";
}

export function delegateInvocation(transport: DelegateTransport, args: string[], env: NodeJS.ProcessEnv = process.env): Invocation {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const script = transport === "herdr" ? "herdr_delegate.py" : "headless_delegate.py";
	return { file: env.PYTHON ?? "python3", args: [resolve(scriptDir, script), ...args] };
}

function parse(argv: string[]): { requested: "auto" | DelegateTransport; rest: string[] } {
	let requested: "auto" | DelegateTransport = "auto";
	let rest: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--transport") {
			const value = argv[++index];
			if (value === "auto") requested = value;
			else requested = parseWorkerTransportKind(value);
			continue;
		}
		if (argv[index] === "--") {
			rest = argv.slice(index + 1);
			break;
		}
	}
	if (!rest.length) throw new Error("usage: delegate.ts [--transport auto|headless|herdr] -- <transport arguments>");
	return { requested, rest };
}

function main(): void {
	const parsed = parse(process.argv.slice(2));
	const transport = selectTransport(process.env, parsed.requested);
	const invocation = delegateInvocation(transport, parsed.rest, process.env);
	const result = spawnSync(invocation.file, invocation.args, { stdio: "inherit", env: process.env, shell: false });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 128;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); }
	catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
