import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { auditReport, formatDiagnostics } from "./scripts/report-audit.ts";
import { writeLedgerEntry } from "./scripts/ledger.ts";
import { renderLog, renderStatus } from "./commands.ts";
import delegationIdentityExtension from "./delegation-identity.ts";
import { supervisorContract } from "./contract.ts";
import { BUILD_GRAPH, OPERATIONS_GRAPH, RESEARCH_GRAPH } from "./graph-core.ts";
import { cancelRegisteredAgent, focusRegisteredAgent, type CommandExecutor } from "./herdr.ts";
import { installDeferredJob, parseDeferredTime, writeDeferredJob } from "./scheduler.ts";
import routePicker from "./route-picker.ts";
import { requireRuntime } from "./require-runtime.ts";
import { GraphStore, roleForNode } from "./store.ts";
import { isProjectedSemanticReport, projectedAttemptFailure } from "./lib/projected-report.ts";
import { parseAcpAgent, parseAcpxState, type AcpAgent, type AcpxState } from "./lib/acpx-types.ts";
import { reconcileAcpxSettlementSummary, type AcpxSettlementSummary } from "./lib/acpx-settlement.ts";
import { validateSettlementIdentity, type SettlementIdentityExpected } from "./lib/acpx-settlement-evidence.ts";
import { parseWorkerTransportKind } from "./lib/worker-transport.ts";
import { selectTransport } from "./scripts/delegate.ts";
import type { VisibleTransport } from "./store.ts";
import type { GraphKind, ModelPolicyInput, OperationalCommandSpec, OperationStatus, ResolvedPolicy } from "./types.ts";

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);

/** Every graph node role across both graphs; resolution is restricted to these. */
const GRAPH_ROLES = [...new Set([...BUILD_GRAPH.nodes, ...RESEARCH_GRAPH.nodes, ...OPERATIONS_GRAPH.nodes].map((node) => node.role))];

/** CLI aliases and exact friendly labels exposed by the /delegate picker. */
export const POLICY_PRESETS = ["cheap", "balanced", "strong", "local", "long-context"] as const;
const POLICY_NAMES = ["auto", ...POLICY_PRESETS] as const;
export const POLICY_PICKER_OPTIONS = [
	"Auto (recommended)",
	"Economy",
	"Balanced",
	"Strong",
	"Local only",
	"Long context",
] as const;
const POLICY_PICKER_ALIASES: Record<(typeof POLICY_PICKER_OPTIONS)[number], (typeof POLICY_NAMES)[number]> = {
	"Auto (recommended)": "auto",
	Economy: "cheap",
	Balanced: "balanced",
	Strong: "strong",
	"Local only": "local",
	"Long context": "long-context",
};

export const POLICY_PICKER_TITLE =
	"Choose a model policy. Capability floors may promote a role to a stronger tier; the preview shows every promotion. Local only runs a preflight and fails closed before dispatch if any required role cannot meet its capability floor with a local model.";

/** Maps a CLI alias or exact picker label to its tagged union input. */
export function policyInputFromName(name: string): ModelPolicyInput {
	const alias = POLICY_PICKER_ALIASES[name as (typeof POLICY_PICKER_OPTIONS)[number]] ?? name;
	switch (alias) {
		case "auto":
			return { kind: "auto" };
		case "cheap":
		case "balanced":
		case "strong":
		case "local":
		case "long-context":
			return { kind: "preset", preset: alias };
		default:
			throw new Error(`unknown policy '${name}'; expected ${POLICY_NAMES.join("|")}`);
	}
}

/** Parses an optional leading `--policy <name>` flag, leaving the task text untouched. */
export function parsePolicyArg(raw: string): { policy: ModelPolicyInput | null; task: string } {
	const trimmed = raw.trim();
	if (trimmed !== "--policy" && !trimmed.startsWith("--policy ")) return { policy: null, task: trimmed };
	const rest = trimmed.slice("--policy".length);
	const match = /^\s+(\S+)(?:\s+(.*))?$/.exec(rest);
	if (!match || !match[1]) throw new Error("--policy requires a value: auto|cheap|balanced|strong|local|long-context");
	return { policy: policyInputFromName(match[1]), task: (match[2] ?? "").trim() };
}

/** Selects the policy input: explicit flag wins, headless defaults auto, TUI picker with cancellation-to-auto. */
export async function pickPolicy(ctx: ExtensionContext, explicit: ModelPolicyInput | null): Promise<ModelPolicyInput> {
	if (explicit) return explicit;
	if (ctx.mode !== "tui") return { kind: "auto" };
	const choice = await ctx.ui.select(POLICY_PICKER_TITLE, [...POLICY_PICKER_OPTIONS]);
	return policyInputFromName(choice ?? "Auto (recommended)");
}

/** Shape returned by scripts/policy-resolver.mjs (owned by the policy-resolution slice). */
interface ResolverRoute {
	role: string;
	tier: string | null;
	models: string[];
	thinking: string | null;
	session: boolean;
	capabilityFloor: string | null;
	promoted: boolean;
	promotedFrom: string | null;
	selectionSource?: string | null;
	promotionReason?: string | null;
}

