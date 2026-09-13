import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isKeyRelease, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { parseRuntimeCandidate, parseRuntimeDecisionKind, parseRuntimeObservation, parseRuntimeOutcome, type RuntimeAttempt, type RuntimeSettlementInput } from "./lib/runtime-results.ts";
import { resolveAcpxPlan } from "./scripts/acpx-plan.ts";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { summarizeAcpxStream, type AcpxStreamSummary } from "./lib/acpx-render.ts";
import { RuntimeContentStore } from "./lib/runtime-content.ts";
import { dirname, join } from "node:path";
import { renderLog, renderStatus } from "./commands.ts";
import delegationIdentityExtension from "./delegation-identity.ts";
import { supervisorContract } from "./contract.ts";
import { BUILD_GRAPH, OPERATIONS_GRAPH, RESEARCH_GRAPH } from "./graph-core.ts";
import { cancelRegisteredAgent, focusRegisteredAgent, type CommandExecutor } from "./herdr.ts";
import { installDeferredJob, parseDeferredTime, writeDeferredJob } from "./scheduler.ts";
import routePicker from "./route-picker.ts";
import { requireRuntime } from "./require-runtime.ts";
import { GraphStore, roleForNode } from "./store.ts";
import { attemptDetail, closeAgentList, isKeyRepeat, noteRegisteredAttempt, renderAgentDetail, renderCancelConfirmation, reopenAgentList, runningWorkerNames, type AgentListActions, type CancelConfirmation, type CancelRunReport } from "./agent-list.ts";
import { parseAcpAgent } from "./lib/acpx-types.ts";
import { parseWorkerTransportKind } from "./lib/worker-transport.ts";
import { DEFAULT_IGNORED_PATHS } from "./lib/agentfs-sandbox.ts";
import { selectTransport } from "./scripts/delegate.ts";
import type { AgentRow, VisibleTransport } from "./store.ts";
import type { GraphKind, ModelPolicyInput, OperationalCommandSpec, OperationRow, ResolvedPolicy } from "./types.ts";

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

/** The only creation flag is --policy; it is consumed before task text. */
export function parseDelegateArgs(raw: string): { policy: ModelPolicyInput | null; task: string } {
	let task = raw.trim();
	let policy: ModelPolicyInput | null = null;
	const flag = /^--policy(?=\s|$)/.exec(task)?.[0];
	if (!flag) return { policy, task };
	const match = /^\s+(\S+)(?:\s+([\s\S]*))?$/.exec(task.slice(flag.length));
	if (!match) throw new Error("--policy requires a value");
	policy = policyInputFromName(match[1]);
	task = (match[2] ?? "").trim();
	if (/^--policy(?=\s|$)/.test(task)) throw new Error("duplicate --policy");
	return { policy, task };
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
	op: Type.Union([Type.Literal("init"), Type.Literal("next"), Type.Literal("record"), Type.Literal("status"), Type.Literal("cancel"), Type.Literal("resolve"), Type.Literal("dispatch"), Type.Literal("collect"), Type.Literal("integrate"), Type.Literal("decide"), Type.Literal("retry"), Type.Literal("watch")]),
	runId: Type.Optional(Type.String()),
	story: Type.Optional(Type.String()),
	graph: Type.Optional(Type.Union([Type.Literal("build"), Type.Literal("research"), Type.Literal("operations")])),
	task: Type.Optional(Type.String()),
	commands: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		command: Type.Object({ executable: Type.String({ minLength: 1 }), args: Type.Array(Type.String()), cwd: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		ownedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		checkpoint: Type.Optional(Type.String({ minLength: 1 })),
	}, { additionalProperties: false }), { minItems: 1 })),
	modelPolicy: Type.Optional(ModelPolicySchema),
	policyDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	selectedModel: Type.Optional(Type.String({ minLength: 1 })),
	modelAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
	transientAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
	retryReason: Type.Optional(Type.String({ minLength: 1 })),
	fallbackReason: Type.Optional(Type.String({ minLength: 1 })),
	operationId: Type.Optional(Type.String()),
	decision: Type.Optional(Type.Union([Type.Literal("retry"), Type.Literal("defer"), Type.Literal("abort"), Type.Literal("escalate"), Type.Literal("accepted"), Type.Literal("rejected")])),
	reason: Type.Optional(Type.String({ minLength: 1 })),
	deferredUntil: Type.Optional(Type.String({ minLength: 1 })),
	status: Type.Optional(Type.Literal("cancelled")),
	verdict: Type.Optional(Type.String()),
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

/**
 * Settles an operation whose authorized command never started. There is no session to cancel, no
 * report to collect and no attempt to replay, so the operation is recorded instead of being
 * refused forever, and a repeated call is a no-op. Nothing is dispatched, so the frozen model
 * policy and attempt counters stay untouched, and the reason text is permanent in retry.ts, so an
 * unlaunched command never consumes the same-model budget or advances the frozen chain.
 */
/**
 * Materializes the run's evidence for a runtime-v1 worker the way legacy workers find report files on
 * disk: the derived ledger and every accepted answer, written read-only into the attempt's private run
 * directory. Without this, review, test and audit workers received only a one-line task and no plan,
 * implementation answer or ledger (2026-09-12 build measurement: the auditor returned FAIL).
 */
