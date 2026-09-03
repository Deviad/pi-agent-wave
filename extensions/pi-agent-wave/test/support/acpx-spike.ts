import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { RecordOperationInput } from "../../store.ts";

export interface DependencyEvidence {
	command: string;
	path: string | null;
	version: string | null;
	versionArgs: string[];
}

export interface AcpxSpikeBaseline {
	status: "ready" | "blocked";
	blockers: string[];
	dependencies: {
		acpx: DependencyEvidence;
		herdr: DependencyEvidence;
		agent: DependencyEvidence;
	};
	acpx: {
		configPath: string;
		sessionStorePath: string;
	};
	herdr: {
		enabled: boolean;
		workspaceId: string | null;
		tabId: string | null;
	};
}

export interface PreflightOptions {
	path: string;
	home: string;
	env: NodeJS.ProcessEnv;
	agentCommand: string;
}

export class AcpxPreflightError extends Error {
	readonly blockers: string[];

	constructor(blockers: string[]) {
		super(`ACPX spike preflight blocked: ${blockers.join("; ")}`);
		this.name = "AcpxPreflightError";
		this.blockers = blockers;
	}
}

/** Resolves an executable from an explicit PATH without invoking a shell. */
export function resolveExecutable(command: string, pathValue: string): string | null {
	if (command.includes("/") && isAbsolute(command)) {
		try {
			accessSync(command, constants.X_OK);
			return statSync(command).isFile() ? command : null;
		} catch {
			return null;
		}
	}
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function inspectDependency(command: string, pathValue: string, versionArgs: string[], env: NodeJS.ProcessEnv): DependencyEvidence {
	const path = resolveExecutable(command, pathValue);
	if (!path) return { command, path: null, version: null, versionArgs };
	const result = spawnSync(path, versionArgs, { encoding: "utf8", env, shell: false, timeout: 10_000 });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
	return { command, path, version: result.status === 0 && output ? output : null, versionArgs };
}

/** Inspects real dependencies and workspace identity without creating ACPX state. */
export function inspectAcpxPreflight(options: PreflightOptions): AcpxSpikeBaseline {
	if (!isAbsolute(options.home)) throw new Error("preflight home must be an absolute isolated path");
	const env: NodeJS.ProcessEnv = { ...options.env, PATH: options.path, HOME: options.home };
	const dependencies = {
		acpx: inspectDependency("acpx", options.path, ["--version"], env),
		herdr: inspectDependency("herdr", options.path, ["--version"], env),
		agent: inspectDependency(options.agentCommand, options.path, ["--version"], env),
	};
	const blockers: string[] = [];
	for (const dependency of [dependencies.acpx, dependencies.herdr, dependencies.agent]) {
		if (!dependency.path) blockers.push(`missing executable: ${dependency.command}`);
		else if (!dependency.version) blockers.push(`version probe failed: ${dependency.command}`);
	}
	const enabled = env.HERDR_ENV === "1";
	const workspaceId = env.HERDR_WORKSPACE_ID?.trim() || null;
	const tabId = env.HERDR_TAB_ID?.trim() || null;
	if (!enabled || !workspaceId || !tabId) blockers.push("incomplete Herdr workspace identity");
	return {
		status: blockers.length ? "blocked" : "ready",
		blockers,
		dependencies,
		acpx: { configPath: join(options.home, ".acpx", "config.json"), sessionStorePath: join(options.home, ".acpx", "sessions") },
		herdr: { enabled, workspaceId, tabId },
	};
}

/** Returns a complete preflight or throws all blockers before test setup can mutate state. */
export function collectAcpxPreflight(options: PreflightOptions): AcpxSpikeBaseline {
	const baseline = inspectAcpxPreflight(options);
	if (baseline.status === "blocked") throw new AcpxPreflightError(baseline.blockers);
	return baseline;
}

export interface DirectCommandInput {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
}

export interface DirectCommandResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** Runs one persisted executable with an argv array and keeps stdout and stderr separate. */
export function runDirectCommand(input: DirectCommandInput): DirectCommandResult {
	const result = spawnSync(input.executable, input.args, {
		cwd: input.cwd,
		env: input.env,
		encoding: "utf8",
		shell: false,
		timeout: input.timeoutMs,
	});
	if (result.error) throw result.error;
	return {
		exitCode: result.status ?? 128,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

interface AcpxEventBase {
	sessionId: string | null;
	requestId: string | null;
	raw: Record<string, unknown>;
}

export type AcpxLifecycleEvent =
	| (AcpxEventBase & { kind: "started" })
	| (AcpxEventBase & { kind: "progress"; updateType: string })
	| (AcpxEventBase & { kind: "completed"; stopReason: "end_turn" })
	| (AcpxEventBase & { kind: "cancelled"; stopReason: string })
	| (AcpxEventBase & { kind: "failed"; message: string });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectProperty(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return isRecord(value) ? value : null;
}

function stringProperty(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function requestId(record: Record<string, unknown>): string | null {
	const value = record.id;
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Parses ACPX strict JSON output into the lifecycle states used by the spike. */
export function parseAcpxNdjson(ndjson: string): AcpxLifecycleEvent[] {
	const events: AcpxLifecycleEvent[] = [];
	const sessions = new Map<string, string>();
	for (const [index, line] of ndjson.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`invalid ACPX NDJSON at line ${index + 1}`);
		}
		if (!isRecord(parsed)) throw new Error(`invalid ACPX JSON-RPC object at line ${index + 1}`);
		const id = requestId(parsed);
		const method = stringProperty(parsed, "method");
		if (method === "session/prompt") {
			const params = objectProperty(parsed, "params");
			const sessionId = params ? stringProperty(params, "sessionId") : null;
			if (!id || !sessionId) throw new Error(`invalid ACPX session/prompt at line ${index + 1}`);
			sessions.set(id, sessionId);
			events.push({ kind: "started", sessionId, requestId: id, raw: parsed });
			continue;
		}
		if (method === "session/update") {
			const params = objectProperty(parsed, "params");
			const update = params ? objectProperty(params, "update") : null;
			const sessionId = params ? stringProperty(params, "sessionId") : null;
			const updateType = update ? stringProperty(update, "sessionUpdate") : null;
			if (!sessionId || !updateType) throw new Error(`invalid ACPX session/update at line ${index + 1}`);
			events.push({ kind: "progress", sessionId, requestId: null, updateType, raw: parsed });
			continue;
		}
		const error = objectProperty(parsed, "error");
		if (error) {
			events.push({ kind: "failed", sessionId: id ? sessions.get(id) ?? null : null, requestId: id, message: stringProperty(error, "message") ?? "ACPX JSON-RPC error", raw: parsed });
			continue;
		}
		const result = objectProperty(parsed, "result");
		const stopReason = result ? stringProperty(result, "stopReason") : null;
		if (stopReason && id) {
			const sessionId = sessions.get(id) ?? null;
			if (stopReason === "end_turn") events.push({ kind: "completed", sessionId, requestId: id, stopReason, raw: parsed });
			else if (stopReason.toLowerCase().includes("cancel")) events.push({ kind: "cancelled", sessionId, requestId: id, stopReason, raw: parsed });
			else events.push({ kind: "failed", sessionId, requestId: id, message: `unsupported ACPX stop reason: ${stopReason}`, raw: parsed });
		}
	}
	return events;
}

const ACPX_STRUCTURAL_STRING_KEYS = new Set(["jsonrpc", "method", "sessionUpdate", "type", "stopReason"]);

function sanitizedRequestId(value: string | number, identifiers: Map<string, string>): string {
	const original = String(value);
	const existing = identifiers.get(original);
	if (existing) return existing;
	const replacement = `request-${identifiers.size + 1}`;
	identifiers.set(original, replacement);
	return replacement;
}

function sanitizeAcpxValue(value: unknown, key: string | null, identifiers: Map<string, string>): unknown {
	if (Array.isArray(value)) return value.map((item) => sanitizeAcpxValue(item, null, identifiers));
	if (isRecord(value)) {
		const sanitized: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			if (childKey === "_meta") continue;
			sanitized[childKey] = sanitizeAcpxValue(childValue, childKey, identifiers);
		}
		return sanitized;
	}
	if (key === "id" && (typeof value === "string" || typeof value === "number")) return sanitizedRequestId(value, identifiers);
	if (key === "sessionId" && typeof value === "string") return "session-redacted";
	if (typeof value === "string" && !ACPX_STRUCTURAL_STRING_KEYS.has(key ?? "")) return "<redacted>";
	return value;
}

/** Removes prompt, identity, path, metadata, and free-text values while preserving ACP JSON-RPC lifecycle structure. */
export function sanitizeAcpxNdjson(ndjson: string): string {
	const identifiers = new Map<string, string>();
	const sanitized: string[] = [];
	for (const [index, line] of ndjson.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`invalid ACPX NDJSON at line ${index + 1}`);
		}
		if (!isRecord(parsed)) throw new Error(`invalid ACPX JSON-RPC object at line ${index + 1}`);
		sanitized.push(JSON.stringify(sanitizeAcpxValue(parsed, null, identifiers)));
	}
	return `${sanitized.join("\n")}\n`;
}

