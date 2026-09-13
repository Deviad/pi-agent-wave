import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { renderFollow, renderWatch, watchRun } from "../index.ts";
import { AGENT_LIST_WIDGET, agentListState, attemptDetail, noteRegisteredAttempt, resetAgentListForTests } from "../agent-list.ts";
import { renderStatus } from "../commands.ts";

const dirs: string[] = [];
afterEach(() => { resetAgentListForTests(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

const commands = new Map<string, Record<string, any>>();
async function harness(dir: string): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: ["openai-codex/gpt-5.6-sol"], thinking: "off", session: true } }, roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])) }));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?runtime-watch=${Date.now()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand(name: string, definition: Record<string, any>) { commands.set(name, definition); }, on() {}, registerTool(definition: Record<string, any>) { tool = definition; },
		exec: async (command: string, args: string[]) => {
			if (!args.some((arg) => arg.endsWith("policy-resolver.mjs"))) throw new Error(`unexpected execution: ${command} ${args.join(" ")}`);
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return tool;
}

test("op=watch renders what each running worker is doing from its retained stream and decides nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "runtime-watch-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const tool = await harness(dir);
		const ctx = {} as ExtensionContext;
		const init = parsed(await tool.execute("init", { op: "init", story: "watch", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, ctx));
		assert.equal(init.error, undefined, JSON.stringify(init));
		const runId: string = init.state.runId;
		const operation = init.next.operations[0];
		const idle = parsed(await tool.execute("watch", { op: "watch", runId }, undefined, () => {}, ctx));
		assert.deepEqual(idle.agents, [], "nothing runs before dispatch");

		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		const attemptDir = join(dir, "private-run", "acpx", "worker-1"); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
		const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const agentId = store.registerAgent({ runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
		const before = parsed(await tool.execute("watch", { op: "watch", runId }, undefined, () => {}, ctx));
		assert.equal(before.agents.length, 1);
		assert.deepEqual([before.agents[0].agentName, before.agents[0].processState, before.agents[0].streamPath, before.agents[0].lastActivity], ["worker-1", "running", null, null]);

		const update = (u: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: u } });
		writeFileSync(join(attemptDir, "runtime-output", "worker.stdout.ndjson"), [
			JSON.stringify({ jsonrpc: "2.0", id: "1", method: "session/prompt", params: { sessionId: "s", prompt: [] } }),
			update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read docs/design.md", kind: "read" }),
			update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }),
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the design notes first" } }),
		].join("\n") + "\n", { mode: 0o600 });
		const progress: Record<string, unknown>[] = [];
		const live = parsed(await tool.execute("watch", { op: "watch", runId }, undefined, (u: unknown) => progress.push(parsed(u)), ctx));
		const agent = live.agents[0];
		assert.equal(agent.lastActivity, "Reading the design notes first");
		assert.deepEqual(agent.recent, ["\u2500\u2500 prompt \u2500\u2500", "\u25b8 read docs/design.md (read)", "\u2713 read docs/design.md", "Reading the design notes first"]);
		assert.deepEqual([agent.prompts, agent.toolCalls], [1, 1]);
		assert.equal(JSON.stringify(live).includes("jsonrpc"), false);
		assert.equal(progress.at(-1)?.kind, "watch");
		assert.deepEqual((progress.at(-1)?.agents as Record<string, unknown>[])[0]?.lastActivity, "Reading the design notes first");
		const rendered = renderWatch(watchRun(store, runId));
		assert.match(rendered, /^run run_[^\n]* \| node=thinker_split \| status=active\nworker-1 \| thinker_split \| running \| tools=1 \| Reading the design notes first\n/);
		assert.match(rendered, /    \u2713 read docs\/design\.md/);
		// Watching is read-only: the attempt, the operation and the graph are untouched.
		assert.equal(store.runtimeAttempt(identity.attemptKey).outcome, null);
		assert.equal(store.getOperation(operation.id).status, "running");
		assert.equal(store.getState(runId).status, "active");
		store.close();
	} finally { process.env = originalEnv; }
});

