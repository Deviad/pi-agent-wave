import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../sqlite.ts";
import { GraphStore } from "../store.ts";

const directories: string[] = [];

function legacyTableSnapshot(db: Database, table: "runs" | "operations" | "agents" | "events") {
	const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
	const rows = db.query<Record<string, unknown>, []>(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all();
	return { columns, rows };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { directory: string; dbPath: string; store: GraphStore } {
	const directory = mkdtempSync(join(tmpdir(), "acpx-store-v4-"));
	directories.push(directory);
	const dbPath = join(directory, "graph.db");
	return { directory, dbPath, store: new GraphStore({ dbPath }) };
}

describe("GraphStore transport-aware provenance schema v5", () => {
	test("migrates idempotently and round-trips complete private provenance", () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("acpx-v4", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		assert.ok(operation);
		const agentId = store.registerAgent({
			runId: state.runId,
			name: "planner-1",
			node: operation.node,
			role: "thinker",
			transport: "herdr",
			herdrAgent: "dg-acpx-planner-1",
			tabId: "tab-1",
			currentTask: operation.task,
			acpAgent: "codex",
			acpxRecordId: "record-1",
			acpxSessionId: "session-1",
			acpxState: "alive",
			acpxAttemptKey: "run:op:0:0",
			agentFsSessionId: "agentfs-attempt-1",
			agentFsDbPath: "/tmp/attempt-1/delta.db",
			herdrPaneId: "pane-1",
			acpxCancelScript: "/tmp/cancel-1.sh",
		});
		const agent = store.agents(state.runId).find((candidate) => candidate.id === agentId);
		assert.equal(agent?.acp_agent, "codex");
		assert.equal(agent?.acpx_record_id, "record-1");
		assert.equal(agent?.acpx_session_id, "session-1");
		assert.equal(agent?.acpx_state, "alive");
		assert.equal(agent?.acpx_attempt_key, "run:op:0:0");
		assert.equal(agent?.agentfs_session_id, "agentfs-attempt-1");
		assert.equal(agent?.agentfs_db_path, "/tmp/attempt-1/delta.db");
		assert.equal(agent?.herdr_pane_id, "pane-1");
		assert.equal(agent?.acpx_cancel_script, "/tmp/cancel-1.sh");
		store.close();

		const reopened = new GraphStore({ dbPath });
		reopened.close();
		const db = new Database(dbPath, { readonly: true });
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((row) => row.name);
		const version = db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version;
		assert.deepEqual(columns.filter((name) => name.startsWith("acp") || name.startsWith("agentfs") || name === "herdr_pane_id"), ["acp_agent", "acpx_record_id", "acpx_session_id", "acpx_state", "acpx_attempt_key", "agentfs_session_id", "agentfs_db_path", "herdr_pane_id", "acpx_cancel_script"]);
		assert.equal(version, 5);
		db.close();
	});

	for (const sourceVersion of [1, 2, 3, 4]) {
		test(`migrates a directly seeded v${sourceVersion} database to v5 preserving rows`, () => {
			const { dbPath, store } = fixture();
			const state = store.initRun(`seeded-v${sourceVersion}`, "build", "Plan");
			const operation = store.next(state.runId).operations[0];
			assert.ok(operation);
			store.registerAgent({ runId: state.runId, name: "legacy-agent", node: operation.node, role: "thinker", transport: "herdr", herdrAgent: "legacy-herdr", tabId: "legacy-tab", herdrPaneId: "legacy-pane", currentTask: operation.task });
			store.close();
			const seeded = new Database(dbPath);
			seeded.exec("DROP TRIGGER agents_acpx_identity_insert; DROP TRIGGER agents_acpx_identity_update");
			if (sourceVersion <= 3) for (const column of ["acp_agent", "acpx_record_id", "acpx_session_id", "acpx_state", "acpx_attempt_key", "agentfs_session_id", "agentfs_db_path", "herdr_pane_id", "acpx_cancel_script"]) seeded.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
			if (sourceVersion <= 2) seeded.exec("ALTER TABLE operations DROP COLUMN command_json");
			if (sourceVersion === 1) {
				for (const column of ["policy_json", "policy_digest"]) seeded.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
				for (const column of ["model_attempt", "selected_model", "retry_reason", "fallback_reason"]) seeded.exec(`ALTER TABLE operations DROP COLUMN ${column}`);
				for (const column of ["policy_digest", "selected_model", "model_attempt"]) seeded.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
			}
			if (sourceVersion >= 2) {
				seeded.query("UPDATE operations SET model_attempt=2, selected_model='legacy/model', retry_reason='retry', fallback_reason='fallback'").run();
				seeded.query("UPDATE agents SET policy_digest='legacy-policy', selected_model='legacy/model', model_attempt=2").run();
			}
			if (sourceVersion >= 3) seeded.query("UPDATE operations SET command_json=?").run(JSON.stringify({ executable: "printf", args: ["legacy"], cwd: "/tmp" }));
			seeded.exec(`DELETE FROM schema_version; INSERT INTO schema_version(version) VALUES (${sourceVersion})`);
			const expected = Object.fromEntries((["runs", "operations", "agents", "events"] as const).map((table) => [table, legacyTableSnapshot(seeded, table)]));
			seeded.close();
			const migrated = new GraphStore({ dbPath });
			assert.equal(migrated.getRun(state.runId).story, `seeded-v${sourceVersion}`);
			assert.equal(migrated.agents(state.runId)[0]?.name, "legacy-agent");
			migrated.close();
			const db = new Database(dbPath, { readonly: true });
			assert.equal(db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 5);
			for (const table of ["runs", "operations", "agents", "events"] as const) {
				const observed = db.query<Record<string, unknown>, []>(`SELECT ${expected[table].columns.join(",")} FROM ${table} ORDER BY rowid`).all();
				assert.deepEqual(observed, expected[table].rows, `${table} legacy state changed during v${sourceVersion} migration`);
			}
			const legacyAgent = db.query<Record<string, unknown>, []>("SELECT acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,herdr_pane_id,acpx_cancel_script FROM agents WHERE name='legacy-agent'").get();
			assert.ok(legacyAgent);
			assert.ok(Object.entries(legacyAgent).every(([key, value]) => sourceVersion === 4 && key === "herdr_pane_id" ? value === "legacy-pane" : value === null));
			assert.equal(db.query("PRAGMA foreign_key_check").get(), undefined);
			assert.ok(db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().some((row) => row.name === "herdr_pane_id"));
			db.close();
		});
	}

	test("repairs an interrupted partial v4 migration idempotently", () => {
		const { dbPath, store } = fixture();
		store.close();
		const interrupted = new Database(dbPath);
		interrupted.exec("DROP TRIGGER agents_acpx_identity_insert; DROP TRIGGER agents_acpx_identity_update");
		interrupted.exec("ALTER TABLE agents DROP COLUMN agentfs_db_path");
		interrupted.exec("DELETE FROM schema_version WHERE version=4; INSERT OR REPLACE INTO schema_version(version) VALUES (3)");
		interrupted.close();
		const repaired = new GraphStore({ dbPath });
		repaired.close();
		const db = new Database(dbPath, { readonly: true });
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().map((row) => row.name);
		assert.ok(columns.includes("agentfs_db_path"));
		assert.equal(db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 5);
		db.close();
	});

	test("rejects inconsistent partial identity already persisted at the database boundary", () => {
		const { dbPath, store } = fixture();
		const state = store.initRun("partial-persisted", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		assert.ok(operation);
		const id = store.registerAgent({ runId: state.runId, name: "legacy", node: operation.node, role: "thinker", transport: "herdr", herdrAgent: "agent", tabId: "tab", herdrPaneId: "pane", currentTask: operation.task });
		store.close();
		const db = new Database(dbPath);
		assert.throws(() => db.query("UPDATE agents SET acp_agent='pi' WHERE id=?").run(id), /complete ACPX provenance/);
		db.exec("DROP TRIGGER agents_acpx_identity_insert; DROP TRIGGER agents_acpx_identity_update");
		db.query("UPDATE agents SET acp_agent='pi' WHERE id=?").run(id);
		db.exec("DELETE FROM schema_version WHERE version=4; INSERT OR REPLACE INTO schema_version(version) VALUES (3)");
		db.close();
		assert.throws(() => new GraphStore({ dbPath }), /inconsistent partial ACPX\/AgentFS identity/);
	});

	test("rejects partial or unsupported ACPX identity while preserving legacy registration", () => {
		const { store } = fixture();
		const state = store.initRun("acpx-v4-validation", "build", "Plan");
		const operation = store.next(state.runId).operations[0];
		assert.ok(operation);
		const base = { runId: state.runId, node: operation.node, role: "thinker", transport: "herdr" as const, herdrAgent: "agent", tabId: "tab", herdrPaneId: "pane", currentTask: operation.task };
		assert.throws(() => store.registerAgent({ ...base, name: "partial", acpAgent: "pi" }), /complete ACPX provenance/);
		assert.throws(() => store.registerAgent({ ...base, name: "unsupported", acpAgent: "gemini", acpxRecordId: "r", acpxSessionId: "s", acpxState: "alive", acpxAttemptKey: "a", agentFsSessionId: "fs", agentFsDbPath: "/tmp/fs/delta.db", herdrPaneId: "pane", acpxCancelScript: "/tmp/cancel.sh" }), /unsupported ACPX agent/);
		assert.doesNotThrow(() => store.registerAgent({ ...base, name: "legacy" }));
		store.close();
	});
});