export interface LifecycleReconciliation {
	status: "running" | "completed" | "cancelled" | "failed" | "blocked";
	blockers: string[];
}

export interface LifecycleSignals {
	events: AcpxLifecycleEvent[];
	exitCode: number;
	sessionState: "running" | "idle" | "dead" | "unknown";
	herdrVisible: boolean;
	reportValidated: boolean;
	evidenceAuditValid: boolean;
}

/** Reconciles process, ACP session, Herdr, report, and evidence states independently. */
export function reconcileAcpxLifecycle(signals: LifecycleSignals): LifecycleReconciliation {
	const failed = signals.events.find((event) => event.kind === "failed");
	if (signals.exitCode !== 0) return { status: "failed", blockers: [`ACPX process exited with status ${signals.exitCode}`] };
	if (failed?.kind === "failed") return { status: "failed", blockers: [failed.message] };
	if (signals.events.some((event) => event.kind === "cancelled")) return { status: "cancelled", blockers: [] };
	if (!signals.events.some((event) => event.kind === "completed")) return { status: "running", blockers: [] };
	const blockers: string[] = [];
	if (signals.sessionState !== "idle") blockers.push(`ACP session state is ${signals.sessionState}, expected idle`);
	if (!signals.herdrVisible) blockers.push("Herdr worker identity is not visible");
	if (!signals.reportValidated) blockers.push("worker report is not validated");
	if (!signals.evidenceAuditValid) blockers.push("evidence audit is not valid");
	return blockers.length ? { status: "blocked", blockers } : { status: "completed", blockers: [] };
}