test("/graph watch --follow keeps the overview on screen, refreshes on r, focuses with number keys, and closes on q", async () => {
	const dir = mkdtempSync(join(tmpdir(), "runtime-follow-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	process.env.PI_GRAPH_WATCH_INTERVAL_MS = "60";
	try {
		const tool = await harness(dir);
		const graph = commands.get("graph")!;
		const init = parsed(await tool.execute("init", { op: "init", story: "follow", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, {} as ExtensionContext));
		const runId: string = init.state.runId;
		const operation = init.next.operations[0];
		const widgets: (string[] | undefined)[] = []; const notices: string[] = []; let handler: ((data: string) => unknown) | null = null; let unsubscribed = 0;
		const ctx = { mode: "tui", ui: { notify: (message: string) => notices.push(message), setWidget: (_key: string, content: string[] | undefined) => widgets.push(content), onTerminalInput: (h: (data: string) => unknown) => { handler = h; return () => { unsubscribed += 1; }; } } } as unknown as ExtensionContext;
		const headless = { mode: "headless", ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		await graph.handler(`watch ${runId} --follow`, headless);
		assert.match(notices.at(-1) ?? "", /needs the interactive terminal/);

		await graph.handler(`watch ${runId} --follow`, ctx);
		assert.ok(handler, "follow subscribes to terminal input");
		assert.match(widgets.at(-1)![0]!, new RegExp(`^watch ${runId} \\| node=thinker_split \\| status=active \\| keys: 1-9 focus worker, r refresh, q close$`));
		assert.match(widgets.at(-1)![1]!, /no running workers/);

		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		const attemptDir = join(dir, "private-run", "acpx", "worker-1"); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
		const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const agentId = store.registerAgent({ runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
		writeFileSync(join(attemptDir, "runtime-output", "worker.stdout.ndjson"), JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the corpus" } } } }) + "\n", { mode: 0o600 });
		const before = widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.ok(widgets.length > before, "the widget redraws on the interval while the run is active");
		assert.match(widgets.at(-1)![1]!, /^1\. worker-1 \| thinker_split \| running \| tools=0 \| Reading the corpus$/);
		assert.deepEqual(handler!("r"), { consume: true });
		assert.deepEqual(handler!("1"), { consume: true });
		assert.match(notices.at(-1) ?? "", /worker-1 is a headless worker; it has no pane to focus/);
		assert.deepEqual(handler!("7"), { consume: true });
		assert.match(notices.at(-1) ?? "", /no worker 7/);
		assert.equal(handler!("x"), undefined, "other keys pass through to the editor");
		assert.deepEqual(handler!("q"), { consume: true });
		assert.equal(widgets.at(-1), undefined, "closing removes the widget");
		assert.equal(unsubscribed, 1);
		assert.match(notices.at(-1) ?? "", /closed by operator/);
		const settled = widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(widgets.length, settled, "no redraw after close");
		assert.equal(store.getState(runId).status, "active");
		assert.deepEqual(renderFollow(watchRun(store, runId)).length, 2);
		store.close();
	} finally { process.env = originalEnv; }
});


// ---------------------------------------------------------------------------------------------------------
// The default numbered agent list (tasks/prd-default-agent-list.md).
// ---------------------------------------------------------------------------------------------------------

type Exec = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
const lifecycle = new Map<string, (...args: unknown[]) => unknown>();

/** Like harness(), with a caller-supplied executor for the delegate scripts and captured lifecycle handlers. */
async function harnessWith(dir: string, exec: Exec): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: ["openai-codex/gpt-5.6-sol"], thinking: "off", session: true } }, roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])) }));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?agent-list=${Date.now()}-${Math.random()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand(name: string, definition: Record<string, any>) { commands.set(name, definition); },
		registerTool(definition: Record<string, any>) { tool = definition; },
		on(event: string, handler: (...args: unknown[]) => unknown) { lifecycle.set(event, handler); },
		exec: async (command: string, args: string[]) => {
			if (args.some((arg) => arg.endsWith("policy-resolver.mjs"))) {
				const result = spawnSync(command, args, { encoding: "utf8" });
				return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
			}
			return exec(command, args);
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return tool;
}

interface FakeTui { ctx: ExtensionContext; widgets: (string[] | undefined)[]; notices: string[]; input: (data: string) => unknown; unsubscribed: number; last: () => string[] | undefined; editorText: string }
function fakeTui(mode: "tui" | "headless" = "tui"): FakeTui {
	const tui: FakeTui = { widgets: [], notices: [], unsubscribed: 0, input: () => { throw new Error("no terminal input handler"); }, last: () => tui.widgets.at(-1), ctx: undefined as unknown as ExtensionContext, editorText: "" };
	tui.ctx = { mode, cwd: process.cwd(), ui: { getEditorText: () => tui.editorText, notify: (message: string) => tui.notices.push(message), setWidget: (key: string, content: string[] | undefined) => { assert.equal(key, AGENT_LIST_WIDGET); tui.widgets.push(content); }, onTerminalInput: (handler: (data: string) => unknown) => { tui.input = handler; return () => { tui.unsubscribed += 1; }; } } } as unknown as ExtensionContext;
	return tui;
}

const ENTER = "\r";
const ESCAPE = "";

interface Registered { attemptKey: string; agentId: string; attemptDir: string; identity: ReturnType<typeof createHeadlessAcpxAttemptIdentity> }
/** Registers a worker for an operation the way the dispatch path does, without a real launch. */
function registerWorker(store: GraphStore, dir: string, runId: string, operationId: string, name: string, options: { transport?: "headless" | "herdr"; transientAttempt?: number } = {}): Registered {
	const operation = store.getOperation(operationId);
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: roleOf(operation.node), modelAttempt: operation.model_attempt, transientAttempt: options.transientAttempt ?? operation.transient_attempts, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
	const attemptDir = join(dir, "private-run", "acpx", name); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
	const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const transport = options.transport ?? "headless";
	const agentId = store.registerAgent({ runId, name, node: operation.node, role: roleOf(operation.node), transport, herdrAgent: transport === "herdr" ? `herdr-${name}` : undefined, tabId: transport === "herdr" ? "w1:t9" : undefined, herdrPaneId: transport === "herdr" ? "w1:p9" : undefined, selectedModel: "openai-codex/gpt-5.6-sol", modelAttempt: operation.model_attempt, acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
	return { attemptKey: identity.attemptKey, agentId, attemptDir, identity };
}
function roleOf(node: string): string { return node.startsWith("thinker") ? "thinker" : node.startsWith("search") ? "searcher" : node; }
function streamLine(text: string): string { return JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }); }
function newRun(store: GraphStore, story: string): { runId: string; operationId: string } {
	const resolved = JSON.parse(spawnSync("node", [join(import.meta.dirname, "..", "scripts", "policy-resolver.mjs"), "--input", JSON.stringify({ kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" }), "--roles", ROLES.join(",")], { encoding: "utf8" }).stdout);
	const policy = { kind: "model" as const, input: resolved.input, routes: resolved.roles.map((route: Record<string, any>) => ({ role: route.role, tier: route.tier, chain: route.models, thinking: route.thinking ?? "off", session: route.session ?? false, capabilityFloor: route.capabilityFloor ?? "", promoted: route.promoted, promotedFrom: route.promotedFrom, promotionReason: null, selectionSource: "exact-model" })) };
	const state = store.initRun(story, "research", "Investigate", policy as never);
	return { runId: state.runId, operationId: store.next(state.runId).operations[0]!.id };
}
function select(tui: FakeTui, number: number): void { for (const digit of String(number)) assert.deepEqual(tui.input(digit), { consume: true }); assert.deepEqual(tui.input(ENTER), { consume: true }); }
function snapshot(store: GraphStore, runId: string): string { return JSON.stringify([store.getState(runId), store.operations(runId, true), store.agents(runId).map((a) => [a.id, a.status])]); }

test("agent list opens on registered dispatch only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-open-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const privateRunDir = join(dir, "private-run"); mkdirSync(privateRunDir, { recursive: true });
		let startBehaviour: "register" | "preflight" = "preflight";
		let planned: ReturnType<typeof createHeadlessAcpxAttemptIdentity> | null = null;
		const tool = await harnessWith(dir, async (_command, args) => {
			if (args.includes("init")) return { code: 0, stdout: `${privateRunDir}\n`, stderr: "", killed: false };
			if (args.includes("start")) {
				if (startBehaviour === "preflight") return { code: 1, stdout: "", stderr: "worker preflight: fixture has no credential\n", killed: false };
				const identity = planned!;
				const attemptDir = join(privateRunDir, "acpx", "worker-1"); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
				const cancel = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancel, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
				return { code: 0, stdout: JSON.stringify({ agent: "worker-1", "acpx-session": identity.sessionName, "acp-agent": "codex", "acpx-attempt-key": identity.attemptKey, "agentfs-session": identity.agentFsSession, "agentfs-db": join(attemptDir, "delta.db"), "acpx-cancel-script": cancel }), stderr: "", killed: false };
			}
			throw new Error(`unexpected execution: ${args.join(" ")}`);
		});
		const tui = fakeTui();
		const init = parsed(await tool.execute("init", { op: "init", story: "list", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, tui.ctx));
		assert.equal(init.error, undefined, JSON.stringify(init));
		const runId: string = init.state.runId; const operation = init.next.operations[0];
		assert.deepEqual(tui.widgets, [], "graph initialization opens nothing");

		const blocked = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId: operation.id, transport: "headless" }, undefined, () => {}, tui.ctx));
		assert.equal(blocked.dispatched, false, JSON.stringify(blocked)); assert.equal(blocked.blocked, "preflight");
		assert.deepEqual(tui.widgets, [], "a failed dispatch opens nothing");
		assert.equal(agentListState().entries.length, 0);

		startBehaviour = "register";
		const retried = blocked.operation; // the fenced replacement operation after the preflight block
		planned = createHeadlessAcpxAttemptIdentity({ runId, operationId: retried.id, role: "thinker", modelAttempt: retried.model_attempt, transientAttempt: retried.transient_attempts, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		const events: string[] = [];
		const dispatched = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId: retried.id, transport: "headless" }, undefined, (u: unknown) => events.push(parsed(u).kind as string), tui.ctx));
		assert.equal(dispatched.error, undefined, JSON.stringify(dispatched));
		assert.ok(events.includes("runtime_attempt_registered"));
		assert.equal(agentListState().open, true);
		assert.deepEqual(agentListState().entries.map((e) => [e.number, e.attemptKey]), [[1, planned.attemptKey]]);
		assert.match(tui.last()![0]!, /^agents \(1\) \| keys: number then Enter opens details, r refresh, q or Esc close$/);
		assert.match(tui.last()![1]!, /^1\. worker-1 \| thinker_split \| running \| gpt-5\.6-sol \| \(no stream\)$/);
	} finally { process.env = originalEnv; }
});

test("registered attempts append without renumbering or replacing selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-append-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const tui = fakeTui();
	const a = newRun(store, "first"); const b = newRun(store, "second");
	const first = registerWorker(store, dir, a.runId, a.operationId, "worker-a");
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: first.attemptKey, runId: a.runId, operationId: a.operationId }, 60);
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: first.attemptKey, runId: a.runId, operationId: a.operationId }, 60);
	assert.equal(agentListState().entries.length, 1, "a duplicate acknowledgement adds no row");
	select(tui, 1);
	assert.equal(agentListState().selected, 1);
	assert.match(tui.last()![0]!, /^agent 1: worker-a \|/);
	const second = registerWorker(store, dir, b.runId, b.operationId, "worker-b");
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: second.attemptKey, runId: b.runId, operationId: b.operationId }, 60);
	assert.deepEqual(agentListState().entries.map((e) => [e.number, e.runId]), [[1, a.runId], [2, b.runId]], "another run's worker appends with the next number");
	assert.equal(agentListState().selected, 1, "a new worker does not replace the selected details");
	assert.match(tui.last()![0]!, /^agent 1: worker-a \|/);
	assert.deepEqual(tui.input("q"), { consume: true });
	assert.match(tui.last()![1]!, /^1\. worker-a \|/); assert.match(tui.last()![2]!, /^2\. worker-b \|/);
	store.close();
});