interface ResolverOutput {
	ok: boolean;
	roles: ResolverRoute[];
	errors?: string[];
}

/**
 * Resolves a policy input through the shared resolver script (scripts/policy-resolver.mjs)
 * and maps its output to the canonical ResolvedPolicy snapshot persisted with the run.
 * Fails closed when the resolver rejects the input or is unavailable.
 */
export async function resolvePolicy(input: ModelPolicyInput, exec: CommandExecutor): Promise<ResolvedPolicy> {
	const script = join(EXTENSION_DIR, "scripts", "policy-resolver.mjs");
	const result = await exec("node", [script, "--input", JSON.stringify(input), "--roles", GRAPH_ROLES.join(",")]);
	if (result.exitCode !== 0) throw new Error(`policy resolver failed (${script}): ${result.stderr || result.stdout}`);
	if (!result.stdout.trim()) throw new Error(`policy resolver returned empty output (${script}): ${result.stderr || "no stderr"}`);
	const parsed = JSON.parse(result.stdout.trim()) as ResolverOutput;
	if (!parsed || parsed.ok !== true) {
		throw new Error(`policy resolver rejected input: ${(parsed?.errors ?? []).join("; ") || "invalid output"}`);
	}
	const routes = (parsed.roles ?? []).map((route) => {
		const selectionSource = input.kind === "auto"
			? "role-default"
			: input.kind === "preset"
				? `preset:${input.preset}`
				: input.kind === "tier"
					? `tier:${input.tier}`
					: "exact-model";
		return {
			role: route.role,
			tier: route.tier ?? "",
			chain: Array.isArray(route.models) ? route.models.map(String) : [],
			thinking: route.thinking ?? "off",
			session: Boolean(route.session),
			capabilityFloor: route.capabilityFloor ?? "",
			selectionSource: route.selectionSource ?? selectionSource,
			promoted: Boolean(route.promoted),
			promotedFrom: route.promotedFrom ?? undefined,
			promotionReason:
				route.promotionReason ??
				(route.promoted ? `capability floor ${route.capabilityFloor ?? "unknown"}` : null),
		};
	});
	return { input, routes };
}

const ModelPolicySchema = Type.Union([
	Type.Object({ kind: Type.Literal("auto") }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal("preset"),
			preset: Type.Union([
				Type.Literal("cheap"),
				Type.Literal("balanced"),
				Type.Literal("strong"),
				Type.Literal("local"),
				Type.Literal("long-context"),
			]),
		},
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("tier"), tier: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("model"), model: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);

const GraphParams = Type.Object({
	op: Type.Union([Type.Literal("init"), Type.Literal("next"), Type.Literal("record"), Type.Literal("status"), Type.Literal("cancel"), Type.Literal("resolve"), Type.Literal("dispatch"), Type.Literal("collect")]),
	runId: Type.Optional(Type.String()),
	story: Type.Optional(Type.String()),
	graph: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("research"), Type.Literal("operations")])),
	task: Type.Optional(Type.String()),
	commands: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		command: Type.Object({ executable: Type.String({ minLength: 1 }), args: Type.Array(Type.String()), cwd: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		ownedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}, { additionalProperties: false }), { minItems: 1 })),
	modelPolicy: Type.Optional(ModelPolicySchema),
	policyDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	selectedModel: Type.Optional(Type.String({ minLength: 1 })),
	modelAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
	retryReason: Type.Optional(Type.String({ minLength: 1 })),
	fallbackReason: Type.Optional(Type.String({ minLength: 1 })),
	operationId: Type.Optional(Type.String()),
	decision: Type.Optional(Type.Union([Type.Literal("retry"), Type.Literal("defer"), Type.Literal("abort"), Type.Literal("escalate")])),
	deferredUntil: Type.Optional(Type.String({ minLength: 1 })),
	status: Type.Optional(
		Type.Union([
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("blocked"),
			Type.Literal("cancelled"),
		]),
	),
	verdict: Type.Optional(Type.String()),
	reportPath: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	agentName: Type.Optional(Type.String()),
	transport: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("herdr")])),
	herdrAgent: Type.Optional(Type.String()),
	tabId: Type.Optional(Type.String()),
	payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value };
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Newest retained failure diagnostic bundle in one private run directory, if the launcher kept one. */
function retainedFailureDiagnostics(privateRunDir: string): string | undefined {
	let entries: string[];
	try {
		entries = readdirSync(privateRunDir);
	} catch {
		return undefined;
	}
	let newest: { path: string; mtimeMs: number } | undefined;
	for (const entry of entries.filter((name) => name.startsWith("failure-") && name.endsWith(".json"))) {
		const candidate = join(privateRunDir, entry);
		try {
			const mtimeMs = statSync(candidate).mtimeMs;
			if (!newest || mtimeMs >= newest.mtimeMs) newest = { path: candidate, mtimeMs };
		} catch {
			continue;
		}
	}
	return newest?.path;
}

interface AcpxRegistrationPayload {
	acpAgent: AcpAgent;
	acpxRecordId: string;
	acpxSessionId: string;
	acpxState: AcpxState;
	acpxAttemptKey: string;
	agentFsSessionId: string;
	agentFsDbPath: string;
	herdrPaneId?: string;
	acpxCancelScript: string;
}

