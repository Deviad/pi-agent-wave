import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore, roleForNode } from "../store.ts";
import type { OperationalCommandSpec, ResolvedPolicy } from "../types.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";

const MODEL = "openai-codex/gpt-5.6-sol";
const policy = { input: { kind: "model", model: MODEL, reason: "test" }, routes: ["searcher", "thinker", "auditor"].map((role) => ({ role, tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null })) } as unknown as ResolvedPolicy;

/** Registers, settles and accepts a runtime attempt for a pending operation, the way dispatch, collect and decide do. */
function runOperation(store: GraphStore, runId: string, operationId: string, verdict: string): void {
	const next = store.next(runId);
	const operation = next.operations.find((candidate) => candidate.id === operationId);
	if (!operation) throw new Error(`operation ${operationId} is not pending`);
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: roleForNode(operation.node), modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel: MODEL, agent: selectAcpAgent(MODEL) });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: next.policy.digest });
	const answer = store.retainRuntimeContent(Buffer.from(`answer\n\nVERDICT: ${verdict}\n`));
	store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: identity.sessionName, requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "test", verdict });
}

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
		const state = store.initRun("join", "operations", "Run", policy, [command("linkedin", ["/tmp/linkedin.json"]), command("indeed", ["/tmp/indeed.json"])]);
		const sources = store.next(state.runId).operations;
		runOperation(store, state.runId, sources[0]!.id, "DONE");
		assert.equal(store.getState(state.runId).currentNode, "source_search");
		runOperation(store, state.runId, sources[1]!.id, "DONE");
		assert.equal(store.getState(state.runId).currentNode, "thinker_synthesize");
		const synthesis = store.next(state.runId).operations[0]!;
		runOperation(store, state.runId, synthesis.id, "DONE");
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
		assert.equal(store.initRun("build", "build", "Plan", undefined, undefined).currentNode, "thinker_plan");
		assert.equal(store.initRun("research", "research", "Research", undefined, undefined).currentNode, "thinker_split");
		store.close();
	});
});