test("automatic agent list is TUI only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-headless-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const run = newRun(store, "headless");
	const worker = registerWorker(store, dir, run.runId, run.operationId, "worker-h");
	const headless = fakeTui("headless");
	noteRegisteredAttempt(store, headless.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
	assert.deepEqual(headless.widgets, []); assert.equal(headless.unsubscribed, 0); assert.equal(agentListState().open, false); assert.equal(agentListState().entries.length, 0);
	assert.throws(() => headless.input("1"), /no terminal input handler/);
	store.close();
});

test("number selection shows attempt-bound live and retained details", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-detail-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const tui = fakeTui();
	const run = newRun(store, "detail");
	const worker = registerWorker(store, dir, run.runId, run.operationId, "worker-d");
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
	select(tui, 1);
	let view = tui.last()!;
	assert.match(view[0]!, /^agent 1: worker-d \| keys: q or Esc back to list, r refresh$/);
	assert.match(view[1]!, new RegExp(`^run ${run.runId} \\(active\\) \\| operation ${run.operationId}$`));
	assert.match(view[2]!, /^node thinker_split \| role thinker \| transport headless \| model openai-codex\/gpt-5\.6-sol$/);
	assert.match(view[3]!, /^process running \| acceptance unavailable$/);
	assert.match(view[4]!, /^task: /);
	assert.ok(view.includes("  (no stream retained for this attempt)"), view.join("\n"));
	assert.ok(view.includes("  (no answer yet: the worker is still running)"), view.join("\n"));
	writeFileSync(join(worker.attemptDir, "runtime-output", "worker.stdout.ndjson"), `${streamLine("Reading the corpus")}\n${streamLine("Drafting the answer")}\n`, { mode: 0o600 });
	assert.deepEqual(tui.input("r"), { consume: true });
	view = tui.last()!;
	assert.ok(view.some((line) => line.includes("Reading the corpus")) && view.some((line) => line.includes("Drafting the answer")), view.join("\n"));
	assert.equal(view.join("\n").includes("jsonrpc"), false, "raw protocol envelopes stay out of the detail view");
	const answer = store.retainRuntimeContent(Buffer.from("The corpus says: forty-two.\nSecond line.\n"));
	store.settleRuntimeAttempt({ attemptKey: worker.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: worker.identity.sessionName, requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	assert.deepEqual(tui.input("r"), { consume: true });
	view = tui.last()!;
	assert.match(view[3]!, /^process settled \(exited 0\) \| acceptance pending$/);
	assert.ok(view.includes("  The corpus says: forty-two.") && view.includes("  Second line."), view.join("\n"));
	const detail = attemptDetail(store, agentListState().entries[0]!);
	assert.equal(detail.answer, "The corpus says: forty-two.\nSecond line.\n");
	assert.equal(detail.answerNote, null);
	store.close();
});

test("settled and superseded entries retain their own details", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-superseded-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const tui = fakeTui();
	const run = newRun(store, "superseded");
	const first = registerWorker(store, dir, run.runId, run.operationId, "worker-1");
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: first.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
	store.settleRuntimeAttempt({ attemptKey: first.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "fixture failure" } });
	assert.deepEqual(tui.input("r"), { consume: true });
	assert.match(tui.last()![1]!, /^1\. worker-1 \| thinker_split \| settled \(failed 1\) \|/, "a settled candidate is labeled settled, never running");
	const parked = store.retryRuntimeAttempt({ runId: run.runId, operationId: run.operationId });
	const retry = parked.state.status === "active" ? parked : store.retryRuntimeAttempt({ runId: run.runId, operationId: run.operationId, approved: true });
	const second = registerWorker(store, dir, run.runId, retry.operation.id, "worker-2", { transientAttempt: retry.operation.transient_attempts });
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: second.attemptKey, runId: run.runId, operationId: retry.operation.id }, 60);
	assert.deepEqual(agentListState().entries.map((e) => e.number), [1, 2]);
	assert.match(tui.last()![1]!, /^1\. worker-1 \| thinker_split \| superseded \(failed\) \|/);
	assert.match(tui.last()![2]!, /^2\. worker-2 \| thinker_split \| running \|/);
	select(tui, 1);
	const view = tui.last()!;
	assert.match(view[0]!, /^agent 1: worker-1 \|/);
	assert.match(view[3]!, /^process superseded \(failed\) \| acceptance unavailable$/);
	assert.ok(view.includes("  (no retained answer for this attempt)"), view.join("\n"));
	assert.equal(view.join("\n").includes("worker-2"), false, "the superseded entry never borrows the replacement's identity");
	store.close();
});

