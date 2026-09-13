#!/usr/bin/env -S node --experimental-strip-types
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { parseAcpAgent, type AcpAgent } from "../lib/acpx-types.ts";
import { acpxModelArgument } from "../lib/acpx-select.ts";
import { acpxPermissionPolicy } from "../lib/acpx-permissions.ts";
import { parseAcpxNdjson, parseAcpxStatus, type AcpxLifecycleEvent } from "../lib/acpx-events.ts";
import type { NodeName } from "../types.ts";
import { parseResultContract, type ResultContract } from "../lib/runtime-results.ts";
import { AcpxRenderer } from "../lib/acpx-render.ts";
import { runRuntimeProcess } from "../lib/runtime-process.ts";

export interface AcpxWorkerConfig {
	readonly schemaVersion: 1;
	readonly resultContract?: ResultContract;
	readonly attemptKey?: string;
	readonly acpxExecutable: string;
	readonly agent: AcpAgent;
	readonly selectedModel: string;
	readonly sessionName: string;
	readonly workspaceRelative: string;
	readonly node: NodeName;
	readonly claudeTokenFile?: string;
	readonly acpxHome: string;
	readonly mode?: "prompt" | "close";
	readonly promptFile: string;
	readonly resultPath: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	readonly timeoutSeconds: number;
	readonly hostReadOnly: boolean;
	readonly discardAllChanges: boolean;
	readonly noTerminal: boolean;
}

interface ProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkerConfig(value: unknown): AcpxWorkerConfig {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid ACPX worker config schema");
	if (value.resultContract === undefined) throw new Error("worker config requires resultContract");
	const resultContract = parseResultContract(value.resultContract);
	if (typeof value.attemptKey !== "string" || !value.attemptKey.trim()) throw new Error("runtime-v1 worker requires attemptKey");
	const required = ["acpxExecutable", "selectedModel", "sessionName", "workspaceRelative", "node", "acpxHome", "promptFile", "resultPath", "stdoutPath", "stderrPath"] as const;
	for (const key of required) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`ACPX worker config requires ${key}`);
	if (!Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) <= 0) throw new Error("ACPX worker timeoutSeconds must be positive integer");
	if (typeof value.hostReadOnly !== "boolean") throw new Error("ACPX worker config requires hostReadOnly boolean");
	if (typeof value.discardAllChanges !== "boolean") throw new Error("ACPX worker config requires discardAllChanges boolean");
	if (typeof value.noTerminal !== "boolean") throw new Error("ACPX worker config requires noTerminal boolean");
	if (value.hostReadOnly !== value.discardAllChanges) throw new Error("hostReadOnly requires matching discardAllChanges");
	const nodes: readonly NodeName[] = ["thinker_plan", "thinker_split", "search", "thinker_synthesize", "source_search", "implement", "review", "test", "audit"];
	const node = nodes.find((candidate) => candidate === value.node);
	if (!node) throw new Error(`unsupported ACPX worker node: ${String(value.node)}`);
	return Object.freeze({
		schemaVersion: 1,
		resultContract,
		attemptKey: typeof value.attemptKey === "string" ? value.attemptKey : undefined,
		acpxExecutable: String(value.acpxExecutable),
		agent: parseAcpAgent(value.agent),
		selectedModel: String(value.selectedModel),
		sessionName: String(value.sessionName),
		workspaceRelative: String(value.workspaceRelative),
		node,
		claudeTokenFile: typeof value.claudeTokenFile === "string" ? resolve(value.claudeTokenFile) : undefined,
		acpxHome: resolve(String(value.acpxHome)),
		mode: value.mode === "close" ? "close" : "prompt",
		promptFile: resolve(String(value.promptFile)),
		resultPath: resolve(String(value.resultPath)),
		stdoutPath: resolve(String(value.stdoutPath)),
		stderrPath: resolve(String(value.stderrPath)),
		timeoutSeconds: Number(value.timeoutSeconds),
		hostReadOnly: value.hostReadOnly,
		discardAllChanges: value.discardAllChanges,
		noTerminal: value.noTerminal,
	});
}

