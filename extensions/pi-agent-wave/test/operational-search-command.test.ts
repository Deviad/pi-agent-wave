import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import type { OperationalCommandSpec } from "../types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): GraphStore {
	const dir = mkdtempSync(join(tmpdir(), "operational-command-"));
	dirs.push(dir);
	return new GraphStore({ dbPath: join(dir, "graph.db") });
}

function command(id: string, ownedPaths: string[]): OperationalCommandSpec {
	return {
		id,
		name: `Source ${id}`,
		command: { executable: "node", args: ["/opt/search.mjs", "--source", id], cwd: "/work" },
		ownedPaths,
	};
}

describe("operational command persistence", () => {
	test("initializes one writable operation per structured command", () => {
		const store = fixture();
		const input = [command("linkedin", ["/tmp/linkedin-results.json"]), command("indeed", ["/tmp/indeed-results.json"])];
		const state = store.initRun("source sweep", "operations", "Run exact sources", undefined, input);
		const operations = store.next(state.runId).operations;
		assert.equal(operations.length, 2);
		assert.equal(operations.every((operation) => operation.node === "source_search" && operation.read_only === 0), true);
		const linkedin = operations.find((operation) => operation.slice_id === "linkedin");
		assert.deepEqual(JSON.parse(linkedin!.command_json!), input[0]!.command);
		assert.deepEqual(JSON.parse(linkedin!.owned_paths_json), input[0]!.ownedPaths);
		store.close();
	});

	test("rejects missing commands and overlapping writable ownership", () => {
		const store = fixture();
		assert.throws(() => store.initRun("missing", "operations", "Run", undefined, []), /at least one structured command/);
		assert.throws(
			() => store.initRun("overlap", "operations", "Run", undefined, [command("linkedin", ["/tmp/shared.sqlite"]), command("indeed", ["/tmp/shared.sqlite"])]),
			/owned by both/,
		);
		store.close();
	});

	test("joins every source before creating synthesis and audit operations", () => {
		const store = fixture();
		const state = store.initRun("join", "operations", "Run", undefined, [command("linkedin", ["/tmp/linkedin.json"]), command("indeed", ["/tmp/indeed.json"])]);
		const sources = store.next(state.runId).operations;
		for (const source of sources) store.record({ runId: state.runId, operationId: source.id, status: "running", transport: "herdr" });
		store.record({ runId: state.runId, operationId: sources[0]!.id, status: "completed", verdict: "DONE", reportPath: "/tmp/report-one.json" });
		assert.equal(store.getState(state.runId).currentNode, "source_search");
		store.record({ runId: state.runId, operationId: sources[1]!.id, status: "completed", verdict: "DONE", reportPath: "/tmp/report-two.json" });
		assert.equal(store.getState(state.runId).currentNode, "thinker_synthesize");
		const synthesis = store.next(state.runId).operations[0]!;
		store.record({ runId: state.runId, operationId: synthesis.id, status: "running", transport: "herdr" });
		store.record({ runId: state.runId, operationId: synthesis.id, status: "completed", verdict: "DONE", reportPath: "/tmp/synthesis.json" });
		assert.equal(store.getState(state.runId).currentNode, "audit");
		store.close();
	});

	test("rejects physical ownership overlap through a symlinked parent", () => {
		const dir = mkdtempSync(join(tmpdir(), "operational-symlink-"));
		dirs.push(dir);
		const physical = join(dir, "physical");
		mkdirSync(physical);
		const alias = join(dir, "alias");
		symlinkSync(physical, alias);
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		assert.throws(() => store.initRun("symlink-overlap", "operations", "Run", undefined, [command("one", [join(physical, "shared.sqlite")]), command("two", [join(alias, "shared.sqlite")])]), /owned by both/);
		store.close();
	});

	test("preserves existing build and research initialization", () => {
		const store = fixture();
		assert.equal(store.initRun("build", "build", "Plan").currentNode, "thinker_plan");
		assert.equal(store.initRun("research", "research", "Research").currentNode, "thinker_split");
		store.close();
	});
});
