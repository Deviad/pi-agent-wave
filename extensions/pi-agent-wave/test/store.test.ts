import { afterEach, describe, expect, test } from "./harness.ts";
import assert from "node:assert/strict";
import { Database } from "../sqlite.ts";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore, roleForNode } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import type { ResolvedPolicy } from "../types.ts";

const dirs: string[] = [];
function fixture(random = () => 0.5): { dir: string; dbPath: string; store: GraphStore } {
	const dir = mkdtempSync(join(tmpdir(), "delegate-graph-store-"));
	dirs.push(dir);
	const dbPath = join(dir, "graph.db");
	return { dir, dbPath, store: new GraphStore({ dbPath, now: () => new Date("2026-08-17T12:00:00.000Z"), random }) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Registers a runtime attempt for a pending operation the way dispatch does, with a headless worker and the frozen identity. */
function start(store: GraphStore, runId: string, operationId: string, agentId?: string): string {
	const next = store.next(runId);
	const operation = next.operations.find((candidate) => candidate.id === operationId);
	if (!operation) throw new Error(`operation ${operationId} is not pending`);
	const selectedModel = operation.route?.chain[operation.model_attempt] ?? "openai-codex/gpt-5.6-sol";
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: roleForNode(operation.node), modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel, agent: selectAcpAgent(selectedModel) });
	const registered = agentId ?? store.registerAgent({ runId, name: `worker-${operationId.slice(-8)}-${operation.transient_attempts}`, node: operation.node, role: roleForNode(operation.node), transport: "headless", currentTask: operation.task });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: next.policy.digest, agentId: registered });
	return identity.attemptKey;
}

/** Settles the operation's attempt as exited with a retained answer and accepts it with the given verdict and payload. */
function complete(store: GraphStore, runId: string, operationId: string, verdict?: string, payload?: Record<string, unknown>): void {
	const attempt = store.runtimeAttemptByOperation(operationId);
	if (!attempt) throw new Error(`operation ${operationId} has no runtime attempt`);
	const answer = store.retainRuntimeContent(Buffer.from(`answer for ${operationId}${verdict ? `\n\nVERDICT: ${verdict}` : ""}\n`));
	store.settleRuntimeAttempt({ attemptKey: attempt.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: attempt.attemptKey, requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	store.decideRuntimeCandidate({ attemptKey: attempt.attemptKey, decision: "accepted", reason: `test acceptance of ${operationId}`, verdict, payload });
	void runId;
}

/** Settles the operation's attempt as failed and lets the runtime classify the retry. */
function fail(store: GraphStore, runId: string, operationId: string, error: string) {
	const attempt = store.runtimeAttemptByOperation(operationId);
	if (!attempt) throw new Error(`operation ${operationId} has no runtime attempt`);
	store.settleRuntimeAttempt({ attemptKey: attempt.attemptKey, outcome: { kind: "failed", exitCode: 1, error } });
	return store.retryRuntimeAttempt({ runId, operationId });
}

function runConcurrencyWorker(dbPath: string, runId: string, operationId: string): Promise<void> {
	const workerPath = new URL("./concurrency-worker.ts", import.meta.url).pathname;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, dbPath, runId, operationId], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let error = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			error += chunk;
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error || `worker exited ${code}`))));
	});
}