export function materializeRuntimeEvidence(graphStore: GraphStore, runId: string, privateRunDir: string): { ledgerPath: string; answers: { node: string; path: string }[]; taskSuffix: string } {
	const dir = join(privateRunDir, "runtime-evidence");
	mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
	const ledgerPath = join(dir, "ledger.json");
	writeFileSync(ledgerPath, `${JSON.stringify(graphStore.runtimeLedger(runId), null, 2)}\n`, { mode: 0o600 }); chmodSync(ledgerPath, 0o600);
	const answersDir = join(dir, "answers");
	mkdirSync(answersDir, { recursive: true, mode: 0o700 }); chmodSync(answersDir, 0o700);
	const content = new RuntimeContentStore(graphStore.dbPath);
	const answers: { node: string; path: string }[] = [];
	for (const operation of graphStore.operations(runId)) {
		if (operation.status !== "completed") continue;
		const attempt = graphStore.runtimeAttemptByOperation(operation.id);
		const answer = attempt?.decision?.decision === "accepted" ? attempt.candidate?.answer ?? null : null;
		if (!answer || answer.bytes === 0) continue;
		const name = `${operation.node}-round${operation.round}-fix${operation.fix_iteration}${operation.slice_id ? `-${operation.slice_id.replace(/[^A-Za-z0-9._-]/g, "_")}` : ""}.md`;
		const path = join(answersDir, name);
		writeFileSync(path, content.read(answer, 16 * 1024 * 1024), { mode: 0o600 }); chmodSync(path, 0o600);
		answers.push({ node: operation.node, path });
	}
	const listed = answers.length ? answers.map((item) => `${item.node}: ${item.path}`).join("; ") : "none yet";
	const taskSuffix = `\n\nRun evidence, derived and read-only (never modify these files): the run ledger is ${ledgerPath}; the accepted answers of completed operations are ${listed}. Changes already integrated from accepted implementation candidates are present in the workspace.\n`;
	return { ledgerPath, answers, taskSuffix };
}

export interface WatchedAgent {
	readonly operationId: string;
	readonly node: string;
	readonly agentName: string | null;
	readonly transport: string | null;
	readonly processState: string | null;
	readonly acceptance: string | null;
	readonly streamPath: string | null;
	readonly lastActivity: string | null;
	readonly recent: readonly string[];
	readonly prompts: number;
	readonly toolCalls: number;
	readonly textBytes: number;
}

export interface WatchView { readonly runId: string; readonly status: string; readonly node: string; readonly agents: readonly WatchedAgent[] }

/** The last bytes of a file, so a long stream is summarized without reading all of it. */
function readTail(path: string, limit: number): string {
	const size = statSync(path).size;
	const start = Math.max(0, size - limit);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally { closeSync(fd); }
}

/**
 * A read-only view of what each running worker is doing right now, rendered from the ACPX stream the runtime
 * is retaining for the attempt. It reads the private files, decides nothing, and is consulted by no gate.
 */
export function watchRun(graphStore: GraphStore, runId: string): WatchView {
	const state = graphStore.getState(runId);
	const agents = graphStore.agents(runId);
	const rows: WatchedAgent[] = [];
	for (const operation of graphStore.operations(runId, true)) {
		if (operation.status !== "running") continue;
		const agent = agents.find((candidate) => candidate.id === operation.agent_id);
		const attempt = graphStore.runtimeAttemptByOperation(operation.id);
		let streamPath: string | null = null;
		let summary: AcpxStreamSummary | null = null;
		if (agent?.acpx_cancel_script) {
			const candidate = join(dirname(agent.acpx_cancel_script), "runtime-output", "worker.stdout.ndjson");
			if (existsSync(candidate)) { streamPath = candidate; summary = summarizeAcpxStream(readTail(candidate, 256 * 1024)); }
		}
		rows.push({ operationId: operation.id, node: operation.node, agentName: agent?.name ?? null, transport: agent?.transport ?? null, processState: attempt?.processState ?? null, acceptance: attempt?.acceptance ?? null, streamPath, lastActivity: summary?.lastActivity ?? null, recent: summary?.recent ?? [], prompts: summary?.prompts ?? 0, toolCalls: summary?.toolCalls ?? 0, textBytes: summary?.textBytes ?? 0 });
	}
	return { runId, status: state.status, node: state.currentNode, agents: rows };
}

export function renderWatch(view: WatchView): string {
	const lines = [`run ${view.runId} | node=${view.node} | status=${view.status}`];
	if (!view.agents.length) lines.push("(no running workers)");
	for (const agent of view.agents) {
		lines.push(`${agent.agentName ?? agent.operationId} | ${agent.node} | ${agent.processState ?? "unregistered"} | tools=${agent.toolCalls} | ${agent.lastActivity ?? (agent.streamPath ? "(no output yet)" : "(no stream)")}`);
		for (const recent of agent.recent.slice(0, -1)) lines.push(`    ${recent}`);
	}
	return lines.join("\n");
}

/**
 * The operator's cancel-all for one run: every running worker's process is stopped through its structured
 * cancel script and its attempt is settled as cancelled, then the run's running operations and the run
 * itself are recorded cancelled in one transaction. A worker whose stop cannot be confirmed is reported by
 * name; the run is still recorded cancelled, because that is what the operator asked for.
 */
export async function cancelRunWorkers(graphStore: GraphStore, pi: ExtensionAPI, runId: string): Promise<CancelRunReport> {
	const state = graphStore.getState(runId);
	if (state.status !== "active") throw new Error(`run ${runId} is ${state.status}; nothing to cancel`);
	const agents = graphStore.agents(runId);
	const cancelled: string[] = [];
	const failed: { agentName: string; error: string }[] = [];
	for (const operation of graphStore.operations(runId, true).filter((candidate) => candidate.status === "running")) {
		const agent = agents.find((candidate) => candidate.id === operation.agent_id);
		if (!agent) continue;
		try {
			await cancelRegisteredAgent([agent], agent.name, executor(pi));
		} catch (error) {
			if (agent.acpx_state !== "no-session") { failed.push({ agentName: agent.name, error: error instanceof Error ? error.message : String(error) }); continue; }
		}
		const attempt = graphStore.runtimeAttemptByOperation(operation.id);
		if (attempt && !attempt.outcome) graphStore.settleRuntimeAttempt({ attemptKey: attempt.attemptKey, outcome: { kind: "cancelled", signal: null } });
		cancelled.push(agent.name);
	}
	const reason = failed.length ? `operator cancelled the run; ${failed.map((item) => item.agentName).join(", ")} could not be confirmed stopped` : "operator cancelled the run";
	const result = graphStore.cancelRunningOperations(runId, reason);
	return { runId, cancelled, failed, status: result.state.status };
}