export interface AcpxWorkerIdentityInput {
	runId: string;
	operationId: string;
	role: string;
	selectedModel: string;
	modelPolicy: string;
	acpAgent: string;
	acpxSession: string;
	herdrAgent: string;
	herdrTab: string;
	herdrTabId: string;
}

export interface AcpxWorkerIdentity extends AcpxWorkerIdentityInput {
	key: string;
}

/** Creates the provenance record shared by graph, ACPX, and Herdr evidence. */
export function createAcpxWorkerIdentity(input: AcpxWorkerIdentityInput): AcpxWorkerIdentity {
	for (const [key, value] of Object.entries(input)) if (!value.trim()) throw new Error(`worker identity requires ${key}`);
	return { ...input, key: `${input.runId}:${input.operationId}:${input.acpxSession}` };
}

export interface HerdrPresentationProbe {
	liveAgents: string[];
	liveTabs: string[];
}

/** Verifies both the named Herdr agent and its exact tab remain live. */
export function verifyHerdrPresentation(identity: AcpxWorkerIdentity, probe: HerdrPresentationProbe): { visible: boolean; blockers: string[] } {
	const blockers: string[] = [];
	if (!probe.liveAgents.includes(identity.herdrAgent)) blockers.push(`Herdr agent ${identity.herdrAgent} is not live`);
	if (!probe.liveTabs.includes(identity.herdrTabId)) blockers.push(`Herdr tab ${identity.herdrTabId} is not live`);
	return { visible: blockers.length === 0, blockers };
}

interface GraphSettlementStore {
	record(input: RecordOperationInput): unknown;
}

export interface AcpxSettlementInput {
	runId: string;
	operationId: string;
	agentId: string;
	agentName: string;
	reportPath: string;
	verdict: string;
	lifecycle: LifecycleReconciliation;
}

/** Completes the graph operation only after every fail-closed spike signal agrees. */
export function settleAcpxGraphOperation(store: GraphSettlementStore, input: AcpxSettlementInput): void {
	if (input.lifecycle.status !== "completed") throw new Error(input.lifecycle.blockers.join("; ") || `ACPX lifecycle is ${input.lifecycle.status}`);
	if (!existsSync(input.reportPath)) throw new Error(`worker report does not exist: ${input.reportPath}`);
	store.record({
		runId: input.runId,
		operationId: input.operationId,
		status: "completed",
		agentId: input.agentId,
		agentName: input.agentName,
		verdict: input.verdict,
		reportPath: input.reportPath,
		payload: { acpxLifecycle: "completed", evidenceAuditValid: true },
	});
}
