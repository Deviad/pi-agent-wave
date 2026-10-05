import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { resolveAcpxPlan } from "../scripts/acpx-plan.ts";
import { preparationFixture } from "./support/workspace-preparation-fixture.ts";

const MODEL = "nosuchproviderxyz/preparation-fixture";
function record(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function parsed(value: unknown): Record<string, unknown> { const result = record(value); const content = result.content as { text: string }[]; return record(JSON.parse(content[0].text)); }

async function fixture(parent?: string, expectPreparation = true, interruptedStart = false) {
	const fx = preparationFixture(parent);
	const saved = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = fx.agentDir;
	process.env.DELEGATE_GRAPH_DB = join(fx.root, "graph.db");
	writeFileSync(join(fx.agentDir, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: [MODEL], thinking: "off", session: true } }, roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])) }));
	writeFileSync(join(fx.agentDir, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?preparation=${fx.root}`);
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const invocations: string[] = [];
	let launchCount = 0;
	let lastTask = "";
	extension({
		registerCommand() {}, registerTool(definition) { tool = definition; }, on() {}, sendUserMessage() {},
		exec: async (executable: string, args: string[], options?: { cwd?: string }) => {
			invocations.push(args.includes("start") ? "start" : args.includes("init") ? "init" : executable);
			if (args.includes("init") && expectPreparation) assert.deepEqual(fx.events(), ["install", "baseline"], "actual install/loading/baseline precede launcher creation");
			if (args.includes("start")) {
				launchCount++;
				if (interruptedStart) return { code: -1, stdout: "", stderr: "launcher interrupted", killed: true };
				const get = (name: string) => { const i = args.indexOf(name); assert.ok(i >= 0); return args[i + 1]; };
				lastTask = readFileSync(get("--task-file"), "utf8");
				const transport = get("--transport") === "herdr" ? "herdr" : "headless";
				const agent = `fixture-${launchCount}`, tab = `fixture-tab-${launchCount}`, pane = `fixture-pane-${launchCount}`;
				const identity = resolveAcpxPlan({ runId: get("--run-id"), operationId: get("--operation-id"), role: args[args.indexOf("start") + 2], selectedModel: get("--model"), modelAttempt: Number(get("--model-attempt")), transientAttempt: Number(get("--transient-attempt")), transport, herdrAgent: agent, herdrTabId: tab, herdrPaneId: pane });
				return { code: 0, stdout: JSON.stringify({ agent, tab, pane, "acpx-session": `session-${launchCount}`, "acp-agent": "pi", "acpx-attempt-key": identity.attemptKey, "agentfs-session": `fixture-fs-${launchCount}`, "agentfs-db": join(fx.root, `fixture-fs-${launchCount}.db`), "acpx-cancel-script": join(fx.root, `cancel-${launchCount}.sh`) }), stderr: "", killed: false };
			}
			const result = spawnSync(executable, args, { cwd: options?.cwd, encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
	} as ExtensionAPI);
	assert.ok(tool);
	const execute = async (params: Record<string, unknown>, signal?: AbortSignal) => parsed(await tool!.execute("fixture", params, signal, () => {}, { cwd: fx.workspace, mode: "headless", ui: { notify() {} } } as unknown as ExtensionContext));
	const init = async (graph = "build", extra: Record<string, unknown> = {}) => {
		const result = await execute({ op: "init", story: "preparation", graph, task: "prepare local change", ...extra });
		assert.equal(result.error, undefined, JSON.stringify(result));
		const runId = String(record(result.state).runId);
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		try { return { runId, operationId: store.next(runId).operations[0].id }; } finally { store.close(); }
	};
	const implementations = async () => {
		const run = await init();
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		try {
			const identity = createHeadlessAcpxAttemptIdentity({ ...run, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "pi" });
			store.beginRuntimeAttempt({ identity, sessionId: "plan", requestId: null, policyDigest: store.policy(run.runId).digest });
			const answer = new RuntimeContentStore(store.dbPath).retain(Buffer.from("Plan two disjoint slices"));
			store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "plan", requestId: "plan", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
			store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "test plan", verdict: "READY", payload: { slices: ["source.ts", "other.ts"].map((path) => ({ id: path, name: path, task: `Edit ${path}`, ownedPaths: [join(fx.workspace, path)] })) } });
			return { runId: run.runId, operations: store.next(run.runId).operations.map((operation) => operation.id) };
		} finally { store.close(); }
	};
	return { ...fx, execute, init, implementations, invocations, get launches() { return launchCount; }, get task() { return lastTask; }, cleanup() { fx.cleanup(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); } };
}

for (const transport of ["headless", "herdr"] as const) {
	test(`dispatch prepares real npm workspace before ${transport} launch and reuses it for sibling workers`, async () => {
		const fx = await fixture();
		try {
			fx.approve(); const run = await fx.implementations();
			for (const operationId of run.operations) {
				const result = await fx.execute({ op: "dispatch", runId: run.runId, operationId, transport });
				assert.equal(result.error, undefined, JSON.stringify(result));
				assert.equal(record(result.preparation).status, "ready");
			}
			assert.deepEqual(fx.events(), ["install", "baseline"]);
			assert.equal(fx.launches, 2);
			const alternateDb = join(fx.root, "another-graph.db");
			new GraphStore({ dbPath: alternateDb }).close();
			await assert.rejects(fx.prepare({ dbPath: alternateDb, runId: "another-database-run" }), /active-workers/);
			assert.match(fx.task, /Dependencies are host-prepared.*Report missing dependencies/s);
			assert.equal(fx.invocations.indexOf("init") < fx.invocations.indexOf("start"), true);
			const other = await fx.init();
			const blocked = await fx.execute({ op: "dispatch", ...other, transport });
			assert.equal(blocked.blocked, "preparation");
			assert.equal(blocked.phase, "active-workers");
			assert.equal(fx.launches, 2);
			rmSync(join(fx.workspace, "node_modules"), { recursive: true });
			const refresh = await fx.execute({ op: "dispatch", ...other, transport });
			assert.equal(refresh.phase, "active-workers");
			assert.deepEqual(fx.events(), ["install", "baseline"]);
		} finally { fx.cleanup(); }
	});
}

test("read-only dispatch and its approved retry reuse ready dependencies", async () => {
	const fx = await fixture();
	try {
		fx.approve(); const run = await fx.init();
		const first = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(first.error, undefined, JSON.stringify(first));
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		try {
			assert.equal(store.getOperation(run.operationId).read_only, 1);
			const attempt = store.runtimeAttemptByOperation(run.operationId)!;
			store.settleRuntimeAttempt({ attemptKey: attempt.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "[dispatch_precondition] test stopped" }, observation: undefined });
			store.retryRuntimeAttempt(run);
			store.retryRuntimeAttempt({ ...run, approved: true, retryReason: "test recovery" });
		} finally { store.close(); }
		const retried = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(retried.error, undefined, JSON.stringify(retried));
		assert.equal(record(retried.preparation).reused, true);
		assert.equal(fx.launches, 2);
		assert.deepEqual(fx.events(), ["install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("unconfigured workspace preserves dispatch behaviour", async () => {
	const fx = await fixture(undefined, false);
	try {
		rmSync(join(fx.agentDir, "workspace-preparation.jsonc"));
		const run = await fx.init();
		const result = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(result.error, undefined, JSON.stringify(result));
		assert.equal(record(result.preparation).status, "unconfigured");
		assert.equal(existsSync(join(fx.workspace, "node_modules")), false);
	} finally { fx.cleanup(); }
});

test("preparation failure does not launch or spend fallback attempts; successful redispatch recovers", async () => {
	const fx = await fixture();
	try {
		fx.save({ ...fx.recipe, baseline: [fx.node("const fs=require('fs');if(!fs.existsSync('.preparation-scratch/allow'))process.exit(8);fs.appendFileSync('.preparation-scratch/events','baseline\\n')")] });
		fx.approve(); const run = await fx.init();
		fx.invocations.length = 0;
		const blocked = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(blocked.blocked, "preparation"); assert.equal(blocked.phase, "baseline");
		assert.equal(fx.launches, 0); assert.deepEqual(fx.invocations, []);
		assert.equal(existsSync(join(fx.root, "runs")), false);
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		try {
			const operation = store.getOperation(run.operationId);
			assert.equal(operation.status, "pending"); assert.equal(operation.transient_attempts, 0); assert.equal(operation.model_attempt, 0);
			assert.equal(store.runtimeAttemptByOperation(run.operationId), undefined); assert.equal(store.agents(run.runId).length, 0);
		} finally { store.close(); }
		writeFileSync(join(fx.workspace, ".preparation-scratch/allow"), "yes");
		const recovered = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(recovered.error, undefined, JSON.stringify(recovered));
		assert.deepEqual(fx.events(), ["install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("operations runs bypass automatic preparation", async () => {
	const fx = await fixture(undefined, false);
	try {
		// A configured but unapproved recipe would block either dispatch if preparation ran.
		const run = await fx.init("operations", { commands: [{ id: "operation", name: "operation", command: { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: fx.workspace }, ownedPaths: [join(fx.workspace, "checkpoint")] }] });
		const result = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(result.error, undefined, JSON.stringify(result));
		assert.equal(result.preparation, null);
		assert.equal(existsSync(join(fx.workspace, "node_modules")), false);
	} finally { fx.cleanup(); }
});

test("home runs retain their existing dispatch behaviour with an unapproved preparation recipe", async () => {
	const fx = await fixture(homedir(), false);
	try {
		const run = await fx.init("build", { workspaceRoot: fx.workspace });
		const result = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(result.error, undefined, JSON.stringify(result));
		assert.equal(result.preparation, null);
		assert.equal(existsSync(join(fx.workspace, "node_modules")), false);
	} finally { fx.cleanup(); }
});

test("an interrupted launcher retains its reservation and blocks dependency refresh", async () => {
	const fx = await fixture(undefined, true, true);
	try {
		fx.approve(); const run = await fx.init();
		const first = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.match(String(first.error), /interrupted/);
		assert.ok(readdirSync(join(fx.root, "runs")).length > 0, "the real initialized run remains available for reconciliation");
		const lock = join(fx.workspace, "package-lock.json");
		writeFileSync(lock, readFileSync(lock, "utf8") + "\n");
		const second = await fx.execute({ op: "dispatch", ...run, transport: "headless" });
		assert.equal(second.blocked, "preparation");
		assert.equal(second.phase, "active-workers");
		assert.deepEqual(fx.events(), ["install", "baseline"]);
		assert.equal(fx.launches, 1);
	} finally { fx.cleanup(); }
});
