import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditReport, formatDiagnostics } from "./scripts/report-audit.ts";
import { renderLog, renderStatus } from "./commands.ts";
import delegationIdentityExtension from "./delegation-identity.ts";
import { supervisorContract } from "./contract.ts";
import { BUILD_GRAPH, RESEARCH_GRAPH } from "./graph-core.ts";
import { focusRegisteredAgent, type CommandExecutor } from "./herdr.ts";
import { installDeferredJob, parseDeferredTime, writeDeferredJob } from "./scheduler.ts";
import routePicker from "./route-picker.ts";
import { GraphStore } from "./store.ts";
import type { VisibleTransport } from "./store.ts";
import type { GraphKind, ModelPolicyInput, OperationStatus, ResolvedPolicy } from "./types.ts";

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);

/** Every graph node role across both graphs; resolution is restricted to these. */
const GRAPH_ROLES = [...new Set([...BUILD_GRAPH.nodes, ...RESEARCH_GRAPH.nodes].map((node) => node.role))];

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
	op: Type.Union([Type.Literal("init"), Type.Literal("next"), Type.Literal("record"), Type.Literal("status")]),
	runId: Type.Optional(Type.String()),
	story: Type.Optional(Type.String()),
	graph: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("research")])),
	task: Type.Optional(Type.String()),
	modelPolicy: Type.Optional(ModelPolicySchema),
	policyDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	selectedModel: Type.Optional(Type.String({ minLength: 1 })),
	modelAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
	retryReason: Type.Optional(Type.String({ minLength: 1 })),
	fallbackReason: Type.Optional(Type.String({ minLength: 1 })),
	operationId: Type.Optional(Type.String()),
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
	transport: Type.Optional(Type.Union([Type.Literal("herdr"), Type.Literal("panel")])),
	herdrAgent: Type.Optional(Type.String()),
	paneId: Type.Optional(Type.String()),
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

function executor(pi: ExtensionAPI): CommandExecutor {
	return async (command, args) => {
		const result = await pi.exec(command, args);
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
	delegationIdentityExtension(pi);
	routePicker(pi);

	let store: GraphStore | undefined;
	const getStore = () => (store ??= new GraphStore());

	pi.registerTool({
		name: "delegate_graph",
		label: "Delegate Graph",
		description:
			"Operate the durable delegation state machine. Initialize a build/research run, read pending graph operations with their frozen model route, record dispatches/results, or inspect state. A running dispatch echoes modelPolicy and policyDigest from op=next plus selectedModel and modelAttempt; same-model retryReason and cross-model fallbackReason remain distinct. Graph edges, joins, retry caps, review/test loops, and evidence gates are enforced by the extension.",
		promptSnippet: "Use delegate_graph for every /delegate graph transition; never invent or skip edges.",
		promptGuidelines: [
			"Call op=next before dispatch and op=record for every pending/running/completed/failed operation.",
			"Pass the frozen modelPolicy, policyDigest, route model, and model attempt from op=next unchanged on every dispatch; never open a picker during resume.",
			"Parallelize only operations returned together at a fan-out node; wait for the join before advancing.",
			"Opaque delegates are never polled. Follow retry not-before timestamps and user-decision states exactly.",
		],
		parameters: GraphParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const graphStore = getStore();
				if (params.op === "init") {
					// Direct/headless initialization is deterministic and never invokes the picker.
					const policyInput: ModelPolicyInput = params.modelPolicy ?? { kind: "auto" };
					const resolved = await resolvePolicy(policyInput, executor(pi));
					const state = graphStore.initRun(
						required(params.story, "story"),
						params.graph ?? "build",
						required(params.task, "task"),
						resolved,
					);
					return textResult({ state, next: graphStore.next(state.runId) });
				}
				const runId = required(params.runId, "runId");
				if (params.op === "next") return textResult(graphStore.next(runId));
				if (params.op === "status") return textResult(renderStatus(graphStore, runId));

				const operationId = required(params.operationId, "operationId");
				const status = required(params.status, "status") as OperationStatus;
				let agentId = params.agentId;
				let transport = params.transport as VisibleTransport | undefined;
				let reportSchemaVersion: number | undefined;
				if (status === "running") {
					if (!agentId && !params.agentName) throw new Error("running operation requires agentId or agentName");
					required(params.policyDigest, "frozen policy digest");
					if (!params.modelPolicy) throw new Error("running operation requires the frozen modelPolicy from op=next");
					transport = required(params.transport, "observable transport") as VisibleTransport;
					if (transport === "herdr" && (!params.herdrAgent || !params.tabId)) {
						throw new Error("Herdr dispatch requires herdrAgent and tabId for native identity/focus");
					}
					if (transport === "panel" && !params.paneId) {
						throw new Error("Panel dispatch requires paneId for visible identity/focus");
					}
					if (!agentId && params.agentName) {
						const operation = graphStore.getOperation(operationId);
						agentId = graphStore.registerAgent({
							runId,
							name: params.agentName,
							node: operation.node,
							role: operation.node,
							transport,
							herdrAgent: params.herdrAgent,
							paneId: params.paneId,
							tabId: params.tabId,
							currentTask: operation.task,
						});
					}
				}
				if (status === "completed") {
					const reportPath = required(params.reportPath, "reportPath");
					const operation = graphStore.getOperation(operationId);
					const audit = await auditReport(reportPath, { node: operation.node, privateRoot: dirname(reportPath) });
					if (!audit.valid) throw new Error(`delegate report rejected: ${formatDiagnostics(audit.errors)}`);
					reportSchemaVersion = audit.report?.schemaVersion;
					if (params.verdict && audit.verdict !== params.verdict.toUpperCase()) {
						throw new Error(`reported verdict ${audit.verdict} does not match ${params.verdict.toUpperCase()}`);
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
				if (result.retry) {
					const timer = setTimeout(() => {
						pi.sendUserMessage(
							`Delegate Graph retry ${result.retry?.attempt}/3 is due for run ${runId}, operation ${operationId}. Call delegate_graph op=status, then redispatch the same operation and record it.`,
							{ deliverAs: "followUp" },
						);
					}, result.retry.delayMs);
					timer.unref?.();
				}
				if (result.requiresUserDecision) {
					return textResult({ result, decision: await resolveUserDecision(pi, ctx, graphStore, runId, operationId) });
				}
				return textResult(result);
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
