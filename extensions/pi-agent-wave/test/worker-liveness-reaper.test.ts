import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { Database } from "../sqlite.ts";
import { renderStatus } from "../commands.ts";
import { watchRun } from "../index.ts";
import { readProcessTable, runLiveness, workerLiveness } from "../lib/liveness.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

const MODEL = "nosuchproviderxyz/dead-route";
const REGISTERED_AT = "2026-08-17T12:00:00.000Z";
const LATER = Date.parse(REGISTERED_AT) + 10 * 60_000;

/**
 * One registered, unsettled thinker attempt whose stale registration still says `acpx_state='alive'`.
 * `transientAttempts` seeds how much of the same-model budget earlier attempts already spent; the chain
 * has one model, so at 3 the next transient retry exhausts the budget and parks the run.
 */
function staleAttempt(root: string, dbPath = join(root, "graph.db"), transientAttempts = 0): { store: GraphStore; runId: string; operationId: string; attemptDir: string; session: string } {
	const store = new GraphStore({ dbPath, now: () => new Date(REGISTERED_AT) });
	const policy = { input: { kind: "model" as const, model: MODEL, reason: "test" }, routes: ["thinker", "implementer", "reviewer", "tester", "auditor"].map((role) => ({ role, tier: "exact", chain: [MODEL], thinking: "off", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null })) };
	const run = store.initRun("liveness", "build", "Plan the change", policy as never, undefined, "runtime-v1");
	const operation = store.next(run.runId).operations[0];
	if (transientAttempts) {
		const seed = new Database(dbPath);
		try { seed.query("UPDATE operations SET transient_attempts=? WHERE id=?").run(transientAttempts, operation.id); } finally { seed.close(); }
	}
	const attemptDir = join(root, "run-private", "acpx", "dg-stale-thinker");
	mkdirSync(attemptDir, { recursive: true });
	const cancelScript = join(attemptDir, "cancel-acpx.sh");
	writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	chmodSync(cancelScript, 0o700);
	const session = `dg-liveness-${process.pid}-${Date.now()}`;
	const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: transientAttempts, selectedModel: MODEL, agent: selectAcpAgent(MODEL) });
	const agentId = store.registerAgent({ runId: run.runId, name: "dg-stale-thinker", node: "thinker_plan", role: "thinker", transport: "headless", policyDigest: store.policy(run.runId).digest, selectedModel: MODEL, modelAttempt: 0, currentTask: operation.task, acpAgent: identity.agent, acpxRecordId: session, acpxSessionId: session, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: session, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript });
	store.beginRuntimeAttempt({ identity, sessionId: session, requestId: null, policyDigest: store.policy(run.runId).digest, agentId });
	return { store, runId: run.runId, operationId: operation.id, attemptDir, session };
}

describe("read-time worker liveness", () => {
	test("acpx_state='alive' does not keep a worker alive: process, directory and result-file facts decide", () => {
		const root = mkdtempSync(join(tmpdir(), "liveness-facts-"));
		dirs.push(root);
		const { store, runId, operationId, attemptDir } = staleAttempt(root);
		try {
			const agent = store.agents(runId)[0];
			assert.equal(agent.acpx_state, "alive");
			assert.equal(agent.last_activity_at, REGISTERED_AT);
			assert.deepEqual(workerLiveness(agent, () => [], LATER), { state: "orphaned", reason: "worker-process-gone" });
			assert.deepEqual(workerLiveness(agent, () => [], Date.parse(REGISTERED_AT) + 5_000), { state: "alive" }, "inside the launch grace an absent process is not yet evidence");
			assert.deepEqual(workerLiveness(agent, () => null, LATER), { state: "unknown", reason: "process-table-unreadable" });
			assert.deepEqual(workerLiveness(agent, () => [`agentfs run --session ${agent.agentfs_session_id} --no-default-allows`], LATER), { state: "alive" });
			writeFileSync(join(attemptDir, "worker-result.json"), "{}");
			assert.deepEqual(workerLiveness(agent, () => [], LATER), { state: "awaiting-collect" });
			rmSync(attemptDir, { recursive: true });
			assert.deepEqual(workerLiveness(agent, () => { throw new Error("a missing directory needs no process table"); }, LATER), { state: "orphaned", reason: "attempt-directory-missing" });
			assert.deepEqual([...runLiveness(store, runId, () => [], LATER)], [[operationId, { state: "orphaned", reason: "attempt-directory-missing" }]]);
		} finally { store.close(); }
	});

	test("a real process carrying the attempt's session keeps it alive; without it the worker is gone", async () => {
		const root = mkdtempSync(join(tmpdir(), "liveness-ps-"));
		dirs.push(root);
		const { store, runId, session } = staleAttempt(root);
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", session], { stdio: "ignore" });
		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			const agent = store.agents(runId)[0];
			assert.notEqual(readProcessTable(), null, "this host lets the suite read its process table");
			assert.deepEqual(workerLiveness(agent, readProcessTable, LATER), { state: "alive" });
			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));
			assert.deepEqual(workerLiveness(agent, readProcessTable, LATER), { state: "orphaned", reason: "worker-process-gone" });
		} finally { child.kill("SIGKILL"); store.close(); }
	});

	test("status and watch report a dead worker as orphaned with its reason instead of running", () => {
		const root = mkdtempSync(join(tmpdir(), "liveness-status-"));
		dirs.push(root);
		const { store, runId, operationId, attemptDir } = staleAttempt(root);
		try {
			rmSync(attemptDir, { recursive: true });
			const status = renderStatus(store, runId);
			assert.match(status, new RegExp(`${operationId} \\| thinker_plan \\| orphaned \\(attempt-directory-missing\\)`));
			assert.equal(new RegExp(`${operationId} \\| thinker_plan \\| running`).test(status), false);
			assert.match(status, /orphaned workers: 1; op=collect records the attempt failed/);
			const watched = watchRun(store, runId).agents.find((row) => row.operationId === operationId);
			assert.equal(watched?.processState, "orphaned (attempt-directory-missing)");
		} finally { store.close(); }
	});
});