function commonArgs(config: AcpxWorkerConfig): string[] {
	return ["--cwd", process.cwd(), "--format", "json", "--json-strict", "--timeout", String(config.timeoutSeconds), "--ttl", "5"];
}

export function buildEnsureArgv(config: AcpxWorkerConfig): string[] {
	return [...commonArgs(config), config.agent, "sessions", "ensure", "--name", config.sessionName];
}

export function buildPromptArgv(config: AcpxWorkerConfig): string[] {
	const args = [
		...commonArgs(config),
		"--model", acpxModelArgument(config.selectedModel, config.agent),
		"--permission-policy", JSON.stringify(acpxPermissionPolicy(false)),
		"--non-interactive-permissions", "fail",
	];
	if (config.noTerminal) args.push("--no-terminal");
	args.push(config.agent, "--session", config.sessionName, "--file", config.promptFile);
	return args;
}

export function workerEnvironment(config: Pick<AcpxWorkerConfig, "agent" | "acpxHome" | "claudeTokenFile">): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: config.acpxHome, GIT_OPTIONAL_LOCKS: "0" };
	if (config.agent === "claude") {
		if (!config.claudeTokenFile) throw new Error("PI_CLAUDE_OAUTH_TOKEN_FILE is required for Claude");
		const token = readFileSync(config.claudeTokenFile, "utf8").trim();
		if (!token.startsWith("sk-ant-oat") || token.length < 40) throw new Error("Claude setup token is invalid");
		env.CLAUDE_CODE_OAUTH_TOKEN = token;
	}
	return env;
}

function runCaptured(config: AcpxWorkerConfig, args: string[], env: NodeJS.ProcessEnv): ProcessResult {
	const result = spawnSync(config.acpxExecutable, args, { encoding: "utf8", shell: false, env, cwd: process.cwd() });
	if (result.error) throw result.error;
	return { exitCode: result.status ?? 128, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function jsonAction(output: string, action: string): Record<string, unknown> | null {
	for (const line of output.trim().split("\n").reverse()) {
		try {
			const value: unknown = JSON.parse(line);
			if (isRecord(value) && value.action === action) return value;
		} catch {
			continue;
		}
	}
	return null;
}

function runStreaming(config: AcpxWorkerConfig, args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(config.acpxExecutable, args, { shell: false, env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); process.stdout.write(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); process.stderr.write(chunk); });
		const timer = setTimeout(() => child.kill("SIGTERM"), (config.timeoutSeconds + 5) * 1_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ exitCode: code ?? 128, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
		});
	});
}

export function ensureAcpxSession(config: AcpxWorkerConfig, env: NodeJS.ProcessEnv): { exitCode: number; stdout: string; stderr: string; attempts: number } {
	let ensure = runCaptured(config, buildEnsureArgv(config), env);
	let attempts = 1;
	if (ensure.exitCode !== 0 && /Cannot call write after a stream was destroyed/.test(`${ensure.stderr}\n${ensure.stdout}`)) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		ensure = runCaptured(config, buildEnsureArgv(config), env);
		attempts = 2;
	}
	return { ...ensure, attempts };
}



/**
 * acpx exits with EXIT_CODES.PERMISSION_DENIED (5) and reports `permission_denied`
 * when every permission request in a turn was denied or cancelled, which is an
 * approval block, not a runtime fault. retry.ts classifies the recorded signal as
 * permanent, so a denied authorization never replays.
 */
const ACPX_PERMISSION_DENIED_EXIT = 5;
const APPROVAL_BLOCK_OUTPUT = /permission[_ -]?denied|permission (?:request )?(?:denied|cancelled)|permission denied for (?:terminal|fs|tool)|denied (?:by|before) [^,.;\n]*(?:approval|permission)/i;

