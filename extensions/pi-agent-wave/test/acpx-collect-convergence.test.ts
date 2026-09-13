import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";


const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

async function toolIn(dir: string, models: string[] = ["openai-codex/gpt-5.6-sol", "alibaba/glm-5.2-fallback"], invocations?: { command: string; args: string[] }[]): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models, thinking: "off", session: true } },
		roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
	}));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?collect-convergence=${Date.now()}`);
	let tool: Record<string, any>;
	const fakePi = {
		registerCommand() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		on() {},
		exec: async (command: string, args: string[]) => {
			invocations?.push({ command, args: [...args] });
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	extension(fakePi);
	return { get tool() { return tool; } };
}

/** Registers the planning operation as running on a headless worker whose launcher directory is already on disk. */
async function startDeadAttempt(dir: string, options: { cancelExit: number; state: "alive" | "no-session" }): Promise<{ tool: Record<string, any>; runId: string; operationId: string; privateRunDir: string; diagnosticsPath: string }> {
	const { tool } = await toolIn(dir);
	const init = parsed(await tool.execute("init", { op: "init", story: "dead-attempt", graph: "build", task: "Plan the wave" }, undefined, () => {}, {} as ExtensionContext));
	if (init.error) throw new Error(`init failed: ${init.error}`);
	const operation = init.next.operations[0];
	const privateRunDir = join(dir, "run-private");
	const attemptDir = join(privateRunDir, "acpx", "dg-dead-thinker");
	mkdirSync(attemptDir, { recursive: true });
	const diagnosticsPath = join(privateRunDir, `failure-${operation.id}.json`);
	writeFileSync(diagnosticsPath, `${JSON.stringify({ schemaVersion: 1, terminalKind: "failed", processExitCode: 1 })}\n`, { mode: 0o600 });
	const cancelScript = join(attemptDir, "cancel-acpx.sh");
	writeFileSync(cancelScript, `#!/bin/sh\nprintf 'worker session already gone\\n' >&2\nexit ${options.cancelExit}\n`, { mode: 0o700 });
	chmodSync(cancelScript, 0o700);
	// Register the attempt the way dispatch does, bound to a launcher directory whose worker is already gone.
	const selectedModel: string = operation.route.chain[0];
	const identity = createHeadlessAcpxAttemptIdentity({ runId: init.state.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel, agent: selectAcpAgent(selectedModel) });
	const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
	try {
		const agentId = store.registerAgent({ runId: init.state.runId, name: "dg-dead-thinker", node: "thinker_plan", role: "thinker", transport: "headless", policyDigest: init.next.policy.digest, selectedModel, modelAttempt: 0, currentTask: operation.task, acpAgent: identity.agent, acpxRecordId: "dg-dead-session", acpxSessionId: "dg-dead-session", acpxState: options.state, acpxAttemptKey: identity.attemptKey, agentFsSessionId: "dg-dead-session", agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-dead-session", requestId: null, policyDigest: init.next.policy.digest, agentId });
	} finally { store.close(); }
	return { tool, runId: init.state.runId, operationId: operation.id, privateRunDir, diagnosticsPath };
}

describe("provider preflight at dispatch", () => {
	for (const graph of ["build", "operations"] as const) {
	test(`forwards ${graph} access mode and records an unauthenticated route block`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "preflight-block-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const { tool } = await toolIn(dir, ["nosuchproviderxyz/dead-route", "alibaba/live-route"], invocations);
			const commands = graph === "operations" ? [{ id: "access", name: "access", command: { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir }, ownedPaths: [join(dir, "result.txt")] }] : undefined;
			const init = parsed(await tool.execute("init", { op: "init", story: "preflight-block", graph, task: "Plan the wave", commands }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(init.error, undefined, `init must succeed, got ${JSON.stringify(init)}`);
			const operation = init.next.operations[0];
			const blocked = parsed(await tool.execute("dispatch", { op: "dispatch", runId: init.state.runId, operationId: operation.id, transport: "headless" }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(blocked.error, undefined, `dispatch must converge on a named block, got ${JSON.stringify(blocked)}`);
			assert.equal(blocked.dispatched, false);
			assert.equal(blocked.blocked, "preflight");
			assert.match(String(blocked.reason), /worker preflight:.*nosuchproviderxyz/);
			assert.equal(blocked.operation.retry_reason, "worker-credential-preflight");
			assert.equal(blocked.operation.model_attempt, 0, "the first block spends one same-model attempt before the chain advances");
			const start = invocations.find((call) => call.args.includes("--owned-paths-json"));
			assert.ok(start, "the actual private launcher invocation must be observed");
			const modeIndex = start.args.indexOf("--access-mode");
			assert.deepEqual(start.args.slice(modeIndex, modeIndex + 2), ["--access-mode", graph === "build" ? "read-only" : "owned-write"]);
		} finally {
			Object.assign(process.env, saved);
		}
	});
	}
});

describe("terminated attempt convergence", () => {
	test("collect records a failed attempt instead of throwing forever", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collect-converge-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" });
			const collected = parsed(await started.tool.execute("collect", { op: "collect", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(collected.error, undefined, `collect must converge, got ${JSON.stringify(collected)}`);
			assert.equal(collected.settled, true);
			assert.equal(collected.attempt.processState, "failed");
			assert.equal(collected.diagnosticsPath, started.diagnosticsPath, "the retained diagnostic bundle must be named to the supervisor");
			assert.ok(String(collected.reason).length > 0, "the launcher reason must be reported");
			assert.match(String(collected.attempt.outcome.error), new RegExp(`retained worker diagnostics: ${started.diagnosticsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the settled outcome must name the retained bundle");
			// The fact is settled; the operation stays on its failed attempt until the runtime replaces it.
			assert.equal(collected.operation.status, "running");
			const retried = parsed(await started.tool.execute("retry", { op: "retry", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(retried.error, undefined, `retry must classify the dead worker, got ${JSON.stringify(retried)}`);
			assert.notEqual(retried.operation.status, "running", "a dead worker must never stay dispatchable as running");
			const next = parsed(await started.tool.execute("next", { op: "next", runId: started.runId }, undefined, () => {}, {} as ExtensionContext));
			assert.ok(!next.operations.some((candidate: Record<string, unknown>) => candidate.id === started.operationId && candidate.status === "running"), "a dead worker must never stay dispatchable as running");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("cancelling an attempt whose worker is already dead still records the cancellation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cancel-dead-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "no-session" });
			const cancelled = parsed(await started.tool.execute("cancel", { op: "cancel", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(cancelled.error, undefined, `cancelling a dead attempt must converge, got ${JSON.stringify(cancelled)}`);
			assert.equal(cancelled.operation.status, "cancelled");
			assert.equal(cancelled.state.status, "cancelled");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("a live worker whose cancellation genuinely fails is refused without a state change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cancel-alive-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" });
			let refused: Record<string, any> | undefined;
			try {
				refused = parsed(await started.tool.execute("cancel", { op: "cancel", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			} catch (error) { refused = { error: String((error as Error).message) }; }
			assert.match(String(refused.error), /worker session already gone/, "a live worker with a failing cancel launcher must refuse");
			const after = parsed(await started.tool.execute("next", { op: "next", runId: started.runId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(after.operations.find((candidate: Record<string, unknown>) => candidate.id === started.operationId)?.status, "running", "a refused cancellation must leave the operation untouched for the supervisor to resolve");

		} finally {
			Object.assign(process.env, saved);
		}
	});
});