/** A resolved policy fixture exercising a preset input and three role routes. */
function balancedPolicy(): ResolvedPolicy {
	return {
		input: { kind: "preset", preset: "balanced" },
		routes: [
			{
				role: "thinker",
				tier: "reasoning",
				chain: ["openai-codex/gpt-5.6-sol", "claude-code/claude-opus-5"],
				thinking: "high",
				session: true,
				capabilityFloor: "planning",
				selectionSource: "preset:balanced",
				promoted: false,
				promotionReason: null,
			},
			{
				role: "implementer",
				tier: "coding",
				chain: ["openai-codex/gpt-5.6-luna", "alibaba/glm-5.2"],
				thinking: "high",
				session: true,
				capabilityFloor: "implementation",
				selectionSource: "preset:balanced",
				promoted: false,
				promotionReason: null,
			},
			{
				role: "reviewer",
				tier: "review",
				chain: ["claude-code/claude-opus-5"],
				thinking: "high",
				session: false,
				capabilityFloor: "independent_review",
				selectionSource: "capability-floor",
				promoted: true,
				promotedFrom: "coding",
				promotionReason: "capability floor independent_review",
			},
			...(["tester", "auditor", "searcher"] as const).map((role) => ({
				role, tier: "review", chain: ["claude-code/claude-opus-5"], thinking: "high" as const, session: false, capabilityFloor: "independent_review", selectionSource: "preset:balanced", promoted: false, promotionReason: null,
			})),
		],
	};
}