/** True when the worker turn ended on a denied authorization rather than an infrastructure fault. */
export function detectApprovalBlock(exitCode: number, output: string): boolean {
	return exitCode === ACPX_PERMISSION_DENIED_EXIT || APPROVAL_BLOCK_OUTPUT.test(output);
}

/** Runs one ACPX operation-attempt session and writes a structured result for the Herdr supervisor. */
export async function runAcpxWorker(config: AcpxWorkerConfig): Promise<number> {
	// The private worker config written by the supervisor selects the result contract; adapter
	// enablement is checked by the store before any runtime-v1 dispatch reaches this process.
	const sandboxRoot = process.cwd();
	const workspace = resolve(sandboxRoot, config.workspaceRelative);
	if (workspace !== sandboxRoot && !workspace.startsWith(`${sandboxRoot}/`)) throw new Error("ACPX workspace escapes AgentFS sandbox");
	process.chdir(workspace);
	const env = workerEnvironment(config);
	if (config.mode === "close") {
		const closed = runCaptured(config, [...commonArgs(config), config.agent, "sessions", "close", config.sessionName], env);
		const status = runCaptured(config, [...commonArgs(config), config.agent, "status", "--session", config.sessionName], env);
		const exitCode = closed.exitCode || status.exitCode;
		writeFileSync(config.stdoutPath, `${closed.stdout}${status.stdout}`, { mode: 0o600 });
		writeFileSync(config.stderrPath, `${closed.stderr}${status.stderr}`, { mode: 0o600 });
		writeFileSync(config.resultPath, `${JSON.stringify({ schemaVersion: 1, mode: "close", processExitCode: exitCode, sessionName: config.sessionName, closed: jsonAction(closed.stdout, "session_closed") !== null, noSession: jsonAction(status.stdout, "status_snapshot")?.status === "no-session" }, null, 2)}\n`, { mode: 0o600 });
		return exitCode;
	}
	const ensure = ensureAcpxSession(config, env);
	if (ensure.exitCode !== 0) throw new Error(`ACPX session ensure failed after ${ensure.attempts} attempt(s): ${ensure.stderr || ensure.stdout}`);
	{
		const ensured = jsonAction(ensure.stdout, "session_ensured");
		if (!config.attemptKey || typeof ensured?.acpxSessionId !== "string") throw new Error("runtime output requires exact attempt and ensured session identity");
		const outputDir = join(dirname(config.resultPath), "runtime-output");
		// Whoever watches the launcher (a Herdr pane) sees rendered content; the JSON stream itself goes only to the retained files.
		const renderer = new AcpxRenderer((piece) => process.stdout.write(piece), { color: process.stdout.isTTY === true });
		const output = await runRuntimeProcess({ executable: config.acpxExecutable, args: buildPromptArgv(config), cwd: process.cwd(), env, outputDir, identity: { attemptKey: config.attemptKey, sessionId: ensured.acpxSessionId, requestId: null }, timeoutMs: config.timeoutSeconds * 1000, onStdout: (bytes) => renderer.push(bytes) });
		renderer.end();
		const result = { schemaVersion: 2, resultContract: "runtime-v1", agent: config.agent, selectedModel: config.selectedModel, sessionName: config.sessionName, attemptKey: config.attemptKey, outputDir, output };
		const fd = openSync(config.resultPath, "wx", 0o600);
		try { writeFileSync(fd, JSON.stringify(result, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
		return output.outcome.kind === "exited" ? output.outcome.exitCode : 2;
	}
}

async function main(): Promise<void> {
	const configPath = process.env.PI_ACPX_CONFIG;
	if (!configPath) throw new Error("PI_ACPX_CONFIG is required");
	const parsed: unknown = JSON.parse(readFileSync(resolve(configPath), "utf8"));
	const exitCode = await runAcpxWorker(parseWorkerConfig(parsed));
	process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	});
}
