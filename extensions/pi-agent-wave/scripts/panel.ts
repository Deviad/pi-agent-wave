#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { auditReport } from "./report-audit.ts";
import { buildRepairPrompt, buildReportPrompt } from "./report-prompt.ts";

export type PanelBackend = "cmux" | "tmux";

export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => CommandResult;

export const defaultRunner: CommandRunner = (file, args) => {
	const result = spawnSync(file, args, { encoding: "utf8" });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function commandExists(name: string): boolean {
	const result = spawnSync("/usr/bin/env", ["which", name], { stdio: "ignore" });
	return result.status === 0;
}

function splitCommand(value: string): string[] {
	const words = value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return words.map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_all, double, single) => double ?? single));
}

export function detectBackend(env = process.env): PanelBackend {
	const requested = env.PANEL_MUX ?? "auto";
	if (requested === "cmux" || requested === "tmux") return requested;
	if (requested !== "auto") throw new Error(`unsupported panel backend ${requested}`);
	if (env.TMUX) return "tmux";
	if ((env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID) && commandExists("cmux")) return "cmux";
	if (commandExists("cmux")) return "cmux";
	if (commandExists(splitCommand(env.PANEL_TMUX_BIN ?? "tmux")[0] ?? "tmux")) return "tmux";
	throw new Error("no supported panel backend");
}

function tmuxCommand(env = process.env): string[] {
	const command = splitCommand(env.PANEL_TMUX_BIN ?? "tmux");
	if (!command.length) throw new Error("empty tmux command");
	return command;
}