describe("SQLite state store", () => {
	test("new stores omit panel-only agent fields", () => {
		const { dbPath, store } = fixture();
		const db = new Database(dbPath, { readonly: true });
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((row) => row.name);
		expect(columns.includes("pane_id")).toBe(false);
		db.close();
		store.close();
	});

	test("rejects non-Herdr agent registration", () => {
		const { store } = fixture();
		const state = store.initRun("transport", "build", "Use Herdr", balancedPolicy());
		const operation = store.next(state.runId).operations[0]!;
		const registration = {
			runId: state.runId,
			name: "worker",
			node: operation.node,
			role: "thinker",
			transport: "panel",
			currentTask: operation.task,
		};
		assert.throws(() => Reflect.apply(store.registerAgent, store, [registration]), /unsupported worker transport/);
		store.close();
	});

	test("creates a private WAL database with the required schema", () => {
		const { dbPath, store } = fixture();
		const db = new Database(dbPath, { readonly: true });
		const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
		expect(journal?.journal_mode).toBe("wal");
		expect(tables).toEqual(expect.arrayContaining(["runs", "graphs", "agents", "operations", "events", "state"]));
		expect(statSync(dbPath).mode & 0o777).toBe(0o600);
		db.close();
		store.close();
	});

	test("rejects invalid run and operation lifecycle states at the database boundary", () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("invalid-state", "build", "Plan", balancedPolicy());
		const operation = store.next(state.runId).operations[0];
		const db = new Database(dbPath);
		expect(() => db.query("UPDATE operations SET status='invalid' WHERE id=?").run(operation.id)).toThrow(/CHECK constraint/);
		expect(() => db.query("UPDATE runs SET status='invalid' WHERE id=?").run(state.runId)).toThrow(/CHECK constraint/);
		db.close();
		store.close();
	});

	test("rolls back a transition and result event when slice creation fails", () => {
		const { store } = fixture();
		const state = store.initRun("rollback", "build", "Plan", balancedPolicy());
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		expect(() => complete(store, state.runId, thinker.id, "PASS")).toThrow("at least one slice");
		expect(store.getOperation(thinker.id).status).toBe("running");
		expect(store.events(state.runId).some((event) => event.type === "result")).toBe(false);
		store.close();
	});

	test("joins parallel operations before advancing", () => {
		const { store } = fixture();
		const state = store.initRun("join", "build", "Plan", balancedPolicy());
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		complete(store, state.runId, thinker.id, "PASS", {
			slices: [
				{ id: "a", name: "A", task: "A", ownedPaths: ["a.ts"] },
				{ id: "b", name: "B", task: "B", ownedPaths: ["b.ts"] },
			],
		});
		const implementers = store.next(state.runId).operations;
		expect(implementers).toHaveLength(2);
		for (const operation of implementers) start(store, state.runId, operation.id);
		complete(store, state.runId, implementers[0].id, "PASS");
		expect(store.getState(state.runId).currentNode).toBe("implement");
		complete(store, state.runId, implementers[1].id, "PASS");
		expect(store.getState(state.runId).currentNode).toBe("review");
		store.close();
	});

	test("settles running siblings while awaiting recovery without dispatching or advancing", () => {
		const { store } = fixture();
		const state = store.initRun("parked-siblings", "build", "Plan", balancedPolicy());
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		complete(store, state.runId, thinker.id, "PASS", {
			slices: ["a", "b", "c", "d"].map((id) => ({ id, name: id, task: id, ownedPaths: [`${id}.ts`] })),
		});
		const operations = store.next(state.runId).operations;
		const [first, second, finished, pending] = operations;
		for (const operation of [first, second, finished]) start(store, state.runId, operation.id);
		const parked = fail(store, state.runId, first.id, "AgentFS contains unowned changes: .git/config");
		assert.equal(parked.exhausted, true);
		assert.equal(store.getState(state.runId).status, "awaiting_user");
		// Siblings still settle their facts while the run is parked, but nothing advances or retries until the operator resolves.
		const siblingAttempt = store.runtimeAttemptByOperation(second.id)!;
		store.settleRuntimeAttempt({ attemptKey: siblingAttempt.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "HTTP 429" } });
		assert.equal(store.runtimeAttempt(siblingAttempt.attemptKey).processState, "failed");
		assert.throws(() => store.retryRuntimeAttempt({ runId: state.runId, operationId: second.id }), /run is awaiting_user/);
		const finishedAttempt = store.runtimeAttemptByOperation(finished.id)!;
		store.settleRuntimeAttempt({ attemptKey: finishedAttempt.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer: store.retainRuntimeContent(Buffer.from("done")), sources: [] } });
		assert.throws(() => store.decideRuntimeCandidate({ attemptKey: finishedAttempt.attemptKey, decision: "accepted", reason: "done" }), /run is awaiting_user/);
		assert.equal(store.getState(state.runId).currentNode, "implement");
		assert.equal(store.next(state.runId).state.status, "awaiting_user");
		assert.throws(() => start(store, state.runId, pending.id), /run is awaiting_user/);
		const foreign = store.initRun("foreign-sibling", "build", "Plan", balancedPolicy());
		assert.throws(() => store.retryRuntimeAttempt({ runId: foreign.runId, operationId: second.id, approved: true }), /does not belong/);
		assert.equal(store.retryRuntimeAttempt({ runId: state.runId, operationId: first.id, approved: true }).state.status, "active");
		assert.equal(store.getOperation(first.id).status, "pending");
		const siblingRetry = store.retryRuntimeAttempt({ runId: state.runId, operationId: second.id });
		assert.deepEqual([siblingRetry.classification, siblingRetry.operation.status], ["http-429", "pending"]);
		store.decideRuntimeCandidate({ attemptKey: finishedAttempt.attemptKey, decision: "accepted", reason: "done", verdict: "DONE" });
		assert.equal(store.getOperation(finished.id).status, "completed");
		assert.equal(store.getState(state.runId).status, "active");
		store.close();
	});

	test("serializes concurrent WAL writers without losing results or duplicating the join", async () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("concurrency", "build", "Plan", balancedPolicy());
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		complete(store, state.runId, thinker.id, "PASS", {
			slices: [
				{ id: "a", name: "A", task: "A", ownedPaths: ["a.ts"] },
				{ id: "b", name: "B", task: "B", ownedPaths: ["b.ts"] },
			],
		});
		const implementers = store.next(state.runId).operations;
		for (const operation of implementers) start(store, state.runId, operation.id);
		store.close();

		await Promise.all(implementers.map((operation) => runConcurrencyWorker(dbPath, state.runId, operation.id)));
		const verify = new GraphStore({ dbPath });
		expect(verify.getState(state.runId).currentNode).toBe("review");
		expect(verify.events(state.runId).filter((event) => event.type === "result")).toHaveLength(3);
		expect(verify.next(state.runId).operations).toHaveLength(1);
		verify.close();
	});

	test("rejects overlapping writable ownership before implementer dispatch", () => {
		const { store } = fixture();
		const state = store.initRun("ownership", "build", "Plan", balancedPolicy());
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		expect(() =>
			complete(store, state.runId, thinker.id, "PASS", {
				slices: [
					{ id: "a", name: "A", task: "A", ownedPaths: ["shared.ts"] },
					{ id: "b", name: "B", task: "B", ownedPaths: ["shared.ts"] },
				],
			}),
		).toThrow("owned by both");
		expect(store.getOperation(thinker.id).status).toBe("running");
		store.close();
	});

	test("routes reviewer and tester feedback through implementers before terminal success", () => {
		const { store } = fixture();
		const state = store.initRun("full-loop", "build", "Plan", balancedPolicy());
		let operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS", { slices: [{ id: "core", name: "Core", task: "Implement core", ownedPaths: ["extensions/pi-agent-wave/**"] }] });

		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "FAIL", { feedback: "Fix review finding" });
		expect(store.getState(state.runId).currentNode).toBe("implement");
		expect(store.getState(state.runId).fixIteration).toBe(1);

		operation = store.next(state.runId).operations[0];
		expect(operation.task).toContain("Fix review finding");
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "NOT_OK", { feedback: "Tester found a defect" });
		expect(store.getState(state.runId).currentNode).toBe("implement");
		expect(store.getState(state.runId).round).toBe(2);

		operation = store.next(state.runId).operations[0];
		expect(operation.task).toContain("Tester found a defect");
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "GREEN");
		operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		expect(store.getState(state.runId).status).toBe("terminal");
		// A terminal run has no current operation: the last audit is stale for the terminal node, so no retry can reopen it.
		assert.throws(() => store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true }), /stale for current graph state/);
		const results = store.events(state.runId, 10_000).filter((event) => event.type === "result");
		expect(results).toHaveLength(10);
		for (const result of results) {
			const payload = JSON.parse(result.payload_json) as Record<string, unknown>;
			expect("reportPath" in payload).toBe(false);
		}
		const handoffs = store.events(state.runId, 10_000).filter((event) => event.type === "handoff").map((event) => event.to_node);
		expect(handoffs).toEqual([
			"implement",
			"review",
			"implement",
			"review",
			"test",
			"implement",
			"review",
			"test",
			"audit",
			"terminal",
		]);
		store.close();
	});

	test("marks research fan-out read-only and never enters implementation", () => {
		const { store } = fixture();
		const state = store.initRun("research", "research", "Explore", balancedPolicy());
		let operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS", {
			slices: [
				{ id: "one", name: "One", task: "Search one", readOnly: true },
				{ id: "two", name: "Two", task: "Search two", readOnly: true },
			],
		});
		const searchers = store.next(state.runId).operations;
		expect(searchers.map((item) => item.read_only)).toEqual([1, 1]);
		for (const searcher of searchers) {
			start(store, state.runId, searcher.id);
			complete(store, state.runId, searcher.id, "PASS");
		}
		operation = store.next(state.runId).operations[0];
		expect(operation.node).toBe("thinker_synthesize");
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "PASS");
		expect(store.getState(state.runId).status).toBe("terminal");
		expect(store.operations(state.runId).some((item) => item.node === "implement")).toBe(false);
		store.close();
	});

	test("records three transient retries without consuming a semantic round then awaits user", () => {
		const { store } = fixture(() => 0.5);
		// One frozen model: the same-model budget is the whole chain, so the fourth failure parks the run.
		const singleChain = balancedPolicy();
		singleChain.routes[0] = { ...singleChain.routes[0], chain: [singleChain.routes[0].chain[0]] };
		const state = store.initRun("retry", "build", "Plan", singleChain);
		const operation = store.next(state.runId).operations[0];
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			start(store, state.runId, operation.id);
			const result = fail(store, state.runId, operation.id, "HTTP 429");
			expect(result.retry?.attempt).toBe(attempt);
			expect(result.state.round).toBe(1);
		}
		start(store, state.runId, operation.id);
		const exhausted = fail(store, state.runId, operation.id, "HTTP 429");
		expect(exhausted.exhausted).toBe(true);
		expect(exhausted.state.status).toBe("awaiting_user");
		expect(store.events(state.runId).filter((event) => event.type === "retry")).toHaveLength(3);
		store.close();
	});

	test("resumes the same exhausted operation idempotently", () => {
		const { store } = fixture();
		const state = store.initRun("resume", "build", "Plan", balancedPolicy());
		const operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		expect(fail(store, state.runId, operation.id, "compile error").exhausted).toBe(true);
		const resumed = store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true }).state;
		expect(resumed.status).toBe("active");
		expect(store.next(state.runId).operations[0].id).toBe(operation.id);
		expect(store.getOperation(operation.id).status).toBe("pending");
		store.close();
	});

	test("recovers an explicit block without reusing its report or worker", () => {
		const { store, dir } = fixture();
		const state = store.initRun("approval-block", "build", "Plan", balancedPolicy());
		const operation = store.next(state.runId).operations[0];
		const agentId = store.registerAgent({ runId: state.runId, node: operation.node, role: "thinker", currentTask: operation.task, name: "blocked-worker", transport: "herdr", herdrAgent: "blocked-worker", tabId: "fixture-tab", herdrPaneId: "fixture-pane" });
		const attemptKey = start(store, state.runId, operation.id, agentId);
		void dir;
		const parked = fail(store, state.runId, operation.id, "permission denied for fs/read_text_file");
		assert.deepEqual([parked.exhausted, parked.classification], [true, "approval-block"]);
		const before = store.getOperation(operation.id);
		const policy = store.policy(state.runId);
		store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true });
		const retried = store.getOperation(operation.id);
		assert.equal(store.getState(state.runId).status, "active");
		assert.equal(retried.status, "pending");
		for (const key of ["agent_id", "verdict", "finished_at"] as const) assert.equal(retried[key], null);
		for (const key of ["id", "node", "round", "fix_iteration", "owned_paths_json", "selected_model", "model_attempt"] as const) assert.equal(retried[key], before[key]);
		assert.equal(retried.transient_attempts, before.transient_attempts + 1, "the replacement identity is fresh without restoring the budget");
		assert.deepEqual(store.policy(state.runId), policy);
		assert.equal(retried.retry_reason, "operator-approved-retry");
		assert.equal(retried.fallback_reason, null);
		assert.ok(store.runtimeAttempt(attemptKey).supersededAt, "the failed attempt is superseded, never reused");
		assert.equal(store.agents(state.runId).find((entry) => entry.id === agentId)?.status, "failed");
		assert.throws(() => complete(store, state.runId, operation.id, "READY"), /has no runtime attempt/);
		store.close();
	});

	test("explicit blocks support defer, abort and escalate without changing semantic rounds", () => {
		for (const decision of ["defer", "abort", "escalate"] as const) {
			const { store } = fixture();
			const state = store.initRun(`block-${decision}`, "build", "Plan", balancedPolicy());
			const operation = store.next(state.runId).operations[0];
			start(store, state.runId, operation.id);
			assert.equal(fail(store, state.runId, operation.id, "permission denied for fs/read_text_file").exhausted, true);
			const result = store.resolveExhaustion(state.runId, operation.id, decision, "2026-08-18T12:00:00.000Z");
			assert.equal(result.status, { defer: "deferred", abort: "cancelled", escalate: "blocked" }[decision]);
			assert.equal(result.round, state.round);
			if (decision !== "abort") assert.equal(store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true }).state.status, "active");
			else assert.throws(() => store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true }), /recovery decision/);
			store.close();
		}
	});

	test("recovery rejects foreign and stale operations without mutating either run", () => {
		const { store } = fixture();
		const first = store.initRun("first-recovery", "build", "Plan", balancedPolicy());
		const second = store.initRun("second-recovery", "build", "Plan", balancedPolicy());
		const original = store.next(first.runId).operations[0];
		const foreign = store.next(second.runId).operations[0];
		start(store, first.runId, original.id);
		complete(store, first.runId, original.id, "READY", { slices: [{ id: "slice", name: "Slice", task: "Implement", ownedPaths: ["owned.ts"] }] });
		const current = store.next(first.runId).operations[0];
		start(store, first.runId, current.id);
		assert.equal(fail(store, first.runId, current.id, "permission denied for fs/read_text_file").exhausted, true);
		const before = [store.getState(first.runId), store.getState(second.runId), store.operations(first.runId), store.operations(second.runId), store.events(first.runId)];
		for (const decision of ["defer", "abort", "escalate"] as const) {
			assert.throws(() => store.resolveExhaustion(first.runId, foreign.id, decision, "2026-08-18T12:00:00.000Z"), /does not belong to run/);
			assert.throws(() => store.resolveExhaustion(first.runId, original.id, decision, "2026-08-18T12:00:00.000Z"), /stale/);
		}
		assert.throws(() => store.retryRuntimeAttempt({ runId: first.runId, operationId: foreign.id, approved: true }), /does not belong to run/);
		assert.throws(() => store.retryRuntimeAttempt({ runId: first.runId, operationId: original.id, approved: true }), /stale/);
		assert.deepEqual([store.getState(first.runId), store.getState(second.runId), store.operations(first.runId), store.operations(second.runId), store.events(first.runId)], before);
		store.close();
	});

	test("recovery cannot reopen a completed semantic-cap block", () => {
		const { store } = fixture();
		const state = store.initRun("semantic-cap-recovery", "build", "Plan", balancedPolicy());
		let operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		complete(store, state.runId, operation.id, "READY", { slices: [{ id: "slice", name: "Slice", task: "Implement", ownedPaths: ["owned.ts"] }] });
		while (store.getState(state.runId).status === "active") {
			operation = store.next(state.runId).operations[0];
			start(store, state.runId, operation.id);
			complete(store, state.runId, operation.id, operation.node === "implement" ? "DONE" : "FAIL");
		}
		const before = store.getState(state.runId);
		assert.equal(before.status, "blocked");
		assert.equal(store.getOperation(operation.id).status, "completed");
		assert.throws(() => store.retryRuntimeAttempt({ runId: state.runId, operationId: operation.id, approved: true }), /explicitly blocked operation/);
		assert.deepEqual(store.getState(state.runId), before);
		store.close();
	});

	test("migrates a v1 database to v5 preserving existing rows", () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-graph-v1-"));
		dirs.push(dir);
		const dbPath = join(dir, "graph.db");
		const v1 = new Database(dbPath);
		v1.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (1);
			CREATE TABLE runs (id TEXT PRIMARY KEY, story TEXT NOT NULL, graph_name TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
			CREATE TABLE operations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node TEXT NOT NULL, slice_id TEXT, agent_id TEXT, status TEXT NOT NULL, read_only INTEGER NOT NULL, owned_paths_json TEXT NOT NULL DEFAULT '[]', round INTEGER NOT NULL, fix_iteration INTEGER NOT NULL, transient_attempts INTEGER NOT NULL DEFAULT 0, task TEXT NOT NULL, report_path TEXT, verdict TEXT, classifier_reason TEXT, last_error TEXT, retry_not_before TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
			CREATE TABLE agents (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, node TEXT NOT NULL, role TEXT NOT NULL, transport TEXT NOT NULL, herdr_agent TEXT, pane_id TEXT, tab_id TEXT, status TEXT NOT NULL, current_task TEXT NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL);
			CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT NOT NULL, operation_id TEXT, agent_id TEXT, type TEXT NOT NULL, node TEXT, from_agent TEXT, to_agent TEXT, reply_to TEXT, from_node TEXT, to_node TEXT, verdict TEXT, payload_json TEXT NOT NULL DEFAULT '{}');
			INSERT INTO runs VALUES ('run_v1','legacy','build','Legacy task','active','2026-08-16T00:00:00.000Z','2026-08-16T00:00:00.000Z');
			INSERT INTO operations VALUES ('op_v1','run_v1','thinker_plan',NULL,NULL,'pending',1,'[]',1,0,0,'Legacy operation',NULL,NULL,NULL,NULL,NULL,'2026-08-16T00:00:00.000Z',NULL,NULL);
			INSERT INTO agents VALUES ('agent_v1','run_v1','thinker','thinker_plan','thinker','herdr','dg-legacy-thinker',NULL,'workspace:tab', 'running','Legacy operation','2026-08-16T00:00:00.000Z','2026-08-16T00:00:01.000Z');
			INSERT INTO events(ts,run_id,operation_id,agent_id,type,node,from_agent,to_agent,reply_to,from_node,to_node,verdict,payload_json) VALUES ('2026-08-16T00:00:02.000Z','run_v1','op_v1','agent_v1','legacy_event','thinker_plan','thinker','supervisor','supervisor','thinker_plan',NULL,NULL,'{"legacy":true}');
		`);
		v1.close();
		const migrated = new GraphStore({ dbPath });
		const db = new Database(dbPath, { readonly: true });
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map((row) => row.name);
		expect(columns).toEqual(expect.arrayContaining(["policy_json", "policy_digest"]));
		const row = db.query<{ story: string; task: string; status: string; policy_json: string; policy_digest: string }, []>("SELECT story,task,status,policy_json,policy_digest FROM runs WHERE id='run_v1'").get();
		expect(row?.story).toBe("legacy");
		expect(row?.task).toBe("Legacy task");
		expect(row?.status).toBe("active");
		expect(JSON.parse(row?.policy_json ?? "{}")).toEqual({ input: { kind: "auto" }, routes: [] });
		assert.match(row?.policy_digest ?? "", /^[a-f0-9]{64}$/);
		for (const table of ["runs", "operations", "agents", "events"]) {
			const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
			expect(count?.count).toBe(1);
		}
		const event = db.query<{ payload_json: string }, []>("SELECT payload_json FROM events WHERE operation_id='op_v1'").get();
		expect(JSON.parse(event?.payload_json ?? "{}")).toEqual({ legacy: true });
		expect(db.query<{ selected_model: string | null }, []>("SELECT selected_model FROM operations WHERE id='op_v1'").get()?.selected_model).toBe(null);
		expect(db.query<{ selected_model: string | null }, []>("SELECT selected_model FROM agents WHERE id='agent_v1'").get()?.selected_model).toBe(null);
		const version = db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get();
		expect(version?.version).toBe(11);
		db.close();
		migrated.close();
		const reopened = new GraphStore({ dbPath });
		expect(reopened.policy("run_v1").input).toEqual({ kind: "auto" });
		reopened.close();
	});

	test("persists an immutable canonical policy snapshot with a stable digest", () => {
		const { store } = fixture();
		const first = store.initRun("policy-1", "build", "Plan", balancedPolicy());
		const second = store.initRun("policy-2", "build", "Plan", balancedPolicy());
		const digestA = store.policy(first.runId).digest;
		const digestB = store.policy(second.runId).digest;
		expect(digestA).toHaveLength(64);
		assert.match(digestA, /^[a-f0-9]{64}$/);
		expect(digestA).toBe(digestB);
		const mutated = { ...balancedPolicy(), routes: balancedPolicy().routes.slice(0, 2) };
		const third = store.initRun("policy-3", "build", "Plan", mutated);
		assert.notStrictEqual(store.policy(third.runId).digest, digestA);
		const initialized = store.events(first.runId).find((event) => event.type === "run_initialized");
		expect(JSON.parse(initialized?.payload_json ?? "{}").policy.digest).toBe(digestA);
		store.close();
	});

	test("resumes the same frozen policy digest without re-resolving", () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("resume-policy", "build", "Plan", balancedPolicy());
		const digestAtInit = store.policy(state.runId).digest;
		store.close();
		const resumed = new GraphStore({ dbPath });
		expect(resumed.policy(state.runId).digest).toBe(digestAtInit);
		expect(resumed.policy(state.runId).routes).toEqual(balancedPolicy().routes);
		resumed.close();
	});

	test("next returns the frozen role route for each pending operation", () => {
		const { store } = fixture();
		const state = store.initRun("routes", "build", "Plan", balancedPolicy());
		const next = store.next(state.runId);
		expect(next.policy.digest).toHaveLength(64);
		assert.match(next.policy.digest, /^[a-f0-9]{64}$/);
		expect(next.operations[0]?.route?.role).toBe("thinker");
		expect(next.operations[0]?.route?.tier).toBe("reasoning");
		expect(store.routeForNode(state.runId, "thinker_plan")?.chain).toEqual(["openai-codex/gpt-5.6-sol", "claude-code/claude-opus-5"]);
		store.close();
	});

	test("rejects a conflicting policy or digest on every frozen-route dispatch", () => {
		const { store } = fixture();
		const state = store.initRun("immutable-policy", "build", "Plan", balancedPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0];
		const selectedModel = operation.route?.chain[0] ?? "";
		const identity = createHeadlessAcpxAttemptIdentity({ runId: state.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel, agent: selectAcpAgent(selectedModel) });
		expect(() => store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: "0".repeat(64) })).toThrow(/policy digest mismatch/);
		const foreignModel = createHeadlessAcpxAttemptIdentity({ ...identity, selectedModel: "openai-codex/gpt-5.5-unfrozen" });
		expect(() => store.beginRuntimeAttempt({ identity: foreignModel, sessionId: foreignModel.sessionName, requestId: null, policyDigest: next.policy.digest })).toThrow(/conflicts with frozen policy/);
		expect(store.policy(state.runId).input).toEqual({ kind: "preset", preset: "balanced" });
		expect(store.runtimeAttemptByOperation(operation.id)).toBe(undefined);
		store.close();
	});
});

describe("transport-aware agent persistence", () => {
	test("projects complete headless and Herdr presentation identities", () => {
		const { store } = fixture();
		const state = store.initRun("transport-identities", "build", "Plan", balancedPolicy());
		const operation = store.next(state.runId).operations[0]!;
		const core = { runId: state.runId, node: operation.node, role: "thinker", currentTask: operation.task, acpAgent: "codex" as const, acpxRecordId: "session", acpxSessionId: "session", acpxState: "alive" as const, acpxAttemptKey: "attempt", agentFsSessionId: "session", agentFsDbPath: "/tmp/delta.db", acpxCancelScript: "/tmp/cancel.sh" };
		store.registerAgent({ ...core, name: "headless-worker", transport: "headless" });
		store.registerAgent({ ...core, name: "herdr-worker", transport: "herdr", herdrAgent: "agent", tabId: "tab", herdrPaneId: "pane" });
		const agents = store.agents(state.runId);
		expect(agents.find((agent) => agent.name === "headless-worker")?.presentation_identity).toEqual({ kind: "headless" });
		expect(agents.find((agent) => agent.name === "herdr-worker")?.presentation_identity).toEqual({ kind: "herdr", agent: "agent", tabId: "tab", paneId: "pane" });
		store.close();
	});

	test("rejects mixed and partial presentation identity", () => {
		const { store } = fixture();
		const state = store.initRun("transport-invalid", "build", "Plan", balancedPolicy());
		const operation = store.next(state.runId).operations[0]!;
		const base = { runId: state.runId, node: operation.node, role: "thinker", currentTask: operation.task };
		assert.throws(() => store.registerAgent({ ...base, name: "mixed", transport: "headless", herdrAgent: "agent", tabId: "tab", herdrPaneId: "pane" }), /cannot contain Herdr identity/);
		assert.throws(() => store.registerAgent({ ...base, name: "partial", transport: "herdr", herdrAgent: "agent", tabId: "tab" }), /requires agent, tab, and pane/);
		store.close();
	});
});