function listActions(graphStore: GraphStore, pi: ExtensionAPI): AgentListActions {
	return { cancelRun: (runId) => cancelRunWorkers(graphStore, pi, runId) };
}

/** The follow view: the watch overview redrawn in a widget while the operator holds it open; a number plus Enter opens that worker's details. */
export function renderFollow(view: WatchView, pending = "", confirmation: CancelConfirmation | null = null, cursorIndex: number | null = null, cancelling = false): string[] {
	const lines = [`watch ${view.runId} | node=${view.node} | status=${view.status} | ${cursorIndex === null ? "keys: Enter opens the running worker or focuses the list, up/down move, number then Enter opens by number, r refresh, q close, Esc cancels the run's workers" : "focused: up/down move, Enter opens, q unfocuses, Esc cancels the run's workers"}`];
	if (!view.agents.length) lines.push(view.status === "active" ? "(no running workers; dispatch pending operations to see them here)" : `(run is ${view.status}; nothing is running)`);
	view.agents.forEach((agent, index) => {
		const mark = cursorIndex === null ? "" : cursorIndex === index ? "\u203a " : "  ";
		lines.push(`${mark}${index + 1}. ${agent.agentName ?? agent.operationId} | ${agent.node} | ${agent.processState ?? "unregistered"} | tools=${agent.toolCalls} | ${agent.lastActivity ?? (agent.streamPath ? "(no output yet)" : "(no stream)")}`);
		for (const recent of agent.recent.slice(-3, -1)) lines.push(`     ${recent}`);
	});
	if (pending) lines.push(`selecting: ${pending}_ (Enter opens, Esc clears)`);
	if (confirmation) lines.push(...renderCancelConfirmation(confirmation, cancelling));
	return lines;
}

const FOLLOW_WIDGET = "delegate-graph-watch";
let followSession: { runId: string; timer: ReturnType<typeof setInterval> | null; unsubscribe: () => void; ctx: ExtensionContext } | null = null;

function stopFollow(reason: string): void {
	const session = followSession;
	if (!session) return;
	followSession = null;
	if (session.timer) clearInterval(session.timer);
	session.unsubscribe();
	session.ctx.ui.setWidget(FOLLOW_WIDGET, undefined);
	session.ctx.ui.notify(`watch ${session.runId} closed (${reason})`, "info");
}

/**
 * Keeps the watch overview on screen and current while the operator holds it open. The redraw timer exists
 * only for that time: it stops when the run leaves `active`, when the operator presses q, or when a new
 * follow replaces it. A number plus Enter opens that worker's details, bound to its attempt, rendered the
 * same way as the agent list; bringing a Herdr tab forward stays with `/graph focus`. Keys reach the view
 * only while the editor is empty.
 */
/** The redraw interval for interactive views, from the environment with a floor so a typo cannot spin the terminal. */
export function watchIntervalMs(): number {
	const interval = Number.parseInt(process.env.PI_GRAPH_WATCH_INTERVAL_MS ?? "2000", 10);
	return Number.isFinite(interval) && interval >= 50 ? interval : 2000;
}

