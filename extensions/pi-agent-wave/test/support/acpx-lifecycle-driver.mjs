#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const required = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};
const agent = required("MATRIX_AGENT");
const model = required("MATRIX_MODEL");
const session = required("MATRIX_SESSION");
const resultPath = required("MATRIX_RESULT");
const env = { ...process.env, HOME: required("MATRIX_ACPX_HOME") };
if (process.env.MATRIX_PI_DIR) env.PI_CODING_AGENT_DIR = process.env.MATRIX_PI_DIR;
if (process.env.MATRIX_CODEX_HOME) env.CODEX_HOME = process.env.MATRIX_CODEX_HOME;
if (process.env.MATRIX_CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.MATRIX_CLAUDE_CONFIG_DIR;
if (process.env.MATRIX_CLAUDE_TOKEN_FILE) env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(process.env.MATRIX_CLAUDE_TOKEN_FILE, "utf8").trim();

const base = ["--cwd", process.cwd(), "--format", "json", "--json-strict", "--timeout", "180", "--ttl", "5", "--model", model, "--deny-all", "--allowed-tools", ""];
const run = (args, timeout = 240_000) => {
	const result = spawnSync("acpx", [...base, ...args], { encoding: "utf8", env, shell: false, timeout });
	return { exitCode: result.status ?? 128, stdout: result.stdout ?? "", stderrBytes: Buffer.byteLength(result.stderr ?? "") };
};
const json = (text) => {
	try { return JSON.parse(text.trim().split("\n").at(-1) ?? "{}"); }
	catch { return {}; }
};
const stopReasons = (text) => text.trim().split("\n").filter(Boolean).flatMap((line) => {
	try { const reason = JSON.parse(line).result?.stopReason; return typeof reason === "string" ? [reason] : []; }
	catch { return []; }
});
const terminal = (text, reason) => stopReasons(text).includes(reason);
const protocolDiagnostics = (text) => text.trim().split("\n").filter(Boolean).flatMap((line) => {
	try {
		const value = JSON.parse(line);
		const message = typeof value.error?.message === "string" ? value.error.message : "";
		const errorClass = !message ? null : /auth|token|credential/i.test(message) ? "auth" : /rate|quota|429/i.test(message) ? "rate-limit" : /session/i.test(message) ? "session" : /cancel/i.test(message) ? "cancel" : /stream|write after/i.test(message) ? "stream" : /timeout/i.test(message) ? "timeout" : /model/i.test(message) ? "model" : /permission/i.test(message) ? "permission" : "unknown";
		return [{ keys: Object.keys(value), method: typeof value.method === "string" ? value.method : null, paramsKeys: value.params && typeof value.params === "object" ? Object.keys(value.params) : [], resultKeys: value.result && typeof value.result === "object" ? Object.keys(value.result) : [], errorKeys: value.error && typeof value.error === "object" ? Object.keys(value.error) : [], errorDataKeys: value.error?.data && typeof value.error.data === "object" ? Object.keys(value.error.data) : [], errorKind: typeof value.error?.data?.errorKind === "string" ? value.error.data.errorKind : null, action: typeof value.action === "string" ? value.action : null, errorCode: value.error?.code ?? null, errorClass, errorMessageBytes: Buffer.byteLength(message), stopReason: typeof value.result?.stopReason === "string" ? value.result.stopReason : null }];
	} catch { return []; }
});

const ensured = run([agent, "sessions", "ensure", "--name", session]);
const queued = run([agent, "--session", session, "--no-wait", "Write MATRIX_CANCEL repeatedly on separate lines up to 50000 lines. Do not use tools."], 30_000);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
const cancelled = run([agent, "cancel", "--session", session], 30_000);
const reconnected = run([agent, "--session", session, "Reply with exactly MATRIX_RECONNECTED_OK. Do not use tools."]);
const closed = run([agent, "sessions", "close", session], 30_000);
const summary = {
	schemaVersion: 1,
	agent,
	ensured: ensured.exitCode === 0,
	queued: queued.exitCode === 0 && json(queued.stdout).action === "prompt_queued",
	cancelled: cancelled.exitCode === 0 && json(cancelled.stdout).cancelled === true,
	reconnected: reconnected.exitCode === 0 && terminal(reconnected.stdout, "end_turn"),
	closed: closed.exitCode === 0 && json(closed.stdout).action === "session_closed",
	diagnostics: {
		ensureExitCode: ensured.exitCode,
		queueExitCode: queued.exitCode,
		cancelExitCode: cancelled.exitCode,
		reconnectExitCode: reconnected.exitCode,
		reconnectStopReasons: stopReasons(reconnected.stdout),
		reconnectProtocol: protocolDiagnostics(reconnected.stdout),
		closeExitCode: closed.exitCode,
	},
	stderrBytes: ensured.stderrBytes + queued.stderrBytes + cancelled.stderrBytes + reconnected.stderrBytes + closed.stderrBytes,
};
writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
if (!summary.ensured || !summary.queued || !summary.cancelled || !summary.reconnected || !summary.closed) process.exitCode = 1;