test("missing Herdr agent cannot prevent detail inspection or mutate a run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-herdr-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const executed: string[][] = [];
		await harnessWith(dir, async (command, args) => { executed.push([command, ...args]); return { code: 1, stdout: "", stderr: "agent_not_found", killed: false }; });
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const tui = fakeTui();
		const run = newRun(store, "herdr");
		const worker = registerWorker(store, dir, run.runId, run.operationId, "dg_run-5052_thinker_d9c14f15", { transport: "herdr" });
		const before = snapshot(store, run.runId);
		noteRegisteredAttempt(store, tui.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
		select(tui, 1);
		const view = tui.last()!;
		assert.match(view[0]!, /^agent 1: dg_run-5052_thinker_d9c14f15 \|/);
		assert.match(view[2]!, /transport herdr/);
		assert.deepEqual(executed, [], "selection runs no Herdr focus or cancel command");
		assert.equal(tui.notices.some((n) => /agent_not_found/.test(n)), false);
		assert.equal(snapshot(store, run.runId), before, "selection mutates nothing");
		store.close();
	} finally { process.env = originalEnv; }
});

test("multi-digit selection addresses the displayed attempt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-digits-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const tui = fakeTui();
	for (let index = 1; index <= 12; index += 1) {
		const run = newRun(store, `many-${index}`);
		const worker = registerWorker(store, dir, run.runId, run.operationId, `worker-${index}`);
		noteRegisteredAttempt(store, tui.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
	}
	assert.equal(tui.last()!.length, 13);
	assert.match(tui.last()![12]!, /^12\. worker-12 \|/);
	assert.deepEqual(tui.input("1"), { consume: true });
	assert.match(tui.last()!.at(-1)!, /^selecting: 1_ \(Enter opens, Esc clears\)$/, "the pending digit is shown");
	assert.deepEqual(tui.input("2"), { consume: true });
	assert.match(tui.last()!.at(-1)!, /^selecting: 12_/);
	assert.deepEqual(tui.input(ENTER), { consume: true });
	assert.equal(agentListState().selected, 12);
	assert.match(tui.last()![0]!, /^agent 12: worker-12 \|/);
	assert.deepEqual(tui.input("q"), { consume: true });
	assert.deepEqual(tui.input("1"), { consume: true });
	assert.deepEqual(tui.input(ESCAPE), { consume: true }, "Escape clears a pending entry first");
	assert.equal(agentListState().pending, ""); assert.equal(agentListState().open, true);
	assert.deepEqual(tui.input("9"), { consume: true }); assert.deepEqual(tui.input("9"), { consume: true }); assert.deepEqual(tui.input(ENTER), { consume: true });
	assert.match(tui.notices.at(-1)!, /^no agent 99 in the list$/);
	assert.equal(tui.input("x"), undefined, "other keys pass through");
	// A message being composed keeps every key: the list opened unprompted and must not mangle typed commands.
	tui.editorText = "/graph log run_5917";
	for (const data of ["5", "r", "q", ENTER, ESCAPE]) assert.equal(tui.input(data), undefined, `${JSON.stringify(data)} reaches the editor while it holds text`);
	assert.equal(agentListState().open, true); assert.equal(agentListState().pending, "");
	tui.editorText = "";
	assert.deepEqual(tui.input("q"), { consume: true });
	store.close();
});