function execute(runner: CommandRunner, file: string, args: string[], allowFailure = false): CommandResult {
	const result = runner(file, args);
	if (!allowFailure && result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
	return result;
}

function executeTmux(runner: CommandRunner, args: string[], env = process.env, allowFailure = false): CommandResult {
	const [file, ...prefix] = tmuxCommand(env);
	return execute(runner, file, [...prefix, ...args], allowFailure);
}

export class PanelAdapter {
	readonly backend: PanelBackend;
	readonly runner: CommandRunner;
	readonly env: NodeJS.ProcessEnv;
	constructor(runner: CommandRunner = defaultRunner, env = process.env) {
		this.runner = runner;
		this.env = env;
		this.backend = detectBackend(env);
	}

	validateRef(ref: string): boolean {
		return this.backend === "cmux" ? /^surface:\d+$/.test(ref) : /^(%\d+|[^:]+:\d+|.+\..+)$/.test(ref);
	}

	selfRef(): string {
		if (this.env.PANEL_PARENT_REF) return this.env.PANEL_PARENT_REF;
		return this.backend === "cmux" ? this.env.CMUX_SURFACE_ID ?? "surface:1" : this.env.TMUX_PANE ?? "%0";
	}

	send(ref: string, text: string): void {
		if (!this.validateRef(ref)) throw new Error(`invalid ${this.backend} panel ref ${ref}`);
		if (this.backend === "cmux") execute(this.runner, "cmux", ["send", "--surface", ref, text]);
		else executeTmux(this.runner, ["send-keys", "-t", ref, "-l", "--", text], this.env);
	}

	enter(ref: string): void {
		if (this.backend === "cmux") execute(this.runner, "cmux", ["send-key", "--surface", ref, "enter"]);
		else executeTmux(this.runner, ["send-keys", "-t", ref, "Enter"], this.env);
	}

	async sendLine(ref: string, text: string): Promise<void> {
		this.send(ref, text);
		await sleep(400);
		this.enter(ref);
	}

	capture(ref: string, lines = 50): string {
		const result = this.backend === "cmux"
			? execute(this.runner, "cmux", ["capture-pane", "--surface", ref, "--lines", String(lines)], true)
			: executeTmux(this.runner, ["capture-pane", "-p", "-t", ref, "-S", `-${lines}`], this.env, true);
		if (result.status !== 0) return "";
		return result.stdout.replace(/(?:\n\s*)+$/, "").split("\n").slice(-lines).join("\n");
	}

	split(ref: string, direction: "right" | "down"): string {
		const result = this.backend === "cmux"
			? execute(this.runner, "cmux", ["new-split", direction, "--surface", ref, "--focus", "false"])
			: executeTmux(this.runner, ["split-window", direction === "right" ? "-h" : "-v", "-d", "-t", ref, "-P", "-F", "#{pane_id}"], this.env);
		const match = this.backend === "cmux" ? result.stdout.match(/surface:\d+/) : result.stdout.trim().match(/%\d+/);
		if (!match) throw new Error(`panel split did not return a panel ref: ${result.stdout}`);
		return match[0];
	}

	setTitle(ref: string, title: string): void {
		if (this.backend === "cmux") execute(this.runner, "cmux", ["rename-tab", "--surface", ref, title], true);
		else executeTmux(this.runner, ["select-pane", "-t", ref, "-T", title], this.env, true);
	}

	kill(ref: string): void {
		if (this.backend === "cmux") execute(this.runner, "cmux", ["close-surface", "--surface", ref], true);
		else executeTmux(this.runner, ["kill-pane", "-t", ref], this.env, true);
	}
}

export function identityLabel(base: string, policy = "", model = ""): string {
	let label = base;
	if (policy && !label.includes(`[${policy}]`)) label += ` [${policy}]`;
	const short = model.split("/").at(-1) ?? model;
	if (model && !label.includes(`@ ${short}`)) label += ` @ ${short}`;
	return label;
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Builds the environment inherited by a visible delegated Pi worker. */
export function delegationEnvironment(options: Record<string, string>, flags: Set<string>): Record<string, string> {
	const route = options["failover-route"] || options.chain || options.model || "";
	const exactLock = flags.has("exact-lock") || (!options.chain && !options["failover-route"] && Boolean(options.model));
	const role = options["delegation-role"] || options.role || "";
	return {
		PI_DELEGATION_KIND: options["delegation-kind"] || "role",
		PI_DELEGATION_LABEL: options["delegation-label"] || "",
		PI_DELEGATION_MODEL: options["delegation-model"] || options.model || "",
		PI_DELEGATION_POLICY: options["delegation-policy"] || options.policy || "",
		PI_DELEGATION_POLICY_DIGEST: options["delegation-policy-digest"] || options["policy-digest"] || "",
		PI_DELEGATION_ROLE: role,
		PI_DELEGATION_MARKER: options["delegation-marker"] || options.marker || "",
		PI_FAILOVER_ROUTE: route,
		PI_FAILOVER_TIER: options["failover-tier"] || options.tier || (exactLock ? "exact" : ""),
		PI_FAILOVER_ROLE: role,
		PI_FAILOVER_LOCKED: exactLock ? "1" : "0",
	};
}

function identityPrelude(options: Record<string, string>, banner: boolean): string {
	const entries = Object.entries(options).filter(([, value]) => value !== "");
	const exports = entries.length ? `export ${entries.map(([key, value]) => `${key}=${quoteShell(value)}`).join(" ")}; ` : "";
	if (!banner) return exports;
	const line1 = `delegated ${options.PI_DELEGATION_KIND || "panel"}: ${options.PI_DELEGATION_LABEL || "unnamed"}`;
	const line2 = `policy: ${options.PI_DELEGATION_POLICY || "-"} model: ${options.PI_DELEGATION_MODEL || "-"} digest: ${options.PI_DELEGATION_POLICY_DIGEST || "-"} role: ${options.PI_DELEGATION_ROLE || "-"} marker: ${options.PI_DELEGATION_MARKER || "-"}`;
	return `${exports}printf '%s\\n' ${quoteShell(line1)} ${quoteShell(line2)}; `;
}

export interface CheckResult {
	verdict: "DONE_OK" | "DONE_ERROR" | "DONE_BLOCKED" | "WORKING" | "IDLE_NO_SIGNAL";
	code: number;
	detail: string;
}

export function checkPanel(adapter: PanelAdapter, ref: string, options: Record<string, string>): CheckResult {
	const pane = adapter.capture(ref, 80);
	const busy = (pane.match(/Working\.\.\.|Auto-compacting|esc to (?:cancel|interrupt)|Thinking|Compacting|[⠀-⣿]/giu) ?? []).length;
	const tail = pane.split("\n").filter((line) => line.trim() && !/^─+$/.test(line.trim())).slice(-8);
	const text = tail.join("\n");
	const done = new RegExp(options.doneRegex || '^\\s*\\{"status":\\s*"ok"', "m");
	const error = new RegExp(options.errorRegex || '^\\s*\\{"status":\\s*"error"', "m");
	const blocked = new RegExp(options.blockedRegex || '^\\s*\\{"status":\\s*"blocked"', "m");
	const marker = options.marker ? existsSync(options.marker) : false;
	const deliverable = options.deliverable ? globSync(options.deliverable).length > 0 : false;
	let verdict: CheckResult["verdict"] = "IDLE_NO_SIGNAL";
	let code = 20;
	if (busy > 0) { verdict = "WORKING"; code = 10; }
	else if (error.test(text)) { verdict = "DONE_ERROR"; code = 3; }
	else if (blocked.test(text)) { verdict = "DONE_BLOCKED"; code = 4; }
	else if (done.test(text) || marker) { verdict = "DONE_OK"; code = 0; }
	return { verdict, code, detail: `backend=${adapter.backend} ref=${ref} marker=${marker ? "yes" : "no"} deliverable=${options.deliverable ? (deliverable ? "yes" : "no") : "na"} busy_hits=${busy}\npane_tail: ${tail.at(-1) ?? ""}` };
}

function parseOptions(argv: string[]): { options: Record<string, string>; flags: Set<string>; rest: string[] } {
	const options: Record<string, string> = {};
	const flags = new Set<string>();
	const rest: string[] = [];
	const valueOptions = new Set(["session", "window", "cwd", "title", "prefix", "direction", "anchor", "stdin-file", "marker", "deliverable", "done-regex", "error-regex", "blocked-regex", "polls", "interval", "tail", "policy", "policy-digest", "role", "model", "chain", "tier", "failover-route", "failover-tier", "delegation-kind", "delegation-label", "delegation-model", "delegation-policy", "delegation-policy-digest", "delegation-role", "delegation-marker", "report", "node", "private-root"]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") { rest.push(...argv.slice(index + 1)); break; }
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			if (valueOptions.has(key)) options[key] = argv[++index] ?? "";
			else flags.add(key);
		} else rest.push(arg);
	}
	return { options, flags, rest };
}

async function spawnPanel(adapter: PanelAdapter, options: Record<string, string>): Promise<string> {
	const direction = options.direction === "down" ? "down" : "right";
	let anchor = options.anchor || adapter.selfRef();
	if (adapter.backend === "tmux" && options.session) {
		const exists = executeTmux(adapter.runner, ["has-session", "-t", options.session], adapter.env, true).status === 0;
		if (!exists) executeTmux(adapter.runner, ["new-session", "-d", "-s", options.session, "-n", "main", "-c", options.cwd || process.cwd(), "sh", "-l"], adapter.env);
		if (!options.anchor) {
			const listed = executeTmux(adapter.runner, ["list-panes", "-t", options.window || `${options.session}:0`, "-F", "#{pane_id}"], adapter.env);
			anchor = listed.stdout.trim().split("\n")[0] || adapter.selfRef();
		}
	}
	const ref = adapter.split(anchor, direction);
	const title = identityLabel(options.title || options.role || options.prefix || `agent-${randomBytes(3).toString("hex").slice(0, 5)}`, options.policy, options.model);
	adapter.setTitle(ref, title);
	return ref;
}

async function sendPanel(adapter: PanelAdapter, options: Record<string, string>, flags: Set<string>, rest: string[]): Promise<void> {
	const ref = rest.shift();
	if (!ref) throw new Error("send requires panel ref");
	let text = options["stdin-file"] ? readFileSync(options["stdin-file"], "utf8") : rest.join(" ");
	if (!text) throw new Error("send requires text or --stdin-file");
	if (options.report && options.node) text += `\n\n${buildReportPrompt(options.node as never, options.report)}`;
	if (flags.has("clear")) { await adapter.sendLine(ref, "/clear"); await sleep(1000); }
	if (flags.has("new")) { await adapter.sendLine(ref, "/new"); await sleep(Number(process.env.PANEL_NEW_WAIT ?? 3) * 1000); }
	const identity = delegationEnvironment(options, flags);
	const cwd = options.cwd ? `cd ${quoteShell(resolve(options.cwd))} && ` : "";
	const payload = `${identityPrelude(identity, flags.has("delegation-banner"))}${cwd}${text}`;
	if (flags.has("no-enter")) adapter.send(ref, payload);
	else await adapter.sendLine(ref, payload);
}

async function waitPanel(adapter: PanelAdapter, ref: string, options: Record<string, string>): Promise<CheckResult> {
	const polls = Number(options.polls || 12);
	const interval = Number(options.interval || 10) * 1000;
	let result: CheckResult = { verdict: "IDLE_NO_SIGNAL", code: 20, detail: "" };
	for (let index = 0; index < polls; index++) {
		result = checkPanel(adapter, ref, { marker: options.marker, deliverable: options.deliverable, doneRegex: options["done-regex"], errorRegex: options["error-regex"], blockedRegex: options["blocked-regex"] });
		console.log(`[poll ${index + 1}/${polls}] VERDICT=${result.verdict}`);
		if (["DONE_OK", "DONE_ERROR", "DONE_BLOCKED"].includes(result.verdict)) return result;
		if (index + 1 < polls) await sleep(interval);
	}
	return { ...result, code: result.verdict === "WORKING" ? 30 : 21 };
}

async function runPanel(adapter: PanelAdapter, options: Record<string, string>, flags: Set<string>, rest: string[]): Promise<number> {
	const ref = await spawnPanel(adapter, options);
	let code = 1;
	try {
		console.log(`panel-run: spawned ${ref}`);
		await sendPanel(adapter, options, new Set([...flags, "delegation-banner"]), [ref, ...rest]);
		let result = await waitPanel(adapter, ref, options);
		const reportRepairDiagnostics: unknown[] = [];
		let reportRepairAttempts = 0;
		if (result.code === 0 && options.report && options.node) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const audit = await auditReport(options.report, { node: options.node as never, privateRoot: options["private-root"] || dirname(resolve(options.report)) });
				if (audit.valid) break;
				reportRepairDiagnostics.push(audit.errors);
				if (attempt === 1) { result = { verdict: "DONE_ERROR", code: 3, detail: JSON.stringify(audit.errors) }; break; }
				reportRepairAttempts += 1;
				await adapter.sendLine(ref, buildRepairPrompt(options.report, audit.errors));
				result = await waitPanel(adapter, ref, options);
				if (result.code !== 0) break;
			}
		}
		code = result.code;
		console.log(result.detail);
		console.log(JSON.stringify({ reportRepairAttempts, reportRepairDiagnostics }));
		return code;
	} finally {
		console.log(adapter.capture(ref, Number(options.tail || 120)));
		if (!flags.has("keep") && code !== 30) adapter.kill(ref);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
	try {
		const [subcommand, ...argv] = process.argv.slice(2);
		const parsed = parseOptions(argv);
		const adapter = new PanelAdapter();
		if (subcommand === "spawn") console.log(await spawnPanel(adapter, parsed.options));
		else if (subcommand === "send") await sendPanel(adapter, parsed.options, parsed.flags, parsed.rest);
		else if (subcommand === "check") {
			const ref = parsed.rest[0];
			if (!ref) throw new Error("check requires panel ref");
			const result = checkPanel(adapter, ref, parsed.options);
			console.log(`VERDICT=${result.verdict}\n${result.detail}`);
			process.exitCode = result.code;
		} else if (subcommand === "wait") {
			const ref = parsed.rest[0];
			if (!ref) throw new Error("wait requires panel ref");
			const result = await waitPanel(adapter, ref, parsed.options);
			console.log(result.detail);
			process.exitCode = result.code;
		} else if (subcommand === "run") process.exitCode = await runPanel(adapter, parsed.options, parsed.flags, parsed.rest);
		else throw new Error("usage: panel.ts <spawn|send|check|wait|run> [options]");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
