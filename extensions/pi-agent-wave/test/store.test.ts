import { afterEach, describe, expect, test } from "./harness.ts";
import assert from "node:assert/strict";
import { Database } from "../sqlite.ts";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReport } from "../scripts/report-audit.ts";
import { GraphStore } from "../store.ts";
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

function start(store: GraphStore, runId: string, operationId: string): void {
	const next = store.next(runId);
	const operation = next.operations.find((candidate) => candidate.id === operationId);
	store.record({
		runId,
		operationId,
		status: "running",
		agentName: "worker",
		transport: "herdr",
		modelPolicy: next.policy.input,
		policyDigest: next.policy.digest,
		selectedModel: operation?.route?.chain[0],
		modelAttempt: operation?.route ? 0 : undefined,
	});
}

function complete(store: GraphStore, runId: string, operationId: string, verdict?: string, payload?: Record<string, unknown>): void {
	store.record({ runId, operationId, status: "completed", verdict, payload, reportPath: `/tmp/${operationId}.json` });
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
		const state = store.initRun("transport", "build", "Use Herdr");
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
		const state = store.initRun("invalid-state", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		const db = new Database(dbPath);
		expect(() => db.query("UPDATE operations SET status='invalid' WHERE id=?").run(operation.id)).toThrow(/CHECK constraint/);
		expect(() => db.query("UPDATE runs SET status='invalid' WHERE id=?").run(state.runId)).toThrow(/CHECK constraint/);
		db.close();
		store.close();
	});

	test("requires a valid headless or Herdr transport before an operation starts", () => {
		const { store } = fixture();
		const headlessState = store.initRun("headless-transport", "build", "Plan");
		const headlessOperation = store.next(headlessState.runId).operations[0];
		expect(() => store.record({ runId: headlessState.runId, operationId: headlessOperation.id, status: "running" })).toThrow("worker transport");
		expect(() => store.record({ runId: headlessState.runId, operationId: headlessOperation.id, status: "running", transport: "delegate" as never })).toThrow("unsupported worker transport");
		store.record({ runId: headlessState.runId, operationId: headlessOperation.id, status: "running", transport: "headless" });
		const headlessDispatch = store.events(headlessState.runId).find((event) => event.type === "operation_running");
		expect(JSON.parse(headlessDispatch?.payload_json ?? "{}").transport).toBe("headless");
		const herdrState = store.initRun("herdr-transport", "build", "Plan");
		const herdrOperation = store.next(herdrState.runId).operations[0];
		store.record({ runId: herdrState.runId, operationId: herdrOperation.id, status: "running", transport: "herdr" });
		const herdrDispatch = store.events(herdrState.runId).find((event) => event.type === "operation_running");
		expect(JSON.parse(herdrDispatch?.payload_json ?? "{}").transport).toBe("herdr");
		store.close();
	});

	test("rolls back a transition and result event when slice creation fails", () => {
		const { store } = fixture();
		const state = store.initRun("rollback", "build", "Plan");
		const thinker = store.next(state.runId).operations[0];
		start(store, state.runId, thinker.id);
		expect(() => complete(store, state.runId, thinker.id, "PASS")).toThrow("at least one slice");
		expect(store.getOperation(thinker.id).status).toBe("running");
		expect(store.events(state.runId).some((event) => event.type === "result")).toBe(false);
		store.close();
	});

	test("joins parallel operations before advancing", () => {
		const { store } = fixture();
		const state = store.initRun("join", "build", "Plan");
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

	test("serializes concurrent WAL writers without losing results or duplicating the join", async () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("concurrency", "build", "Plan");
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
		const state = store.initRun("ownership", "build", "Plan");
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
		const state = store.initRun("full-loop", "build", "Plan");
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
		const results = store.events(state.runId).filter((event) => event.type === "result");
		expect(results).toHaveLength(10);
		for (const result of results) {
			const payload = JSON.parse(result.payload_json) as { reportPath?: string };
			expect(payload.reportPath).toBe(`/tmp/${result.operation_id}.json`);
		}
		const handoffs = store.events(state.runId).filter((event) => event.type === "handoff").map((event) => event.to_node);
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
		const state = store.initRun("research", "research", "Explore");
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
		const state = store.initRun("retry", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const result = store.record({ runId: state.runId, operationId: operation.id, status: "failed", error: "HTTP 429" });
			expect(result.retry?.attempt).toBe(attempt);
			expect(result.state.round).toBe(1);
		}
		const exhausted = store.record({ runId: state.runId, operationId: operation.id, status: "failed", error: "HTTP 429" });
		expect(exhausted.requiresUserDecision).toBe(true);
		expect(exhausted.state.status).toBe("awaiting_user");
		expect(store.events(state.runId).filter((event) => event.type === "retry")).toHaveLength(3);
		store.close();
	});

	test("resumes the same exhausted operation idempotently", () => {
		const { store } = fixture();
		const state = store.initRun("resume", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		start(store, state.runId, operation.id);
		store.record({ runId: state.runId, operationId: operation.id, status: "failed", error: "compile error" });
		const resumed = store.resolveExhaustion(state.runId, operation.id, "retry");
		expect(resumed.status).toBe("active");
		expect(store.next(state.runId).operations[0].id).toBe(operation.id);
		expect(store.getOperation(operation.id).status).toBe("pending");
		store.close();
	});

	test("validates canonical private JSON reports", async () => {
		const { dir, store } = fixture();
		const report = join(dir, "report.json");
		const valid = (verdict: string) => JSON.stringify({
			schemaVersion: 1,
			verdict,
			claims: [{
				statement: "targeted verification completed",
				evidence: [{ kind: "command", source: "node --test", detail: "exit 0" }],
				verification: "verified",
			}],
		});
		writeFileSync(report, valid("PASS"));
		const accepted = await auditReport(report, { node: "review", privateRoot: dir });
		expect(accepted.valid).toBe(true);
		expect(accepted.verdict).toBe("PASS");
		expect(statSync(report).mode & 0o777).toBe(0o600);
		writeFileSync(report, JSON.stringify({ schemaVersion: 1, verdict: "PASS", claims: [] }));
		expect((await auditReport(report, { node: "review", privateRoot: dir })).valid).toBe(false);
		writeFileSync(report, valid("NOT_OK"));
		const tester = await auditReport(report, { node: "test", privateRoot: dir });
		expect(tester.valid).toBe(true);
		expect(tester.verdict).toBe("NOT_OK");
		const cliAudit = spawnSync(process.execPath, [
			"--experimental-strip-types",
			new URL("../scripts/report-audit.ts", import.meta.url).pathname,
			"--report", report,
			"--node", "test",
			"--private-root", dir,
		]);
		expect(cliAudit.status).toBe(0);
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
		expect(version?.version).toBe(5);
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

	test("dispatch events carry the frozen policy digest, role, tier, and chain", () => {
		const { store } = fixture();
		const state = store.initRun("events-policy", "build", "Plan", balancedPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0];
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			transport: "herdr",
			modelPolicy: next.policy.input,
			policyDigest: next.policy.digest,
			selectedModel: operation.route?.chain[0],
			modelAttempt: 0,
		});
		const dispatch = store.events(state.runId).find((event) => event.type === "operation_running");
		const payload = JSON.parse(dispatch?.payload_json ?? "{}") as Record<string, any>;
		expect(payload.policy.policyDigest).toBe(store.policy(state.runId).digest);
		expect(payload.policy.inputKind).toBe("preset");
		expect(payload.policy.role).toBe("thinker");
		expect(payload.policy.tier).toBe("reasoning");
		expect(payload.policy.selectedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(payload.policy.chainLength).toBe(2);
		expect(payload.policy.modelAttempt).toBe(0);
		expect(payload.policy.retryAttempt).toBe(0);
		expect(payload.policy.session).toBe(true);
		expect(payload.policy.capabilityFloor).toBe("planning");
		expect(payload.policy.fallbackReason).toBe(null);
		store.close();
	});

	test("rejects a conflicting policy or digest on every frozen-route dispatch", () => {
		const { store } = fixture();
		const state = store.initRun("immutable-policy", "build", "Plan", balancedPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0];
		const dispatch = {
			runId: state.runId,
			operationId: operation.id,
			status: "running" as const,
			transport: "herdr" as const,
			selectedModel: operation.route?.chain[0],
			modelAttempt: 0,
		};
		expect(() => store.record({ ...dispatch, modelPolicy: next.policy.input, policyDigest: "0".repeat(64) })).toThrow(/digest conflicts/);
		expect(() =>
			store.record({
				...dispatch,
				modelPolicy: { kind: "preset", preset: "strong" },
				policyDigest: next.policy.digest,
			}),
		).toThrow(/modelPolicy conflicts/);
		expect(store.policy(state.runId).input).toEqual({ kind: "preset", preset: "balanced" });
		store.close();
	});

	test("exact model locks reject cross-model fallback", () => {
		const { store } = fixture();
		const exact: ResolvedPolicy = {
			input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "required for this run" },
			routes: [{
				role: "thinker",
				tier: "exact",
				chain: ["openai-codex/gpt-5.6-sol"],
				thinking: "high",
				session: true,
				capabilityFloor: "planning",
				selectionSource: "exact-model",
				promoted: false,
				promotionReason: null,
			}],
		};
		const state = store.initRun("exact-lock", "build", "Plan", exact);
		const next = store.next(state.runId);
		const operation = next.operations[0];
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			transport: "herdr",
			modelPolicy: exact.input,
			policyDigest: next.policy.digest,
			selectedModel: exact.routes[0].chain[0],
			modelAttempt: 0,
		});
		expect(() => store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			transport: "herdr",
			modelPolicy: exact.input,
			policyDigest: next.policy.digest,
			selectedModel: "another/model",
			modelAttempt: 1,
			fallbackReason: "http-429",
		})).toThrow(/outside the frozen chain|cannot fall back/);
		store.close();
	});

	test("keeps same-model retry attempts separate from cross-model fallback attempts", () => {
		const { store } = fixture();
		const state = store.initRun("attempts", "build", "Plan", balancedPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0];
		const binding = { modelPolicy: next.policy.input, policyDigest: next.policy.digest };
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			transport: "herdr",
			...binding,
			selectedModel: operation.route?.chain[0],
			modelAttempt: 0,
		});
		const failed = store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "failed",
			error: "429 rate limit",
			retryReason: "provider_rate_limit",
		});
		expect(failed.retry?.attempt).toBe(1);
		expect(failed.retry?.modelAttempt).toBe(0);
		expect(failed.retry?.selectedModel).toBe("openai-codex/gpt-5.6-sol");
		expect(failed.operation.transient_attempts).toBe(1);
		expect(failed.operation.model_attempt).toBe(0);
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			transport: "herdr",
			...binding,
			selectedModel: operation.route?.chain[1],
			modelAttempt: 1,
			fallbackReason: "same_model_retries_exhausted",
		});
		const advanced = store.operations(state.runId).find((candidate) => candidate.id === operation.id);
		expect(advanced?.model_attempt).toBe(1);
		expect(advanced?.selected_model).toBe("claude-code/claude-opus-5");
		expect(advanced?.transient_attempts).toBe(0);
		expect(advanced?.fallback_reason).toBe("same_model_retries_exhausted");
		const retry = store.events(state.runId).find((event) => event.type === "retry");
		const retryPayload = JSON.parse(retry?.payload_json ?? "{}");
		expect(retryPayload.modelAttempt).toBe(0);
		expect(retryPayload.retryAttempt).toBe(1);
		expect(retryPayload.retryReason).toBe("provider_rate_limit");
		expect(retryPayload.fallbackReason).toBe(null);
		const fallback = store.events(state.runId).find((event) => event.type === "model_fallback");
		const fallbackPayload = JSON.parse(fallback?.payload_json ?? "{}");
		expect(fallbackPayload.modelAttempt).toBe(1);
		expect(fallbackPayload.retryAttempt).toBe(0);
		expect(fallbackPayload.fallbackReason).toBe("same_model_retries_exhausted");
		store.close();
	});
});

describe("transport-aware agent persistence", () => {
	test("projects complete headless and Herdr presentation identities", () => {
		const { store } = fixture();
		const state = store.initRun("transport-identities", "build", "Plan");
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
		const state = store.initRun("transport-invalid", "build", "Plan");
		const operation = store.next(state.runId).operations[0]!;
		const base = { runId: state.runId, node: operation.node, role: "thinker", currentTask: operation.task };
		assert.throws(() => store.registerAgent({ ...base, name: "mixed", transport: "headless", herdrAgent: "agent", tabId: "tab", herdrPaneId: "pane" }), /cannot contain Herdr identity/);
		assert.throws(() => store.registerAgent({ ...base, name: "partial", transport: "herdr", herdrAgent: "agent", tabId: "tab" }), /requires agent, tab, and pane/);
		store.close();
	});
});