test("agent list navigation and closing are read-only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-close-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	const tui = fakeTui();
	const run = newRun(store, "close");
	const worker = registerWorker(store, dir, run.runId, run.operationId, "worker-c");
	const before = snapshot(store, run.runId);
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 60);
	assert.equal(agentListState().timerActive, true);
	select(tui, 1);
	assert.deepEqual(tui.input("r"), { consume: true }); assert.match(tui.last()![0]!, /^agent 1:/);
	assert.deepEqual(tui.input(ESCAPE), { consume: true }); assert.match(tui.last()![0]!, /^agents \(1\)/, "Escape returns from detail to the list");
	assert.deepEqual(tui.input("q"), { consume: true });
	assert.equal(tui.last(), undefined, "closing removes the widget"); assert.equal(tui.unsubscribed, 1); assert.equal(agentListState().open, false); assert.equal(agentListState().timerActive, false);
	assert.match(tui.notices.at(-1)!, /closed by operator/);
	const drawn = tui.widgets.length;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(tui.widgets.length, drawn, "no redraw after close");
	assert.equal(agentListState().entries.length, 1, "entries and numbers survive a close");
	const other = newRun(store, "close-2");
	const later = registerWorker(store, dir, other.runId, other.operationId, "worker-c2");
	noteRegisteredAttempt(store, tui.ctx, { attemptKey: later.attemptKey, runId: other.runId, operationId: other.operationId }, 60);
	assert.equal(agentListState().open, true, "a later successful worker start reopens the list");
	assert.match(tui.last()![2]!, /^2\. worker-c2 \|/);
	assert.equal(snapshot(store, run.runId), before);
	store.close();
});

