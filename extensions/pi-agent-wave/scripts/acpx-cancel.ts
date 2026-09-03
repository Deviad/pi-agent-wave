#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export interface CancelConfig { schemaVersion: 1; acpxExecutable: string; agent: "pi" | "codex" | "claude"; sessionName: string; recordId: string; attemptKey: string; cwd: string; acpxHome: string; timeoutSeconds: number }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parse(value: unknown): CancelConfig {
	if (!record(value) || value.schemaVersion !== 1 || !["pi", "codex", "claude"].includes(String(value.agent))) throw new Error("invalid ACPX cancel config");
	for (const key of ["acpxExecutable", "sessionName", "recordId", "attemptKey", "cwd", "acpxHome"] as const) if (typeof value[key] !== "string" || !value[key]) throw new Error(`cancel config requires ${key}`);
	if (!Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) <= 0) throw new Error("cancel timeout must be positive");
	return value as unknown as CancelConfig;
}
function run(config: CancelConfig, args: string[]) {
	// Spawn from the stable ACPX home; the session cwd is an AgentFS mount path that may be unmounted by the time cancellation settles, and a vanished spawn cwd fails with ENOENT.
	const result = spawnSync(config.acpxExecutable, ["--cwd", config.cwd, "--format", "json", "--json-strict", "--timeout", String(config.timeoutSeconds), "--ttl", "5", ...args], { encoding: "utf8", shell: false, env: { ...process.env, HOME: config.acpxHome }, cwd: config.acpxHome });
	return { exitCode: result.status ?? 128, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function action(output: string, name: string): Record<string, unknown> | null {
	for (const line of output.trim().split("\n").reverse()) { try { const value: unknown = JSON.parse(line); if (record(value) && value.action === name) return value; } catch { continue; } }
	return null;
}

export function cancelAttempt(config: CancelConfig) {
	const cancelled = run(config, [config.agent, "cancel", "--session", config.sessionName]);
	const cancelObserved = cancelled.exitCode === 0 && action(cancelled.stdout, "cancel_result")?.cancelled === true;
	let structuredCancelled = false;
	if (cancelObserved) {
		// Sandbox command kill plus turn teardown can exceed the acpx CLI call timeout; bound the structured wait separately.
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && !structuredCancelled) {
			const status = run(config, [config.agent, "status", "--session", config.sessionName]);
			const snapshot = action(status.stdout, "status_snapshot");
			structuredCancelled = status.exitCode === 0 && (snapshot?.status === "idle" || snapshot?.status === "no-session");
			if (!structuredCancelled) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
	const closed = structuredCancelled ? run(config, [config.agent, "sessions", "close", config.sessionName]) : { exitCode: 1, stdout: "", stderr: "" };
	const status = run(config, [config.agent, "status", "--session", config.sessionName]);
	return { action: "cancel_attempt", sessionName: config.sessionName, recordId: config.recordId, attemptKey: config.attemptKey, cancelled: cancelObserved, structuredCancelled, closed: closed.exitCode === 0 && action(closed.stdout, "session_closed") !== null, noSession: status.exitCode === 0 && action(status.stdout, "status_snapshot")?.status === "no-session" };
}
function main(): void { const path = process.env.PI_ACPX_CANCEL_CONFIG; if (!path) throw new Error("PI_ACPX_CANCEL_CONFIG is required"); const result = cancelAttempt(parse(JSON.parse(readFileSync(path, "utf8")))); console.log(JSON.stringify(result)); if (!result.cancelled || !result.structuredCancelled || !result.closed || !result.noSession) process.exitCode = 1; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; } }