/**
 * Seeds an orphaned attempt whose whole private run directory is gone (as in run_a6a35211 and the
 * rebooted run_ab8675e8), loads the extension against a temporary store, and runs `body` with a
 * `delegate_graph` caller. Restores the environment afterwards.
 */
async function withOrphan(transientAttempts: number, body: (input: { runId: string; operationId: string; dbPath: string; call: (params: Record<string, unknown>) => Promise<Record<string, any>> }) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "liveness-tool-"));
	dirs.push(root);
	const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
	try {
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const dbPath = join(root, "graph.db");
		process.env.DELEGATE_GRAPH_DB = dbPath;
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		const seeded = staleAttempt(root, dbPath, transientAttempts);
		const { runId, operationId } = seeded;
		seeded.store.close();
		rmSync(join(root, "run-private"), { recursive: true });
		const { default: extension } = await import(`../index.ts?liveness=${Date.now()}-${transientAttempts}`);
		let tool: Record<string, any> = {};
		extension({
			registerCommand() {}, on() {}, sendUserMessage() {},
			registerTool(definition: Record<string, any>) { tool = definition; },
			exec: async (command: string, args: string[]) => {
				const result = spawnSync(command, args, { encoding: "utf8" });
				return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
			},
		} as unknown as ExtensionAPI);
		const call = async (params: Record<string, unknown>) => parsed(await tool.execute("call", { runId, ...params }, undefined, () => {}, {} as ExtensionContext));
		await body({ runId, operationId, dbPath, call });
	} finally {
		Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
	}
}

describe("orphan reporting and recovery through the tool", () => {
	test("op=next reports the orphan, collect settles it failed, and retry replaces the worker without parking the run", async () => {
		await withOrphan(0, async ({ operationId, call }) => {
			const next = await call({ op: "next" });
			const row = next.operations.find((operation: Record<string, unknown>) => operation.id === operationId);
			assert.equal(row.status, "orphaned");
			assert.equal(row.storedStatus, "running");
			assert.equal(row.orphanReason, "attempt-directory-missing");
			assert.match(String(row.recovery), /op=collect/);

			const collected = await call({ op: "collect", operationId });
			assert.equal(collected.error, undefined, JSON.stringify(collected));
			assert.equal(collected.attempt.processState, "failed");
			assert.match(String(collected.attempt.outcome.error), /worker orphaned: private run directory .* no longer exists/);
			const retried = await call({ op: "retry", operationId });
			assert.equal(retried.error, undefined, JSON.stringify(retried));
			assert.equal(retried.classification, "worker-gone");
			assert.equal(retried.state.status, "active");
			assert.equal(retried.operation.status, "pending");
			assert.equal(retried.operation.transient_attempts, 1);
			assert.ok(retried.operation.retry_not_before, "a transient retry is scheduled with backoff");
		});
	});

	test("an orphan whose transient budget is spent parks the run, and resolve aborts it with an events row", async () => {
		await withOrphan(3, async ({ runId, operationId, dbPath, call }) => {
			assert.equal((await call({ op: "collect", operationId })).attempt.processState, "failed");
			const retried = await call({ op: "retry", operationId });
			assert.equal(retried.error, undefined, JSON.stringify(retried));
			assert.equal(retried.state.status, "awaiting_user");
			assert.equal(retried.operation.status, "failed");
			const aborted = await call({ op: "resolve", operationId, decision: "abort" });
			assert.equal(aborted.error, undefined, JSON.stringify(aborted));
			assert.equal(aborted.state.status, "cancelled");
			const store = new GraphStore({ dbPath });
			try {
				const events = store.events(runId, 100);
				assert.ok(events.some((event) => event.type === "retry_exhausted" && event.operation_id === operationId), "the park is recorded as budget exhaustion, not a permanent failure");
				assert.ok(events.some((event) => event.type === "abort" && event.operation_id === operationId), "resolve records its decision as an events row");
			} finally { store.close(); }
		});
	});
});