test("follow command aliases preserve one-shot status", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-alias-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	process.env.PI_GRAPH_WATCH_INTERVAL_MS = "60";
	try {
		const tool = await harnessWith(dir, async () => { throw new Error("no delegate execution expected"); });
		const graph = commands.get("graph")!;
		const init = parsed(await tool.execute("init", { op: "init", story: "alias", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, {} as ExtensionContext));
		const runId: string = init.state.runId;
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const widgets: (string[] | undefined)[] = []; const notices: string[] = []; let unsubscribed = 0;
		const ctx = { mode: "tui", ui: { notify: (m: string) => notices.push(m), setWidget: (_k: string, c: string[] | undefined) => widgets.push(c), onTerminalInput: () => () => { unsubscribed += 1; } } } as unknown as ExtensionContext;
		await graph.handler(`status ${runId}`, ctx);
		assert.equal(notices.at(-1), renderStatus(store, runId)); assert.deepEqual(widgets, [], "bare status stays a one-shot notification");
		const progress: Record<string, unknown>[] = [];
		const status = (await tool.execute("status", { op: "status", runId }, undefined, (u: unknown) => progress.push(parsed(u)), ctx)) as { content: { text: string }[] };
		assert.ok(status.content[0]!.text.includes(runId)); assert.deepEqual(widgets, [], "op=status keeps its one-shot contract"); assert.equal(progress.at(-1)?.kind, "status");
		await graph.handler(`status --follow ${runId}`, ctx);
		assert.match(widgets.at(-1)![0]!, new RegExp(`^watch ${runId} \\|`), "status --follow <runId> opens the follow view");
		await graph.handler(`status ${runId} --follow`, ctx);
		assert.match(widgets.at(-1)![0]!, new RegExp(`^watch ${runId} \\|`), "status <runId> --follow opens the follow view");
		assert.equal(unsubscribed, 1, "the second follow replaced the first");
		await graph.handler(`watch ${runId} --follow`, ctx);
		assert.match(widgets.at(-1)![0]!, new RegExp(`^watch ${runId} \\|`));
		store.close();
	} finally { process.env = originalEnv; }
});

test("agent list refresh resources follow view lifetime", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-list-timer-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		await harnessWith(dir, async () => { throw new Error("no delegate execution expected"); });
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const tui = fakeTui();
		const run = newRun(store, "timer");
		const worker = registerWorker(store, dir, run.runId, run.operationId, "worker-t");
		noteRegisteredAttempt(store, tui.ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 40);
		const drawn = tui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 130));
		assert.ok(tui.widgets.length > drawn, "the list redraws while a tracked worker runs");
		store.settleRuntimeAttempt({ attemptKey: worker.attemptKey, outcome: { kind: "exited", exitCode: 0 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(agentListState().timerActive, false, "automatic redraw stops when nothing tracked is running");
		const idle = tui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(tui.widgets.length, idle);
		select(tui, 1);
		assert.match(tui.last()![3]!, /^process settled \(exited 0\)/, "retained details stay manually accessible");
		const shutdown = lifecycle.get("session_shutdown");
		assert.ok(shutdown, "the extension closes its views on session shutdown");
		shutdown!({}, tui.ctx);
		assert.equal(agentListState().open, false); assert.equal(tui.unsubscribed, 1); assert.equal(tui.last(), undefined);
		store.close();
	} finally { process.env = originalEnv; }
});