export function startFollow(pi: ExtensionAPI, ctx: ExtensionContext, graphStore: GraphStore, runId: string, intervalMs: number): void {
	stopFollow("replaced");
	closeAgentList("replaced by watch --follow");
	graphStore.getRun(runId);
	let latest: WatchView = watchRun(graphStore, runId);
	let pending = "";
	let selected: { number: number; attemptKey: string; operationId: string } | null = null;
	let confirming: CancelConfirmation | null = null;
	let cancelling = false;
	let cursorOperation: string | null = null;
	const cursorIndex = () => (cursorOperation === null ? null : latest.agents.findIndex((agent) => agent.operationId === cursorOperation));
	const draw = () => {
		latest = watchRun(graphStore, runId);
		// The cursor follows the worker; when its operation leaves the running set the cursor moves to the first row.
		if (cursorOperation !== null && cursorIndex() === -1) cursorOperation = latest.agents[0]?.operationId ?? null;
		if (selected) {
			try { ctx.ui.setWidget(FOLLOW_WIDGET, renderAgentDetail(attemptDetail(graphStore, { number: selected.number, attemptKey: selected.attemptKey, runId, operationId: selected.operationId }), confirming, cancelling)); }
			catch (error) { ctx.ui.setWidget(FOLLOW_WIDGET, [`agent ${selected.number}: details unavailable (${error instanceof Error ? error.message : String(error)}) | keys: q back to list, r refresh, Esc cancels the run's workers`, ...(confirming ? renderCancelConfirmation(confirming, cancelling) : [])]); }
		} else {
			ctx.ui.setWidget(FOLLOW_WIDGET, renderFollow(latest, pending, confirming, cursorIndex(), cancelling));
		}
		if (latest.status !== "active" && followSession?.timer) { clearInterval(followSession.timer); followSession.timer = null; }
	};
	const abortCancellation = () => { confirming = null; draw(); ctx.ui.notify(`cancellation of run ${runId} aborted; nothing was cancelled`, "info"); };
	const confirmCancellation = () => {
		if (!confirming || cancelling) return;
		cancelling = true;
		draw();
		cancelRunWorkers(graphStore, pi, runId).then((report) => {
			const failures = report.failed.length ? `; ${report.failed.length} could not be confirmed stopped: ${report.failed.map((item) => `${item.agentName} (${item.error})`).join("; ")}` : "";
			ctx.ui.notify(`run ${report.runId} ${report.status}: cancelled ${report.cancelled.length} worker${report.cancelled.length === 1 ? "" : "s"}${report.cancelled.length ? ` (${report.cancelled.join(", ")})` : ""}${failures}`, report.failed.length ? "warning" : "info");
		}).catch((error: unknown) => {
			ctx.ui.notify(`cancellation of run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}).finally(() => { cancelling = false; confirming = null; if (followSession?.runId === runId) draw(); });
	};
	const unsubscribe = ctx.ui.onTerminalInput((data) => {
		if (ctx.ui.getEditorText?.()) return undefined;
		if (isKeyRelease(data)) return undefined;
		if (isKeyRepeat(data) && !matchesKey(data, "up") && !matchesKey(data, "down")) return { consume: true };
		if (cancelling && (matchesKey(data, "escape") || matchesKey(data, "enter") || parseKey(data) === "q")) {
			ctx.ui.notify(`cancellation of run ${runId} is in progress; wait for its report`, "info");
			return { consume: true };
		}
		const key = parseKey(data) ?? data;
		if (/^[0-9]$/.test(key)) {
			if (selected) return undefined;
			pending += key; draw();
			return { consume: true };
		}
		const openAgent = (index: number) => {
			const agent = latest.agents[index];
			const attempt = agent ? graphStore.runtimeAttemptByOperation(agent.operationId) : null;
			if (!agent || !attempt) ctx.ui.notify(`no worker ${index + 1} in the watch view`, "warning");
			else selected = { number: index + 1, attemptKey: attempt.attemptKey, operationId: agent.operationId };
		};
		if (matchesKey(data, "enter")) {
			if (confirming) { confirmCancellation(); return { consume: true }; }
			if (pending) { const number = Number(pending); pending = ""; openAgent(number - 1); draw(); return { consume: true }; }
			if (selected) return { consume: true };
			const index = cursorIndex();
			if (index !== null && index >= 0) openAgent(index);
			else if (latest.agents.length === 1) openAgent(0);
			else if (latest.agents.length === 0) ctx.ui.notify(`run ${runId} has no running worker to open`, "info");
			else cursorOperation = latest.agents[0]!.operationId;
			draw();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const index = cursorIndex();
			if (index === null || selected) return undefined;
			const next = Math.min(latest.agents.length - 1, Math.max(0, (index < 0 ? 0 : index) + (matchesKey(data, "down") ? 1 : -1)));
			cursorOperation = latest.agents[next]?.operationId ?? null;
			draw();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			if (pending) { pending = ""; draw(); return { consume: true }; }
			if (confirming) { abortCancellation(); return { consume: true }; }
			const names = runningWorkerNames(graphStore, runId);
			if (!names.length) { ctx.ui.notify(`run ${runId} has no running workers to cancel`, "info"); return { consume: true }; }
			confirming = { runId, names }; draw();
			return { consume: true };
		}
		if (key === "q") {
			if (pending) { pending = ""; draw(); return { consume: true }; }
			if (confirming) { abortCancellation(); return { consume: true }; }
			if (selected) { selected = null; draw(); return { consume: true }; }
			if (cursorOperation !== null) { cursorOperation = null; draw(); return { consume: true }; }
			stopFollow("closed by operator");
			return { consume: true };
		}
		if (key === "r") { draw(); return { consume: true }; }
		return undefined;
	});
	const timer = setInterval(draw, intervalMs);
	timer.unref?.();
	followSession = { runId, timer, unsubscribe, ctx };
	draw();
}

function runtimeSettlementFile(privateRunDir: string): string | undefined {
	const name = readdirSync(privateRunDir).find((entry) => entry.startsWith("runtime-settlement-") && entry.endsWith(".json"));
	return name ? join(privateRunDir, name) : undefined;
}

function settlementFromEvidence(attemptKey: string, evidencePath: string): RuntimeSettlementInput {
	const evidence: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
	if (!isRecord(evidence) || evidence.resultContract !== "runtime-v1" || evidence.attemptKey !== attemptKey) throw new Error("runtime settlement evidence does not belong to this attempt");
	return {
		attemptKey,
		outcome: parseRuntimeOutcome(evidence.outcome),
		candidate: evidence.candidate === null || evidence.candidate === undefined ? undefined : parseRuntimeCandidate(evidence.candidate),
		observation: evidence.observation === null || evidence.observation === undefined ? undefined : parseRuntimeObservation(evidence.observation),
	};
}

/**
 * Settles a runtime-v1 attempt from durable evidence. The process outcome and retained candidate are
 * facts written before any close or cleanup; a failure after them is reported, never used to discard
 * the candidate, and acceptance remains an explicit op=decide call.
 */
async function collectRuntimeAttempt(graphStore: GraphStore, pi: ExtensionAPI, runId: string, operationId: string, agent: AgentRow, privateRunDir: string, progress: (kind: string, details: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
	const attemptKey = agent.acpx_attempt_key;
	if (!attemptKey) throw new Error(`operation ${operationId} has no runtime attempt key`);
	const registered = graphStore.runtimeAttempt(attemptKey);
	const postSettlementFailures: string[] = [];
	const configurationSelfWrites: Record<string, unknown>[] = [];
	let captureRetainedPath: string | undefined;
	let cleanupEvidencePath: string | undefined;
	let settlementEvidencePath = registered.outcome ? undefined : runtimeSettlementFile(privateRunDir);
	if (!registered.outcome && !settlementEvidencePath) {
		const execute = executor(pi);
		const delegate = join(EXTENSION_DIR, "scripts", "delegate.ts");
		const waited = await execute(process.execPath, ["--experimental-strip-types", delegate, "--transport", agent.transport, "--", "wait", privateRunDir, agent.name]);
		if (waited.exitCode !== 0) {
			const reason = (waited.stderr || waited.stdout || "worker wait failed").trim();
			settlementEvidencePath = runtimeSettlementFile(privateRunDir);
			if (!settlementEvidencePath) {
				const diagnostics = retainedFailureDiagnostics(privateRunDir);
				const attempt = graphStore.settleRuntimeAttempt({ attemptKey, outcome: { kind: "failed", exitCode: null, error: diagnostics ? `${reason}\nretained worker diagnostics: ${diagnostics}` : reason } });
				progress("runtime_attempt_failed", { runId, operationId, agentName: agent.name, attemptKey, diagnosticsPath: diagnostics ?? null });
				return { runId, operationId, agentName: agent.name, attempt, settled: true, candidate: null, reason, diagnosticsPath: diagnostics ?? null, state: graphStore.getState(runId), operation: graphStore.getOperation(operationId) };
			}
			postSettlementFailures.push(reason);
		} else {
			const waitedValue: unknown = JSON.parse(waited.stdout);
			if (!isRecord(waitedValue) || typeof waitedValue.settlementEvidencePath !== "string") throw new Error("runtime wait returned invalid settlement");
			settlementEvidencePath = waitedValue.settlementEvidencePath;
			cleanupEvidencePath = typeof waitedValue.cleanupEvidencePath === "string" ? waitedValue.cleanupEvidencePath : undefined;
			if (Array.isArray(waitedValue.postSettlementFailures)) postSettlementFailures.push(...waitedValue.postSettlementFailures.filter((item): item is string => typeof item === "string"));
			if (Array.isArray(waitedValue.configurationSelfWrites)) configurationSelfWrites.push(...waitedValue.configurationSelfWrites.filter(isRecord));
			if (typeof waitedValue.captureRetainedPath === "string") captureRetainedPath = waitedValue.captureRetainedPath;
		}
	}
	const attempt = registered.outcome ? registered : graphStore.settleRuntimeAttempt(settlementFromEvidence(attemptKey, required(settlementEvidencePath, "runtime settlement evidence")));
	progress("runtime_attempt_settled", { runId, operationId, agentName: agent.name, attemptKey, processState: attempt.processState, candidate: attempt.candidate?.kind ?? null, acceptance: attempt.acceptance, postSettlementFailures: postSettlementFailures.length, configurationSelfWrites: configurationSelfWrites.length });
	return { runId, operationId, agentName: agent.name, attempt, settled: true, candidate: attempt.candidate?.kind ?? null, ...decisionBrief(graphStore, runId, operationId, attempt), settlementEvidencePath: settlementEvidencePath ?? null, cleanupEvidencePath: cleanupEvidencePath ?? null, captureRetainedPath: captureRetainedPath ?? null, postSettlementFailures, configurationSelfWrites, state: graphStore.getState(runId), operation: graphStore.getOperation(operationId) };
}

const ANSWER_PREVIEW_BYTES = 16 * 1024;
/** Nodes whose worker prompt ends the answer with a VERDICT line (mirrors RUNTIME_VERDICT_NODES in scripts/delegate_core.py). */
const VERDICT_NODES: Partial<Record<string, readonly string[]>> = { review: ["PASS", "FAIL"], test: ["GREEN", "NOT_OK"], audit: ["PASS", "FAIL"], source_search: ["DONE", "BLOCKED"] };

/**
 * What the supervisor needs in order to decide a settled candidate, so it never has to find the answer on disk:
 * the retained answer (bounded), the answer's final VERDICT line when the node carries one, and a template of
 * the op=decide call for this node. It reads retained content and graph state; it decides nothing.
 */
export function decisionBrief(graphStore: GraphStore, runId: string, operationId: string, attempt: RuntimeAttempt): Record<string, unknown> {
	const operation = graphStore.getOperation(operationId);
	const reference = attempt.candidate?.answer ?? null;
	let answer: string | null = null;
	if (reference && reference.bytes > 0) answer = new RuntimeContentStore(graphStore.dbPath).read(reference, ANSWER_PREVIEW_BYTES).toString("utf8");
	const verdictLines = answer ? [...answer.matchAll(/^\s*VERDICT:\s*([A-Z_]+)\s*$/gm)] : [];
	const verdict = verdictLines.length ? verdictLines[verdictLines.length - 1]![1]! : null;
	const expectedVerdicts = VERDICT_NODES[operation.node] ?? null;
	// The operations graph advances from synthesis only on DONE (graph-core.ts), but the worker prompt asks no
	// VERDICT of a thinker: the supervisor supplies DONE when the synthesis is complete.
	const operationsSynthesis = operation.node === "thinker_synthesize" && graphStore.getState(runId).graph === "operations";
	const needsSlices = operation.node === "thinker_plan" || operation.node === "thinker_split";
	const decide: Record<string, unknown> = { op: "decide", runId, operationId, decision: "accepted | rejected", reason: "<required: why the answer is accepted or rejected>" };
	if (expectedVerdicts) decide.verdict = verdict ?? `<the answer has no VERDICT line; expected one of ${expectedVerdicts.join("|")}>`;
	if (operationsSynthesis) decide.verdict = verdict ?? "DONE";
	if (needsSlices) decide.payload = { slices: [{ id: "<slug>", name: "<short name>", task: "<what one worker does>", ...(operation.node === "thinker_plan" ? { ownedPaths: ["<paths this slice may change; disjoint across slices>"] } : {}) }] };
	const kind = attempt.candidate?.kind ?? null;
	const note = !attempt.candidate
		? "No candidate was retained; a failed or interrupted attempt is replaced with op=retry."
		: needsSlices
			? "Derive payload.slices from the retained answer; each slice becomes one parallel worker at the next node."
			: kind === "coding" || kind === "operational"
				? "Call op=integrate for this operationId before op=decide accepted."
				: expectedVerdicts && !verdict
					? "The answer lacks the VERDICT line this node requires; decide rejected with that reason or supply the verdict the answer supports."
					: operationsSynthesis
						? "Operations synthesis advances to the audit only with verdict DONE; the worker was not asked for a VERDICT line, so pass DONE when the synthesis is complete and reject otherwise."
						: "Read the retained answer, then op=decide.";
	return { answer, answerBytes: reference?.bytes ?? 0, answerTruncated: (reference?.bytes ?? 0) > ANSWER_PREVIEW_BYTES, verdict, decide, note };
}

function settleUnlaunchedOperation(graphStore: GraphStore, runId: string, operation: OperationRow, status: "failed" | "cancelled"): Record<string, unknown> {
	if (operation.status !== "pending" && operation.status !== "running") return { settled: false, reason: `operation already ${operation.status}` };
	// Checked before anything is written: a mistyped runId is a refusal, not a place to put a file.
	// Without these, an id containing `..` would materialize a diagnostic wherever it resolved, and a
	// foreign run would settle an operation the caller has no authority over. Both refusals repeat
	// what `record` would have said after the write, so the write only happens when it can be honoured.
	const run = graphStore.getRun(runId);
	if (run.id !== operation.run_id) throw new Error("operation does not belong to run");
	if (run.status !== "active") throw new Error(`run ${runId} is ${run.status}; resolve it before recording operations`);
	const reason = `no worker was registered for operation ${operation.id}: the authorized command never started`;
	const diagnosticsPath = graphStore.retainRunDiagnostic(runId, `failure-${operation.id}.json`, {
		schemaVersion: 1,
		cause: reason,
		runId,
		operationId: operation.id,
		node: operation.node,
		round: operation.round,
		fixIteration: operation.fix_iteration,
		previousStatus: operation.status,
		modelAttempt: operation.model_attempt,
		selectedModel: operation.selected_model,
		settledAt: new Date().toISOString(),
	});
	const recorded = graphStore.record({ runId, operationId: operation.id, status, error: `${reason}\nretained diagnostics: ${diagnosticsPath}` });
	return { settled: true, recorded: status, reason, diagnosticsPath, state: recorded.state, operation: recorded.operation };
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

export function notifyExhausted(ctx: ExtensionContext, runId: string): void {
	// In-session only: the former afplay/say/osascript trio opened a modal macOS alert
	// that blocked headless gate runs until dismissed.
	if (ctx.mode !== "tui") return;
	ctx.ui.notify(`Delegate Graph ${runId} exhausted transient retries and needs your decision.`, "warning");
}

export async function resolveUserDecision(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: GraphStore,
	runId: string,
	operationId: string,
): Promise<Record<string, unknown>> {
	notifyExhausted(ctx, runId);
	if (ctx.mode !== "tui") return { action: "awaiting_user", runId, operationId };
	const choice = await ctx.ui.select("Delegate Graph retries exhausted", ["Retry now", "Defer", "Abort", "Escalate"]);
	if (!choice) return { action: "awaiting_user", runId, operationId };
	if (choice === "Retry now") return { action: "retry", state: store.retryRuntimeAttempt({ runId, operationId, approved: true }).state };
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
			"Operate the durable delegation state machine. Initialize a build, research, or operations run, read pending graph operations with their frozen model route, dispatch and collect workers, decide their retained answers, or inspect state. A running dispatch echoes modelPolicy and policyDigest from op=next plus selectedModel and modelAttempt; same-model retryReason and cross-model fallbackReason remain distinct. Graph edges, joins, retry caps, review/test loops, and evidence gates are enforced by the extension.",
		promptSnippet: "Use delegate_graph for every /delegate graph transition; never invent or skip edges.",
		promptGuidelines: [
			"Per operation: op=next, op=dispatch, op=collect, op=decide, then op=next again. op=record is only for status=cancelled.",
			"op=collect returns the retained answer, its VERDICT line and a decide template: reuse that template's operationId, verdict and payload shape in op=decide.",
			"op=decide takes decision accepted or rejected plus a reason; thinker_plan and thinker_split also need payload.slices (id, name, task, ownedPaths on the build graph); coding and operational candidates need op=integrate first.",
			"op=resolve (retry, defer, abort, escalate) is only for a parked run (awaiting_user, deferred, blocked); it is refused while the run is active.",
			"Pass the frozen modelPolicy, policyDigest, route model, and model attempt from op=next unchanged on every dispatch; never open a picker during resume.",
			"Parallelize only operations returned together at a fan-out node; wait for the join before advancing.",
			"Opaque delegates are never polled. Follow retry not-before timestamps and user-decision states exactly.",
			"On runtime-v1 runs a failed or interrupted attempt is replaced only through op=retry, which applies the frozen same-model budget and chain fallback; an exited attempt must be decided with op=decide.",
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
				graphStore.getRun(runId);
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
				if (params.op === "watch") {
					const view = watchRun(graphStore, runId);
					progress("watch", { runId, status: view.status, node: view.node, agents: view.agents.map((agent) => ({ agentName: agent.agentName, node: agent.node, processState: agent.processState, lastActivity: agent.lastActivity })) });
					return textResult(view);
				}
				if (params.op === "dispatch") {
					const operationId = required(params.operationId, "operationId");
					const next = graphStore.next(runId);
					if (next.state.status !== "active") throw new Error(`run ${runId} is ${next.state.status}; resolve it before dispatching operations`);
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
					const evidence = materializeRuntimeEvidence(graphStore, runId, privateRunDir);
					writeFileSync(taskFile, `${operation.task}\n${evidence.taskSuffix}`, { mode: 0o600 });
					chmodSync(taskFile, 0o600);
					progress("runtime_evidence_materialized", { runId, operationId, ledgerPath: evidence.ledgerPath, answers: evidence.answers.length });
					const role = roleForNode(operation.node);
					const startArgs = ["--experimental-strip-types", delegate, "--transport", workerTransport, "--", "start", privateRunDir, role, "--policy", "auto", "--policy-digest", next.policy.digest, "--model", selectedModel, "--reason", "Air/headless extension-owned dispatch", "--thinking", operation.route.thinking, "--session", String(operation.route.session), "--node", operation.node, "--run-id", runId, "--operation-id", operationId, "--owned-paths-json", operation.owned_paths_json, "--ignored-paths-json", JSON.stringify(DEFAULT_IGNORED_PATHS), "--access-mode", operation.read_only === 1 ? "read-only" : "owned-write", "--model-attempt", String(operation.model_attempt), "--transient-attempt", String(operation.transient_attempts), "--task-file", taskFile];
					if (operation.command_json) startArgs.push("--command-json", operation.command_json);
					const started = await execute(process.execPath, startArgs);
					if (started.exitCode !== 0) {
						const startOutput = `${started.stderr ?? ""}${started.stdout ?? ""}`;
						const preflight = /worker preflight:/.exec(startOutput);
						if (preflight) {
							const reason = startOutput.slice(preflight.index).split("\n")[0].trim();
							// No worker was registered, so the launch failure is classified through the fenced replacement path.
							const blocked = graphStore.retryRuntimeAttempt({ runId, operationId, error: reason, launched: { modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts } });
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
					{
						// The launch identity is re-derived from frozen graph facts and must reproduce the worker's attempt key.
						const identity = resolveAcpxPlan({ runId, operationId, role, modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel, transport: workerTransport, herdrAgent: workerTransport === "herdr" ? launchText("agent") : undefined, herdrTabId: workerTransport === "herdr" ? launchText("tab") : undefined, herdrPaneId: workerTransport === "herdr" ? launchText("pane") : undefined });
						if (identity.attemptKey !== launchText("acpx-attempt-key")) throw new Error("launched worker attempt key does not match the frozen operation identity");
						const attempt = graphStore.beginRuntimeAttempt({ identity, sessionId, requestId: null, policyDigest: next.policy.digest, agentId });
						progress("runtime_attempt_registered", { runId, operationId, agentName, transport: workerTransport, attemptKey: attempt.attemptKey });
						// The worker is registered; presentation runs after that fact and a UI failure cannot reclassify the dispatch.
						try {
							if (ctx.mode === "tui") stopFollow("replaced by agent list");
							noteRegisteredAttempt(graphStore, ctx, { attemptKey: attempt.attemptKey, runId, operationId }, watchIntervalMs(), listActions(graphStore, pi));
						} catch (error) {
							ctx.ui.notify(`agent list unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
						}
						return textResult({ state: graphStore.getState(runId), operation: graphStore.getOperation(operationId), attempt, agentId, agentName, transport: workerTransport, launch });
					}
				}
				if (params.op === "collect") {
					const operationId = required(params.operationId, "operationId");
					const operation = graphStore.getOperation(operationId);
					const agent = graphStore.agents(runId).find((candidate) => candidate.id === operation.agent_id);
					if (!agent) throw new Error(`operation ${operationId} has no registered runtime attempt to collect`);
					if (!agent.acpx_cancel_script) throw new Error(`operation ${operationId} has no collectable worker`);
					const privateRunDir = dirname(dirname(dirname(agent.acpx_cancel_script)));
					return textResult(await collectRuntimeAttempt(graphStore, pi, runId, operationId, agent, privateRunDir, progress));
				}
				if (params.op === "integrate") {
					const operationId = required(params.operationId, "operationId");
					const attempt = graphStore.runtimeAttemptByOperation(operationId);
					if (!attempt) throw new Error(`operation ${operationId} has no registered runtime attempt`);
					const manifest = attempt.observation?.manifest ?? null;
					if (!manifest) throw new Error("integration requires a settled coding candidate with an observed staging manifest");
					const direction = params.decision === "rejected" ? "rollback" : "apply";
					const status = graphStore.applyRuntimeIntegration(attempt.attemptKey, manifest, direction);
					progress("runtime_integration", { runId, operationId, attemptKey: attempt.attemptKey, direction, state: status.state });
					return textResult({ runId, operationId, attemptKey: attempt.attemptKey, integration: status });
				}
				if (params.op === "decide") {
					const operationId = required(params.operationId, "operationId");
					const attempt = graphStore.runtimeAttemptByOperation(operationId);
					if (!attempt) throw new Error(`operation ${operationId} has no registered runtime attempt`);
					if (params.decision === "retry" || params.decision === "defer" || params.decision === "abort" || params.decision === "escalate") throw new Error(`op=decide takes accepted or rejected with a reason; ${params.decision} is an op=resolve choice for a parked run`);
					const decision = parseRuntimeDecisionKind(params.decision);
					const decided = graphStore.decideRuntimeCandidate({ attemptKey: attempt.attemptKey, decision, reason: required(params.reason, "reason"), verdict: params.verdict, payload: params.payload });
					progress("runtime_candidate_decided", { runId, operationId, decision, status: decided.state.status, node: decided.state.currentNode });
					return textResult({ runId, operationId, ...decided, next: decided.state.status === "active" ? graphStore.next(runId) : null });
				}
				if (params.op === "retry") {
					const operationId = required(params.operationId, "operationId");
					const launched = params.modelAttempt !== undefined && params.transientAttempt !== undefined ? { modelAttempt: params.modelAttempt, transientAttempt: params.transientAttempt } : undefined;
					const retried = graphStore.retryRuntimeAttempt({ runId, operationId, error: params.error, retryReason: params.retryReason, launched });
					progress(retried.exhausted ? "runtime_retry_exhausted" : "runtime_attempt_replaced", { runId, operationId, classification: retried.classification, status: retried.state.status, modelAttempt: retried.operation.model_attempt, transientAttempt: retried.operation.transient_attempts, notBefore: retried.retry?.notBefore ?? null });
					return textResult({ runId, operationId, ...retried, next: retried.state.status === "active" ? graphStore.next(runId) : null });
				}
				if (params.op === "resolve") {
					const operationId = required(params.operationId, "operationId");
					const decision = params.decision;
					if (!decision) throw new Error("decision is required");
					if (decision === "accepted" || decision === "rejected") throw new Error("op=resolve takes retry, defer, abort or escalate; candidate decisions use op=decide");
					if (decision === "retry") {
						const retried = graphStore.retryRuntimeAttempt({ runId, operationId, approved: true, retryReason: params.retryReason });
						progress("recovery_resolved", { runId, operationId, decision, status: retried.state.status });
						return textResult({ state: retried.state, operation: retried.operation, previousAttempt: retried.previousAttempt });
					}
					const state = graphStore.resolveExhaustion(runId, operationId, decision, params.deferredUntil);
					progress("recovery_resolved", { runId, operationId, decision, status: state.status });
					return textResult({ state, operation: graphStore.getOperation(operationId) });
				}
				if (params.op === "cancel") {
					const operationId = required(params.operationId, "operationId");
					const operation = graphStore.getOperation(operationId);
					const agent = graphStore.agents(runId).find((candidate) => candidate.id === operation.agent_id);
					if (!agent) {
						const settled = settleUnlaunchedOperation(graphStore, runId, operation, "cancelled");
						progress("unlaunched_operation_settled", { runId, operationId, via: "cancel", recorded: settled.recorded ?? operation.status, reason: settled.reason });
						return textResult(settled);
					}
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

				throw new Error(`op=record accepts only status=cancelled (use op=cancel); ${params.op === "record" ? `status=${params.status ?? "missing"}` : `op=${params.op}`} is not a runtime-v1 transition`);
			} catch (error) {
				return textResult({ error: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	pi.registerCommand("delegate", {
		description: "Start a build or research delegation graph.",
		handler: async (args, ctx) => {
			const parsed = parseDelegateArgs(args);
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

	pi.on("session_shutdown", () => { closeAgentList("session ended"); stopFollow("session ended"); });

	pi.registerCommand("graph", {
		description: "Inspect, focus, resume, or prune Delegate Graph runs.",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				const graphStore = getStore();
				if (subcommand === "agents") {
					if (ctx.mode !== "tui") { ctx.ui.notify("the agent list needs the interactive terminal", "warning"); return; }
					if (!reopenAgentList(graphStore, ctx, watchIntervalMs(), listActions(graphStore, pi))) ctx.ui.notify("no worker has registered in this session yet", "info");
					return;
				}
				// `status --follow <runId>` and `status <runId> --follow` are aliases of `watch <runId> --follow`; bare status stays one-shot.
				if (subcommand === "status" && !rest.includes("--follow")) {
					ctx.ui.notify(renderStatus(graphStore, required(rest[0], "runId")), "info");
					return;
				}
				if (subcommand === "watch" || subcommand === "status") {
					const runId = required(rest.find((item) => !item.startsWith("--")), "runId");
					if (rest.includes("--follow")) {
						if (ctx.mode !== "tui") { ctx.ui.notify("watch --follow needs the interactive terminal; ACP clients receive the same summary through op=watch progress events", "warning"); return; }
						startFollow(pi, ctx, graphStore, runId, watchIntervalMs());
						return;
					}
					ctx.ui.notify(renderWatch(watchRun(graphStore, runId)), "info");
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
					const state = graphStore.retryRuntimeAttempt({ runId, operationId, approved: true }).state;
					const digest = graphStore.policy(runId).digest;
					pi.sendUserMessage(`Resume Delegate Graph run ${runId}, operation ${operationId}, with stored policy digest ${digest}. Do not open a picker or re-resolve routes. Call delegate_graph op=next and continue from its frozen modelPolicy, policyDigest, and route.`);
					ctx.ui.notify(`resumed ${state.runId}`, "info");
					return;
				}
				if (subcommand === "ledger") {
					const runId = required(rest[0], "runId");
					const ledger = graphStore.runtimeLedger(runId);
					const target = rest[1];
					if (target) {
						writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
						chmodSync(target, 0o600);
						ctx.ui.notify(`derived ledger for ${runId} written to ${target} (${ledger.operations.length} operations, ${ledger.events.length} events)`, "info");
					} else {
						ctx.ui.notify(JSON.stringify(ledger, null, 2), "info");
					}
					return;
				}
				if (subcommand === "prune") {
					const days = Number(rest[0] ?? "30");
					ctx.ui.notify(`pruned ${graphStore.prune(days)} settled runs`, "info");
					return;
				}
				ctx.ui.notify("usage: /graph agents|status [--follow]|watch [--follow]|log|focus|resume|ledger|prune", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