function acpxRegistrationPayload(payload: unknown, transport: VisibleTransport): AcpxRegistrationPayload {
	if (!isRecord(payload) || !isRecord(payload.acpx)) throw new Error("running operation requires payload.acpx provenance");
	const acpx = payload.acpx;
	const text = (key: string): string => {
		const value = acpx[key];
		if (typeof value !== "string" || !value.trim()) throw new Error(`running operation requires payload.acpx.${key}`);
		return value;
	};
	const herdrPaneId = transport === "herdr" ? text("herdrPaneId") : undefined;
	if (transport === "headless" && acpx.herdrPaneId !== undefined && acpx.herdrPaneId !== null) throw new Error("headless ACPX provenance cannot contain herdrPaneId");
	return {
		acpAgent: parseAcpAgent(acpx.agent),
		acpxRecordId: text("recordId"),
		acpxSessionId: text("sessionId"),
		acpxState: parseAcpxState(acpx.state),
		acpxAttemptKey: text("attemptKey"),
		agentFsSessionId: text("agentFsSessionId"),
		agentFsDbPath: text("agentFsDbPath"),
		herdrPaneId,
		acpxCancelScript: text("acpxCancelScript"),
	};
}

interface SettlementEvidence {
	path: string;
	value: Record<string, unknown>;
	summary: Omit<AcpxSettlementSummary, "reportValid" | "graphStatus">;
}

function acpxSettlementEvidence(payload: unknown): SettlementEvidence {
	if (!isRecord(payload) || typeof payload.acpxSettlementEvidencePath !== "string" || !payload.acpxSettlementEvidencePath.trim()) {
		throw new Error("completed operation requires payload.acpxSettlementEvidencePath");
	}
	const path = payload.acpxSettlementEvidencePath;
	let parsed: unknown;
	try { parsed = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { throw new Error(`settlement evidence unavailable: ${error instanceof Error ? error.message : String(error)}`); }
	if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new Error("invalid settlement evidence schema");
	const boolean = (key: string): boolean => {
		if (typeof parsed[key] !== "boolean") throw new Error(`settlement evidence requires ${key}`);
		return parsed[key];
	};
	const number = (key: string): number => {
		if (typeof parsed[key] !== "number" || !Number.isInteger(parsed[key])) throw new Error(`settlement evidence requires ${key}`);
		return parsed[key];
	};
	const terminalKind = parsed.terminalKind;
	if (terminalKind !== "completed" && terminalKind !== "cancelled" && terminalKind !== "failed") throw new Error("invalid settlement evidence terminalKind");
	const transport = parseWorkerTransportKind(parsed.transport ?? "herdr");
	return {
		path,
		value: parsed,
		summary: {
			processExitCode: number("processExitCode"),
			terminalKind,
			acpxState: parseAcpxState(parsed.acpxState),
			transport,
			presentationVerified: transport === "headless" ? boolean("presentationVerified") : undefined,
			herdrVisible: transport === "herdr" ? boolean("herdrVisible") : undefined,
			identityMatches: boolean("identityMatches"),
			ledgerValid: boolean("ledgerValid"),
			agentFsExported: boolean("agentFsExported"),
			agentFsViolationCount: number("agentFsViolationCount"),
		},
	};
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "delegate";
}

function graphFromTask(task: string): { graph: GraphKind; task: string } {
	const match = /^(research|explore|search)\s+(.+)$/i.exec(task.trim());
	return match ? { graph: "research", task: match[2] } : { graph: "build", task: task.trim() };
}

function findExecutable(name: string): string {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`${name} is not available on PATH`);
}

function executor(pi: ExtensionAPI, cwd?: string): CommandExecutor {
	return async (command, args) => {
		const result = await pi.exec(command, args, cwd ? { cwd } : undefined);
		return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
	};
}

export async function notifyExhausted(pi: ExtensionAPI, runId: string): Promise<void> {
	const message = `Delegate Graph ${runId} exhausted transient retries and needs your decision.`;
	await Promise.all([
		pi.exec("afplay", ["/System/Library/Sounds/Glass.aiff"]),
		pi.exec("say", [message]),
		pi.exec("osascript", ["-e", `display alert "Delegate Graph" message ${JSON.stringify(message)}`]),
	]);
}

export async function resolveUserDecision(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: GraphStore,
	runId: string,
	operationId: string,
): Promise<Record<string, unknown>> {
	await notifyExhausted(pi, runId);
	if (ctx.mode !== "tui") return { action: "awaiting_user", runId, operationId };
	const choice = await ctx.ui.select("Delegate Graph retries exhausted", ["Retry now", "Defer", "Abort", "Escalate"]);
	if (!choice) return { action: "awaiting_user", runId, operationId };
	if (choice === "Retry now") return { action: "retry", state: store.resolveExhaustion(runId, operationId, "retry") };
	if (choice === "Abort") return { action: "abort", state: store.resolveExhaustion(runId, operationId, "abort") };
	if (choice === "Escalate") return { action: "escalate", state: store.resolveExhaustion(runId, operationId, "escalate") };

	const answer = await ctx.ui.input("Defer operation", "ISO-8601 time or +15m/+2h");
	if (!answer) return { action: "awaiting_user", runId, operationId };
	const runAt = parseDeferredTime(answer);
	const state = store.resolveExhaustion(runId, operationId, "defer", runAt.toISOString());
	const home = dirname(store.dbPath);
	const uid = process.getuid?.() ?? 501;
	const policyDigest = store.policy(runId).digest;
	const job = writeDeferredJob({ home, runId, operationId, policyDigest, runAt, piPath: findExecutable("pi"), uid });
	await installDeferredJob(job, uid, executor(pi));
	return { action: "defer", state, runAt: runAt.toISOString(), plistPath: job.plistPath };
}

export default function delegateGraphExtension(pi: ExtensionAPI): void {
	requireRuntime();
	delegationIdentityExtension(pi);
	routePicker(pi);

	let store: GraphStore | undefined;
	const getStore = () => (store ??= new GraphStore());

	pi.registerTool({
		name: "delegate_graph",
		label: "Delegate Graph",
		description:
			"Operate the durable delegation state machine. Initialize a build, research, or operations run, read pending graph operations with their frozen model route, record dispatches/results, or inspect state. A running dispatch echoes modelPolicy and policyDigest from op=next plus selectedModel and modelAttempt; same-model retryReason and cross-model fallbackReason remain distinct. Graph edges, joins, retry caps, review/test loops, and evidence gates are enforced by the extension.",
		promptSnippet: "Use delegate_graph for every /delegate graph transition; never invent or skip edges.",
		promptGuidelines: [
			"Call op=next before dispatch and op=record for every pending/running/completed/failed operation.",
			"Pass the frozen modelPolicy, policyDigest, route model, and model attempt from op=next unchanged on every dispatch; never open a picker during resume.",
			"Parallelize only operations returned together at a fan-out node; wait for the join before advancing.",
			"Opaque delegates are never polled. Follow retry not-before timestamps and user-decision states exactly.",
		],
		parameters: GraphParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			try {
				const graphStore = getStore();
				const progress = (kind: string, details: Record<string, unknown>) => onUpdate?.(textResult({ kind, ...details }));
				if (params.op === "init") {
					// Direct/headless initialization is deterministic and never invokes the picker.
					const policyInput: ModelPolicyInput = params.modelPolicy ?? { kind: "auto" };
					const resolved = await resolvePolicy(policyInput, executor(pi));
					const state = graphStore.initRun(
						required(params.story, "story"),
						params.graph ?? "build",
						required(params.task, "task"),
						resolved,
						params.commands as OperationalCommandSpec[] | undefined,
					);
					progress("run_created", { runId: state.runId, graph: params.graph ?? "build", status: state.status });
					return textResult({ state, next: graphStore.next(state.runId) });
				}
				const runId = required(params.runId, "runId");
				if (params.op === "next") {
					const next = graphStore.next(runId);
					progress("operations_ready", { runId, operationCount: next.operations.length, status: next.state.status });
					return textResult(next);
				}
				if (params.op === "status") {
					const state = graphStore.getState(runId);
					progress("status", { runId, status: state.status, node: state.currentNode });
					return textResult(renderStatus(graphStore, runId));
				}
				if (params.op === "dispatch") {
					const operationId = required(params.operationId, "operationId");
					const next = graphStore.next(runId);
					const operation = next.operations.find((candidate) => candidate.id === operationId);
					if (!operation) throw new Error(`pending operation ${operationId} not found`);
					if (!operation.route) throw new Error(`operation ${operationId} has no frozen route`);
					const selectedModel = operation.route.chain[operation.model_attempt] ?? operation.route.chain[0];
					if (!selectedModel) throw new Error(`operation ${operationId} has no selected model`);
					const workerTransport = params.transport ? parseWorkerTransportKind(params.transport) : ctx.mode === "tui" ? selectTransport(process.env, "auto") : "headless";
					let dispatchCwd = ctx.cwd;
					if (operation.command_json) {
						const command: unknown = JSON.parse(operation.command_json);
						if (isRecord(command) && typeof command.cwd === "string" && command.cwd) dispatchCwd = command.cwd;
					}
					const execute = executor(pi, dispatchCwd);
					const delegate = join(EXTENSION_DIR, "scripts", "delegate.ts");
					const initialized = await execute(process.execPath, ["--experimental-strip-types", delegate, "--transport", workerTransport, "--", "init", `${runId}-${operationId}`]);
					if (initialized.exitCode !== 0) throw new Error(initialized.stderr || initialized.stdout || "headless init failed");
					const privateRunDir = initialized.stdout.trim();
					const taskFile = join(privateRunDir, "task.md");
					const reportPath = join(privateRunDir, `report-${operationId}.json`);
					writeFileSync(taskFile, `${operation.task}\n`, { mode: 0o600 });
					chmodSync(taskFile, 0o600);
					const role = roleForNode(operation.node);
					const startArgs = ["--experimental-strip-types", delegate, "--transport", workerTransport, "--", "start", privateRunDir, role, "--policy", "auto", "--policy-digest", next.policy.digest, "--model", selectedModel, "--reason", "Air/headless extension-owned dispatch", "--thinking", operation.route.thinking, "--session", String(operation.route.session), "--node", operation.node, "--run-id", runId, "--operation-id", operationId, "--owned-paths-json", operation.owned_paths_json, "--model-attempt", String(operation.model_attempt), "--transient-attempt", String(operation.transient_attempts), "--report", reportPath, "--task-file", taskFile];
					if (operation.command_json) startArgs.push("--command-json", operation.command_json);
					const started = await execute(process.execPath, startArgs);
					if (started.exitCode !== 0) {
						const startOutput = `${started.stderr ?? ""}${started.stdout ?? ""}`;
						const preflight = /worker preflight:/.exec(startOutput);
						if (preflight) {
							const reason = startOutput.slice(preflight.index).split("\n")[0].trim();
							const blocked = graphStore.record({ runId, operationId, status: "failed", error: reason });
							progress("dispatch_blocked_by_preflight", { runId, operationId, reason, status: blocked.state.status, modelAttempt: blocked.operation.model_attempt });
							return textResult({
								runId,
								operationId,
								dispatched: false,
								blocked: "preflight",
								reason,
								state: blocked.state,
								operation: blocked.operation,
								retry: blocked.retry ?? null,
							});
						}
						throw new Error(started.stderr || started.stdout || "headless start failed");
					}
					const launch: unknown = JSON.parse(started.stdout);
					if (!isRecord(launch)) throw new Error("headless start returned invalid identity");
					const launchText = (key: string): string => {
						const value = launch[key];
						if (typeof value !== "string" || !value) throw new Error(`headless start requires ${key}`);
						return value;
					};
					const agentName = launchText("agent");
					const sessionId = launchText("acpx-session");
					const agentId = graphStore.registerAgent({ runId, name: agentName, node: operation.node, role, transport: workerTransport, herdrAgent: workerTransport === "herdr" ? launchText("agent") : undefined, tabId: workerTransport === "herdr" ? launchText("tab") : undefined, herdrPaneId: workerTransport === "herdr" ? launchText("pane") : undefined, policyDigest: next.policy.digest, selectedModel, modelAttempt: operation.model_attempt, acpAgent: parseAcpAgent(launchText("acp-agent")), acpxRecordId: sessionId, acpxSessionId: sessionId, acpxState: "alive", acpxAttemptKey: launchText("acpx-attempt-key"), agentFsSessionId: launchText("agentfs-session"), agentFsDbPath: launchText("agentfs-db"), acpxCancelScript: launchText("acpx-cancel-script"), currentTask: operation.task });
					const result = graphStore.record({ runId, operationId, status: "running", agentId, agentName, transport: workerTransport, modelPolicy: next.policy.input, policyDigest: next.policy.digest, selectedModel, modelAttempt: operation.model_attempt });
					progress("operation_started", { runId, operationId, agentName, transport: workerTransport, status: result.state.status });
					return textResult({ state: result.state, operation: result.operation, agentId, agentName, transport: workerTransport, reportPath, launch });
				}
				if (params.op === "collect") {
					const operationId = required(params.operationId, "operationId");
					const operation = graphStore.getOperation(operationId);
					const agent = graphStore.agents(runId).find((candidate) => candidate.id === operation.agent_id);
					if (!agent?.acpx_cancel_script) throw new Error(`operation ${operationId} has no collectable worker`);
					const privateRunDir = dirname(dirname(dirname(agent.acpx_cancel_script)));
					const existingSettlement = readdirSync(privateRunDir).find((name) => name.startsWith("settlement-") && name.endsWith(".json"));
					let settlement: Record<string, unknown>;
					let settlementEvidencePath: string;
					let cleanupEvidencePath: string | undefined;
					if (existingSettlement) {
						settlementEvidencePath = join(privateRunDir, existingSettlement);
						settlement = JSON.parse(readFileSync(settlementEvidencePath, "utf8"));
						cleanupEvidencePath = typeof settlement.cleanupEvidencePath === "string" ? settlement.cleanupEvidencePath : undefined;
					} else {
						const execute = executor(pi);
						const delegate = join(EXTENSION_DIR, "scripts", "delegate.ts");
						const waited = await execute(process.execPath, ["--experimental-strip-types", delegate, "--transport", agent.transport, "--", "wait", privateRunDir, agent.name]);
						if (waited.exitCode !== 0) {
							const reason = (waited.stderr || waited.stdout || "worker wait failed").trim();
							const diagnostics = retainedFailureDiagnostics(privateRunDir);
							let recorded;
							try {
								recorded = graphStore.record({
									runId,
									operationId,
									status: "failed",
									agentId: agent.id ?? undefined,
									agentName: agent.name,
									error: diagnostics ? `${reason}\nretained worker diagnostics: ${diagnostics}` : reason,
								});
							} catch (recordError) {
								throw new Error(`${reason}${diagnostics ? `\nretained worker diagnostics: ${diagnostics}` : ""}\nand the attempt could not be recorded: ${String(recordError)}`);
							}
							progress("worker_attempt_failed", { runId, operationId, agentName: agent.name, diagnosticsPath: diagnostics ?? null, status: recorded.state.status });
							return textResult({
								runId,
								operationId,
								agentName: agent.name,
								settled: false,
								recorded: "failed",
								reason,
								diagnosticsPath: diagnostics ?? null,
								state: recorded.state,
								operation: recorded.operation,
								retry: recorded.retry ?? null,
							});
						}
						const waitedValue: unknown = JSON.parse(waited.stdout);
						if (!isRecord(waitedValue) || typeof waitedValue.settlementEvidencePath !== "string") throw new Error("headless wait returned invalid settlement");
						settlementEvidencePath = waitedValue.settlementEvidencePath;
						cleanupEvidencePath = typeof waitedValue.cleanupEvidencePath === "string" ? waitedValue.cleanupEvidencePath : undefined;
						settlement = JSON.parse(readFileSync(settlementEvidencePath, "utf8"));
					}
					const reportPath = typeof settlement.reportPath === "string" ? settlement.reportPath : operation.report_path;
					let verdict: string | null = null;
					let report: unknown;
					if (reportPath && existsSync(reportPath)) {
						report = JSON.parse(readFileSync(reportPath, "utf8"));
						if (isRecord(report) && typeof report.verdict === "string") verdict = report.verdict;
					}
					const projectedFailure = projectedAttemptFailure(operation.node, report);
					if (projectedFailure) {
						const diagnostics = retainedFailureDiagnostics(privateRunDir);
						const recorded = graphStore.record({
							runId,
							operationId,
							status: "failed",
							agentId: agent.id ?? undefined,
							agentName: agent.name,
							error: diagnostics ? `${projectedFailure}\nretained worker diagnostics: ${diagnostics}` : projectedFailure,
						});
						progress("worker_attempt_failed", { runId, operationId, agentName: agent.name, reason: "report-missing", diagnosticsPath: diagnostics ?? null, status: recorded.state.status });
						return textResult({
							runId,
							operationId,
							agentName: agent.name,
							settled: false,
							recorded: "failed",
							reason: projectedFailure,
							verdict: null,
							reportPath,
							settlementEvidencePath,
							cleanupEvidencePath,
							diagnosticsPath: diagnostics ?? null,
							state: recorded.state,
							operation: recorded.operation,
							retry: recorded.retry ?? null,
						});
					}
					progress("worker_settled", { runId, operationId, agentName: agent.name, verdict });
					return textResult({ runId, operationId, agentName: agent.name, reportPath, settlementEvidencePath, cleanupEvidencePath, verdict, settlement });
				}
				if (params.op === "resolve") {
					const operationId = required(params.operationId, "operationId");
					const decision = params.decision;
					if (!decision) throw new Error("decision is required");
					const state = graphStore.resolveExhaustion(runId, operationId, decision, params.deferredUntil);
					progress("recovery_resolved", { runId, operationId, decision, status: state.status });
					return textResult({ state, operation: graphStore.getOperation(operationId) });
				}
				if (params.op === "cancel") {
					const operationId = required(params.operationId, "operationId");
					const operation = graphStore.getOperation(operationId);
					const agent = graphStore.agents(runId).find((candidate) => candidate.id === operation.agent_id);
					if (!agent) throw new Error(`running operation ${operationId} has no registered worker`);
					try {
						await cancelRegisteredAgent([agent], agent.name, executor(pi));
					} catch (cancelError) {
						if (agent.acpx_state !== "no-session") throw cancelError;
						progress("cancel_of_dead_attempt", { runId, operationId, agentName: agent.name, reason: String(cancelError) });
					}
					const result = graphStore.record({ runId, operationId, status: "cancelled", agentId: agent.id, agentName: agent.name, transport: agent.transport });
					progress("cancelled", { runId, operationId, agentName: agent.name, status: result.state.status });
					return textResult(result);
				}

				const operationId = required(params.operationId, "operationId");
				const status = required(params.status, "status") as OperationStatus;
				let agentId = params.agentId;
				let transport = params.transport as VisibleTransport | undefined;
				let reportSchemaVersion: number | undefined;
				let acpxProvenance: AcpxRegistrationPayload | undefined;
				if (status === "running") {
					if (!agentId && !params.agentName) throw new Error("running operation requires agentId or agentName");
					required(params.policyDigest, "frozen policy digest");
					if (!params.modelPolicy) throw new Error("running operation requires the frozen modelPolicy from op=next");
					transport = parseWorkerTransportKind(required(params.transport, "worker transport"));
					if (transport === "herdr" && (!params.herdrAgent || !params.tabId)) throw new Error("Herdr dispatch requires herdrAgent and tabId for native identity/focus");
					if (transport === "headless" && (params.herdrAgent !== undefined || params.tabId !== undefined)) throw new Error("headless dispatch cannot contain Herdr identity");
					acpxProvenance = acpxRegistrationPayload(params.payload, transport);
					if (!agentId && params.agentName) {
						const operation = graphStore.getOperation(operationId);
						agentId = graphStore.registerAgent({
							runId,
							name: params.agentName,
							node: operation.node,
							role: roleForNode(operation.node),
							transport,
							herdrAgent: params.herdrAgent,
							tabId: params.tabId,
							policyDigest: params.policyDigest,
							selectedModel: params.selectedModel,
							modelAttempt: params.modelAttempt,
							currentTask: operation.task,
							...acpxProvenance,
						});
					}
				}
				const operation = graphStore.getOperation(operationId);
				const isOperationalSource = operation.node === "source_search";
				let ledgerPath: string | undefined;
				if (status === "completed" || (isOperationalSource && status === "blocked")) {
					const reportPath = required(params.reportPath, "reportPath");
					const audit = await auditReport(reportPath, {
						node: operation.node,
						privateRoot: dirname(reportPath),
						ownedRoots: isOperationalSource ? JSON.parse(operation.owned_paths_json) as string[] : undefined,
					});
					if (!audit.valid) throw new Error(`delegate report rejected: ${formatDiagnostics(audit.errors)}`);
					if (isProjectedSemanticReport(audit.report, operation.node)) {
						throw new Error(`delegate report rejected: projected execution-only report cannot complete the semantic ${operation.node} operation ${operationId}; the worker never authored its report, so redispatch the operation`);
					}
					if (status === "completed") {
						const evidence = acpxSettlementEvidence(params.payload);
						const agent = graphStore.agents(runId).find((candidate) => candidate.id === operation.agent_id);
						if (!agent) throw new Error("settlement evidence has no registered agent");
						if (agent.acpx_state !== "alive") throw new Error(`registered ACPX state is ${agent.acpx_state ?? "unknown"}, expected alive`);
						const registered = (name: string, value: string | null): string => {
							if (!value) throw new Error(`registered agent lacks ${name}`);
							return value;
						};
						const settlementTransport = parseWorkerTransportKind(agent.transport);
						const expected: SettlementIdentityExpected = {
							transport: settlementTransport,
							runId,
							operationId,
							agentName: agent.name,
							herdrAgent: settlementTransport === "herdr" ? registered("herdrAgent", agent.herdr_agent) : undefined,
							tabId: settlementTransport === "herdr" ? registered("tabId", agent.tab_id) : undefined,
							herdrPaneId: settlementTransport === "herdr" ? registered("herdrPaneId", agent.herdr_pane_id) : undefined,
							acpxCancelScript: registered("acpxCancelScript", agent.acpx_cancel_script),
							acpAgent: registered("acpAgent", agent.acp_agent),
							acpxRecordId: registered("acpxRecordId", agent.acpx_record_id),
							acpxSessionId: registered("acpxSessionId", agent.acpx_session_id),
							acpxAttemptKey: registered("acpxAttemptKey", agent.acpx_attempt_key),
							agentFsSessionId: registered("agentFsSessionId", agent.agentfs_session_id),
							agentFsDbPath: registered("agentFsDbPath", agent.agentfs_db_path),
							reportPath,
							reportSha256: createHash("sha256").update(readFileSync(reportPath)).digest("hex"),
						};
						validateSettlementIdentity(evidence.value, expected);
						if (evidence.value.cleanupVerified !== true || typeof evidence.value.cleanupEvidencePath !== "string") throw new Error("settlement evidence cleanup audit is missing");
						let cleanup: unknown;
						try { cleanup = JSON.parse(readFileSync(evidence.value.cleanupEvidencePath, "utf8")); }
						catch (error) { throw new Error(`cleanup evidence unavailable: ${error instanceof Error ? error.message : String(error)}`); }
						if (!isRecord(cleanup) || cleanup.tabAbsent !== true || cleanup.paneAbsent !== true || cleanup.agentAbsent !== true || cleanup.attemptDirectoryAbsent !== true || cleanup.ownedProcessesAbsent !== true || cleanup.sessionClosed !== true) throw new Error("cleanup evidence is incomplete");
						if (dirname(evidence.value.cleanupEvidencePath) !== dirname(reportPath)) throw new Error("cleanup evidence must share the private report directory");
						if (dirname(evidence.path) !== dirname(reportPath)) throw new Error("settlement evidence must share the private report directory");
						if (operation.status !== "running") throw new Error(`graph operation is ${operation.status}, expected running`);
						const settlement = reconcileAcpxSettlementSummary({ ...evidence.summary, reportValid: audit.valid, graphStatus: "running" });
						if (settlement.outcome !== "completed") throw new Error(`ACPX settlement blocked: ${settlement.blockers.join("; ") || settlement.outcome}`);
					}
					reportSchemaVersion = audit.report?.schemaVersion;
					if (params.verdict && audit.verdict !== params.verdict.toUpperCase()) {
						throw new Error(`reported verdict ${audit.verdict} does not match ${params.verdict.toUpperCase()}`);
					}
					params.verdict = audit.verdict;
					if (isOperationalSource) {
						const run = graphStore.getRun(runId);
						ledgerPath = await writeLedgerEntry({
							story: run.story,
							topic: operation.slice_id ?? operation.node,
							operationId,
							runId,
							tier: "tools",
							model: params.selectedModel ?? operation.selected_model ?? "unselected",
							outcome: status === "completed" ? "accepted" : "blocked",
							task: operation.task,
							reportPath,
							base: process.env.DELEGATE_GRAPH_LEDGER_BASE,
						});
					}
				}
				if (status === "failed") required(params.error, "error");
				const result = graphStore.record({
					runId,
					operationId,
					status,
					verdict: params.verdict,
					reportPath: params.reportPath,
					error: params.error,
					agentId,
					agentName: params.agentName,
					transport,
					modelPolicy: params.modelPolicy,
					policyDigest: params.policyDigest,
					selectedModel: params.selectedModel,
					modelAttempt: params.modelAttempt,
					retryReason: params.retryReason,
					fallbackReason: params.fallbackReason,
					payload: { ...params.payload, ...(reportSchemaVersion === undefined ? {} : { reportSchemaVersion }) },
				});
				const progressKind = status === "running" ? "operation_started" : result.requiresUserDecision ? "awaiting_user" : result.retry ? "retrying" : status;
				progress(progressKind, { runId, operationId, status, graphStatus: result.state.status, retryAttempt: result.retry?.attempt ?? null });
				if (isOperationalSource && status === "failed" && !result.retry) {
					const run = graphStore.getRun(runId);
					ledgerPath = await writeLedgerEntry({
						story: run.story,
						topic: operation.slice_id ?? operation.node,
						operationId,
						runId,
						tier: "tools",
						model: params.selectedModel ?? operation.selected_model ?? "unselected",
						outcome: "failed",
						task: operation.task,
						reportPath: params.reportPath ?? join(process.cwd(), `.missing-${operationId}.json`),
						allowInvalidReport: true,
						rejectionDiagnostics: [{ code: "REPORT_UNAVAILABLE", path: "$.report", message: params.error ?? "worker report unavailable" }],
						base: process.env.DELEGATE_GRAPH_LEDGER_BASE,
					});
				}
				if (result.retry) {
					const timer = setTimeout(() => {
						pi.sendUserMessage(
							`Delegate Graph retry ${result.retry?.attempt}/3 is due for run ${runId}, operation ${operationId}. Call delegate_graph op=status, then redispatch the same operation and record it.`,
							{ deliverAs: "followUp" },
						);
					}, result.retry.delayMs);
					timer.unref?.();
				}
				if (result.requiresUserDecision && !isOperationalSource) {
					return textResult({ result, decision: await resolveUserDecision(pi, ctx, graphStore, runId, operationId) });
				}
				return textResult({ ...result, ...(ledgerPath ? { ledgerPath } : {}) });
			} catch (error) {
				return textResult({ error: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	pi.registerCommand("delegate", {
		description: "Start a build or research delegation graph.",
		handler: async (args, ctx) => {
			const parsed = parsePolicyArg(args);
			const raw = parsed.task.trim() || (await ctx.ui.input("Delegate task", "Prefix research tasks with: research"));
			if (!raw) return;
			const selected = graphFromTask(raw);
			const policyInput = await pickPolicy(ctx, parsed.policy);
			const resolved = await resolvePolicy(policyInput, executor(pi));
			const story = `${slug(selected.task)}-${Date.now().toString(36)}`;
			const state = getStore().initRun(story, selected.graph, selected.task, resolved);
			pi.setSessionName(`delegate: ${story}`);
			pi.sendUserMessage(supervisorContract(state.runId, selected.graph, selected.task, getStore().policy(state.runId)));
		},
	});

	pi.registerCommand("graph", {
		description: "Inspect, focus, resume, or prune Delegate Graph runs.",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const graphStore = getStore();
				if (subcommand === "status") {
					ctx.ui.notify(renderStatus(graphStore, required(rest[0], "runId")), "info");
					return;
				}
				if (subcommand === "log") {
					const runId = required(rest[0], "runId");
					const tailIndex = rest.indexOf("--tail");
					const agentIndex = rest.indexOf("--agent");
					const limit = tailIndex >= 0 ? Number(rest[tailIndex + 1]) : 50;
					ctx.ui.notify(renderLog(graphStore, runId, limit, agentIndex >= 0 ? rest[agentIndex + 1] : undefined), "info");
					return;
				}
				if (subcommand === "focus") {
					const runId = required(rest[0], "runId");
					const target = required(rest[1], "node or agent");
					await focusRegisteredAgent(graphStore.agents(runId), target, process.env.HERDR_ENV === "1", executor(pi));
					return;
				}
				if (subcommand === "resume") {
					const runId = required(rest[0], "runId");
					const operationId = required(rest[1], "operationId");
					const state = graphStore.resolveExhaustion(runId, operationId, "retry");
					const digest = graphStore.policy(runId).digest;
					pi.sendUserMessage(`Resume Delegate Graph run ${runId}, operation ${operationId}, with stored policy digest ${digest}. Do not open a picker or re-resolve routes. Call delegate_graph op=next and continue from its frozen modelPolicy, policyDigest, and route.`);
					ctx.ui.notify(`resumed ${state.runId}`, "info");
					return;
				}
				if (subcommand === "prune") {
					const days = Number(rest[0] ?? "30");
					ctx.ui.notify(`pruned ${graphStore.prune(days)} settled runs`, "info");
					return;
				}
				ctx.ui.notify("usage: /graph status|log|focus|resume|prune", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
