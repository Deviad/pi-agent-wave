import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { GraphStore } from "../store.ts";
import { Database } from "../sqlite.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { parseResultContract, canonical } from "../lib/runtime-results.ts";

const roots: string[] = [];
const stores: GraphStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(graph: "build" | "research" = "build", policy: "exact" | "chain" = "exact") {
	const root = mkdtempSync(join(tmpdir(), "runtime-results-"));
	roots.push(root);
	const store = new GraphStore({ dbPath: join(root, "graph.db"), random: () => 0.5 });
	stores.push(store);
	const run = store.initRun("runtime", graph, "Investigate or implement", policy === "exact" ? {
		input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "Pinned test input" },
		routes: [{ role: "thinker", tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }],
	} : {
		input: { kind: "auto" },
		routes: [{ role: "thinker", tier: "strong", chain: ["openai-codex/gpt-5.6-sol", "claude-code/claude-opus-5"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "tier", promoted: false, promotionReason: null }],
	}, undefined, "runtime-v1");
	const operation = store.next(run.runId).operations[0];
	const identity = createHeadlessAcpxAttemptIdentity({
		runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0,
		transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex",
	});
	const input = { identity, sessionId: "session-1", requestId: "request-1", policyDigest: store.policy(run.runId).digest };
	return { root, store, run, operation, input };
}

test("runtime-v1 is the only result contract and legacy-v1 is refused by name", () => {
	assert.equal(parseResultContract(undefined), "runtime-v1");
	assert.equal(parseResultContract("runtime-v1"), "runtime-v1");
	assert.throws(() => parseResultContract("legacy-v1"), /legacy-v1 was removed/);
	for (const value of [null, "runtime-v2", "", 1]) assert.throws(() => parseResultContract(value), /result contract/);
});

test("schema v10 carries no contract or report columns and reopens cleanly", () => {
	const { store, root } = fixture();
	const run = store.initRun("frozen", "build", "Existing task");
	const before = store.getRun(run.runId);
	assert.equal("result_contract" in before, false, "the contract column was removed at v10");
	assert.equal("report_path" in store.next(run.runId).operations[0], false, "the report path column was removed at v10");
	store.initRun("default-ops", "operations", "Default ops", undefined, [{ id: "one", name: "One", command: { executable: "node", args: ["search.mjs"], cwd: "/tmp" }, ownedPaths: ["/tmp/one.json"] }]);
	const other = new GraphStore({ dbPath: join(root, "graph.db") });
	stores.push(other);
	assert.deepEqual(other.getRun(run.runId), before);
	const db = new Database(store.dbPath);
	try {
		assert.deepEqual(db.query<{ name: string }>("PRAGMA table_info(runs)").all().map((column) => column.name).filter((name) => name === "result_contract"), []);
		assert.deepEqual(db.query<{ name: string }>("PRAGMA table_info(operations)").all().map((column) => column.name).filter((name) => name === "report_path"), []);
		assert.equal(db.query<{ version: number }>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 11);
	} finally { db.close(); }
});

for (const graph of ["build", "research"] as const) {
	test(`${graph}: duplicate registration and collection retain one candidate without advancing`, () => {
		const { store, root, run, operation, input } = fixture(graph);
		const first = store.beginRuntimeAttempt(input);
		assert.deepEqual(store.beginRuntimeAttempt(input), first);
		const content = store.retainRuntimeContent(Buffer.from("Authored finding or explanation"));
		const candidate = graph === "build"
			? { kind: "coding" as const, answer: content, artifacts: [content], baseRevision: "base-1" }
			: { kind: "research" as const, answer: content, sources: [content] };
		const settlement = { attemptKey: input.identity.attemptKey, outcome: { kind: "exited" as const, exitCode: 0 }, candidate };
		const result = store.settleRuntimeAttempt(settlement);
		assert.equal(result.processState, "exited");
		assert.equal(result.cleanup, "pending");
		assert.equal(result.acceptance, "pending");
		assert.equal(result.candidate?.kind, candidate.kind);
		assert.equal(store.getState(run.runId).currentNode, operation.node);
		assert.notEqual(store.getOperation(operation.id).status, "completed");
		const events = store.events(run.runId).length;
		const reopened = new GraphStore({ dbPath: join(root, "graph.db") }); stores.push(reopened);
		assert.deepEqual(reopened.settleRuntimeAttempt(settlement), result);
		assert.equal(reopened.events(run.runId).length, events);
		assert.equal(reopened.next(run.runId).operations[0].runtimeAttempt?.processState, "exited");
		assert.throws(() => reopened.record({ runId: run.runId, operationId: operation.id, status: "completed" as never }), /unsupported record status completed/);
		assert.throws(() => reopened.record({ runId: run.runId, operationId: operation.id, status: "running" as never }), /unsupported record status running/);
		assert.throws(() => reopened.resolveExhaustion(run.runId, operation.id, "retry" as never), /retryRuntimeAttempt/);
		assert.throws(() => reopened.settleRuntimeAttempt({ ...settlement, outcome: { kind: "failed", exitCode: 1, error: "conflicting late result" } }), /conflicting.*settlement/);
	});
}

test("attempt identity and policy mismatches fail before an operation starts", () => {
	const { store, run, operation, input } = fixture();
	assert.throws(() => store.beginRuntimeAttempt({ ...input, policyDigest: "wrong" }), /policy digest/);
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity: { ...input.identity, attemptKey: "wrong" } }), /attempt identity/);
	const wrongAgent = createHeadlessAcpxAttemptIdentity({ ...input.identity, agent: "pi" });
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity: wrongAgent }), /agent.*model/);
	const wrongModel = createHeadlessAcpxAttemptIdentity({ ...input.identity, selectedModel: "openai-codex/other" });
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity: wrongModel }), /frozen policy|exact lock/);
	assert.equal(store.getOperation(operation.id).status, "pending");
	store.beginRuntimeAttempt(input);
	assert.throws(() => store.beginRuntimeAttempt({ ...input, requestId: "other-request" }), /conflicting.*identity/);
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity: { ...input.identity, runId: "another-run" } }), /attempt identity|unknown run/);
	assert.equal(store.policy(run.runId).digest, input.policyDigest);
});

test("cancellation retains late process failure but never reopens the graph", () => {
	const { store, run, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	store.record({ runId: run.runId, operationId: input.identity.operationId, status: "cancelled" });
	const settled = store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "cancelled", signal: "SIGTERM" } });
	assert.equal(settled.processState, "cancelled");
	assert.equal(settled.acceptance, "unavailable");
	assert.equal(store.getState(run.runId).status, "cancelled");
	assert.throws(() => store.beginRuntimeAttempt(input), /cancelled/);
});

test("missing, modified, public or symlink content cannot commit candidate settlement", () => {
	const { store, input, root } = fixture();
	store.beginRuntimeAttempt(input);
	const content = store.retainRuntimeContent(Buffer.from("candidate"));
	const path = store.runtimeContentPath(content);
	const settlement = { attemptKey: input.identity.attemptKey, outcome: { kind: "exited" as const, exitCode: 0 }, candidate: { kind: "research" as const, answer: content, sources: [] } };
	writeFileSync(path, "tampered");
	assert.throws(() => store.settleRuntimeAttempt(settlement), /content.*digest/);
	assert.equal(store.runtimeAttempt(input.identity.attemptKey).processState, "running");
	writeFileSync(path, "candidate"); chmodSync(path, 0o644);
	assert.throws(() => store.settleRuntimeAttempt(settlement), /private/);
	rmSync(path);
	const outside = join(root, "outside"); writeFileSync(outside, "candidate", { mode: 0o600 }); symlinkSync(outside, path);
	assert.throws(() => store.settleRuntimeAttempt(settlement), /regular|symbolic|symlink/);
	rmSync(path);
	assert.throws(() => store.settleRuntimeAttempt(settlement), /ENOENT/);
	assert.equal(store.runtimeAttempt(input.identity.attemptKey).processState, "running");
});

test("essential SQLite failure rolls back outcome and event, preserving retained content for retry", () => {
	const { store, input } = fixture("research"); store.beginRuntimeAttempt(input);
	const content = store.retainRuntimeContent(Buffer.from("retained finding"));
	const settlement = { attemptKey: input.identity.attemptKey, outcome: { kind: "failed" as const, exitCode: 1, error: "provider failure" }, candidate: { kind: "research" as const, answer: content, sources: [] } };
	const before = store.events(input.identity.runId).length;
	const db = new Database(store.dbPath);
	try {
		db.exec("CREATE TRIGGER fail_result_event BEFORE INSERT ON events WHEN NEW.type='runtime_attempt_settled' BEGIN SELECT RAISE(ABORT, 'essential storage unavailable'); END");
		assert.throws(() => store.settleRuntimeAttempt(settlement), /essential storage/);
		assert.equal(store.runtimeAttempt(input.identity.attemptKey).processState, "running");
		assert.equal(store.events(input.identity.runId).length, before);
		db.exec("DROP TRIGGER fail_result_event");
		assert.equal(store.settleRuntimeAttempt(settlement).processState, "failed");
	} finally { db.close(); }
});

test("two collecting processes commit exactly one settlement and event", async () => {
	const { store, input } = fixture("research"); store.beginRuntimeAttempt(input);
	const content = store.retainRuntimeContent(Buffer.from("Retained concurrent finding"));
	const settlement = { attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer: content, sources: [] } };
	const source = `import { GraphStore } from ${JSON.stringify(new URL("../store.ts", import.meta.url).href)};
const store = new GraphStore({ dbPath: process.argv[1] });
try { process.stdout.write(JSON.stringify(store.settleRuntimeAttempt(JSON.parse(process.argv[2])))); } finally { store.close(); }`;
	const collect = () => new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, store.dbPath, JSON.stringify(settlement)], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
	});
	const results = await Promise.all([collect(), collect()]);
	assert.deepEqual(JSON.parse(results[0]), JSON.parse(results[1]));
	assert.equal(store.events(input.identity.runId).filter((event) => event.type === "runtime_attempt_settled").length, 1);
});

test("no adapter enablement gate exists: the store carries no runtime_adapters table and no enablement API", () => {
	const { store } = fixture();
	assert.equal((store as unknown as Record<string, unknown>).enableRuntimeAdapter, undefined);
	assert.equal((store as unknown as Record<string, unknown>).assertRuntimeAdaptersAvailable, undefined);
	const db = new Database(store.dbPath);
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_adapters'").all();
		assert.deepEqual(tables, [], "schema v11 drops the enablement table");
		assert.equal(db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 11);
	} finally { db.close(); }
});

test("registration binds the worker agent and the request id arrives with the observed settlement", () => {
	const { store, run, operation, input } = fixture("research");
	const agentId = store.registerAgent({ runId: run.runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", acpAgent: "codex", acpxRecordId: "s", acpxSessionId: "s", acpxState: "alive", acpxAttemptKey: input.identity.attemptKey, agentFsSessionId: "s", agentFsDbPath: "/tmp/s/delta.db", acpxCancelScript: "/tmp/s/cancel.sh", policyDigest: input.policyDigest, selectedModel: "openai-codex/gpt-5.6-sol", modelAttempt: 0, currentTask: operation.task });
	const begun = store.beginRuntimeAttempt({ ...input, requestId: null, agentId });
	assert.equal(begun.agentId, agentId);
	assert.equal(store.getOperation(operation.id).agent_id, agentId);
	assert.deepEqual(store.beginRuntimeAttempt({ ...input, requestId: null, agentId }), begun);
	assert.throws(() => store.beginRuntimeAttempt({ ...input, requestId: "late", agentId }), /conflicting/);
	const answer = store.retainRuntimeContent(Buffer.from("Finding"));
	const observation = { sessionId: "acp-fresh", requestId: "3", sessionOrigin: "created" as const, captureStatus: "complete" as const, manifest: null };
	const settled = store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation });
	assert.deepEqual(settled.observation, observation);
	assert.deepEqual(store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation }), settled);
	assert.throws(() => store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { ...observation, requestId: "9" } }), /conflicting/);
});

test("explicit research acceptance completes the operation and advances the graph exactly once", () => {
	const { store, run, operation, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "reviewed" }), /settled/);
	const answer = store.retainRuntimeContent(Buffer.from("Synthesis with sources"));
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [answer] } });
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: " " }), /reason/);
	const before = store.getState(run.runId);
	const decided = store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "independent review: sources support every claim", payload: { slices: [{ id: "s1", name: "s1", task: "Search one", ownedPaths: [] }] } });
	assert.equal(decided.attempt.acceptance, "accepted");
	assert.equal(decided.attempt.decision?.reason, "independent review: sources support every claim");
	assert.equal(store.getOperation(operation.id).status, "completed");
	const after = store.getState(run.runId);
	assert.notDeepEqual([after.currentNode, after.round, after.fixIteration], [before.currentNode, before.round, before.fixIteration]);
	assert.ok(store.next(run.runId).operations.length >= 1);
	const events = store.events(run.runId, 100).filter((event) => event.type === "handoff" || event.type === "runtime_candidate_decided");
	assert.equal(events.filter((event) => event.type === "handoff").length, 1);
	assert.equal(events.filter((event) => event.type === "runtime_candidate_decided").length, 1);
	assert.deepEqual(store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "independent review: sources support every claim" }), decided);
	assert.equal(store.events(run.runId, 100).filter((event) => event.type === "handoff").length, 1);
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "rejected", reason: "changed mind" }), /conflicting/);
});

test("coding acceptance requires an applied integration when the candidate carries file changes", () => {
	const { store, run, operation, input } = fixture("build");
	store.beginRuntimeAttempt(input);
	const file = store.retainRuntimeContent(Buffer.from("after"));
	const manifestOf = (changes: unknown[]) => store.retainRuntimeContent(Buffer.from(canonical({ version: 1, attemptKey: input.identity.attemptKey, workspace: "/tmp/workspace", baseRevision: "base-1", snapshotDigest: "a".repeat(64), ownedPaths: ["note.txt"], changes, readOnly: false })));
	const changed = manifestOf([{ path: "note.txt", after: file, mode: 0o644 }]);
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "coding", answer: null, artifacts: [changed, file], baseRevision: "base-1" }, observation: { sessionId: "s", requestId: "1", sessionOrigin: "expected", captureStatus: "empty", manifest: changed } });
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "checks passed" }), /integration/);
	assert.equal(store.getOperation(operation.id).status, "running");
	const rejected = store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "rejected", reason: "review found a defect" });
	assert.equal(rejected.attempt.acceptance, "rejected");
	assert.equal(rejected.attempt.candidate?.kind, "coding");
	assert.equal(store.getOperation(operation.id).status, "failed");
	assert.equal(store.getState(run.runId).status, "awaiting_user");
	assert.ok(store.events(run.runId, 100).some((event) => event.type === "runtime_candidate_decided"));
});

test("a coding candidate without file changes is accepted without an integration", () => {
	const { store, operation, input } = fixture("build");
	store.beginRuntimeAttempt(input);
	const answer = store.retainRuntimeContent(Buffer.from("Plan: slices"));
	const manifest = store.retainRuntimeContent(Buffer.from(canonical({ version: 1, attemptKey: input.identity.attemptKey, workspace: "/tmp/workspace", baseRevision: "base-1", snapshotDigest: "a".repeat(64), ownedPaths: [], changes: [], readOnly: false })));
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "coding", answer, artifacts: [manifest], baseRevision: "base-1" }, observation: { sessionId: "s", requestId: "1", sessionOrigin: "loaded", captureStatus: "complete", manifest } });
	const decided = store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "plan reviewed", payload: { slices: [{ id: "s1", name: "s1", task: "Implement", ownedPaths: ["src"] }] } });
	assert.equal(decided.attempt.acceptance, "accepted");
	assert.equal(store.getOperation(operation.id).status, "completed");
});

function failedSettlement(attemptKey: string, error: string) {
	return { attemptKey, outcome: { kind: "failed" as const, exitCode: 1, error } };
}

test("a transient failure replaces the attempt under the same model and fences registration to the next frozen identity", () => {
	const { store, root, run, operation, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }), /still running/);
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id, error: "caller text" }), /still running/);
	store.settleRuntimeAttempt(failedSettlement(input.identity.attemptKey, "ACPX worker failed while prompting"));
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id, error: "caller text" }), /recorded outcome/);
	const retried = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	assert.equal(retried.exhausted, false);
	assert.equal(retried.classification, "worker-runtime-failure");
	assert.deepEqual([retried.retry?.attempt, retried.retry?.modelAttempt, retried.retry?.selectedModel], [1, 0, "openai-codex/gpt-5.6-sol"]);
	assert.equal(retried.operation.status, "pending");
	assert.equal(retried.operation.transient_attempts, 1);
	assert.equal(retried.operation.agent_id, null);
	assert.ok(retried.operation.retry_not_before);
	assert.equal(retried.state.status, "active");
	assert.ok(retried.previousAttempt?.supersededAt);
	assert.equal(store.runtimeAttemptByOperation(operation.id), undefined);
	assert.equal(store.next(run.runId).operations[0].runtimeAttempt, undefined);
	// The superseded row stays readable and immutable; the old identity can no longer register.
	assert.equal(store.runtimeAttempt(input.identity.attemptKey).processState, "failed");
	assert.throws(() => store.beginRuntimeAttempt(input), /conflicts with operation/);
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }), /launch failure text/);
	const next = createHeadlessAcpxAttemptIdentity({ ...input.identity, transientAttempt: 1 });
	assert.notEqual(next.attemptKey, input.identity.attemptKey);
	assert.notEqual(next.sessionName, input.identity.sessionName);
	const replacement = store.beginRuntimeAttempt({ ...input, identity: next, sessionId: next.sessionName });
	assert.equal(replacement.supersededAt, null);
	assert.equal(store.runtimeAttemptByOperation(operation.id)?.attemptKey, next.attemptKey);
	assert.equal(store.getOperation(operation.id).status, "running");
	const types = store.events(run.runId, 100).map((event) => event.type);
	assert.ok(types.includes("runtime_attempt_superseded") && types.includes("retry"));
	// Replaying the superseded settlement after reopening is idempotent and cannot reopen the fence.
	const reopened = new GraphStore({ dbPath: join(root, "graph.db") }); stores.push(reopened);
	assert.equal(reopened.settleRuntimeAttempt(failedSettlement(input.identity.attemptKey, "ACPX worker failed while prompting")).supersededAt, retried.previousAttempt?.supersededAt);
	assert.equal(reopened.runtimeAttemptByOperation(operation.id)?.attemptKey, next.attemptKey);
	assert.throws(() => reopened.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "stale" }), /superseded/);
});

test("the same-model budget is three, then the frozen chain advances once, then the run parks", () => {
	const { store, run, operation, input } = fixture("research", "chain");
	let identity = input.identity;
	for (let transient = 0; transient < 3; transient += 1) {
		store.beginRuntimeAttempt({ ...input, identity, sessionId: identity.sessionName });
		store.settleRuntimeAttempt(failedSettlement(identity.attemptKey, "HTTP 503 overloaded"));
		const retried = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
		assert.deepEqual([retried.retry?.modelAttempt, retried.retry?.attempt], [0, transient + 1]);
		identity = createHeadlessAcpxAttemptIdentity({ ...identity, transientAttempt: transient + 1 });
	}
	store.beginRuntimeAttempt({ ...input, identity, sessionId: identity.sessionName });
	store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "interrupted", reason: "connection reset by provider" } });
	const fallback = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	assert.deepEqual([fallback.retry?.modelAttempt, fallback.retry?.attempt, fallback.retry?.selectedModel], [1, 0, "claude-code/claude-opus-5"]);
	assert.equal(fallback.operation.fallback_reason, "connection-reset");
	assert.ok(store.events(run.runId, 100).some((event) => event.type === "model_fallback"));
	const onClaude = createHeadlessAcpxAttemptIdentity({ ...identity, modelAttempt: 1, transientAttempt: 0, selectedModel: "claude-code/claude-opus-5", agent: "claude" });
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity, sessionId: identity.sessionName }), /conflicts with operation|frozen policy/);
	store.beginRuntimeAttempt({ ...input, identity: onClaude, sessionId: onClaude.sessionName });
	for (let transient = 0; transient < 3; transient += 1) {
		const current = createHeadlessAcpxAttemptIdentity({ ...onClaude, transientAttempt: transient });
		if (transient > 0) store.beginRuntimeAttempt({ ...input, identity: current, sessionId: current.sessionName });
		store.settleRuntimeAttempt(failedSettlement(current.attemptKey, "429 rate limit"));
		assert.equal(store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }).exhausted, false);
	}
	const last = createHeadlessAcpxAttemptIdentity({ ...onClaude, transientAttempt: 3 });
	store.beginRuntimeAttempt({ ...input, identity: last, sessionId: last.sessionName });
	store.settleRuntimeAttempt(failedSettlement(last.attemptKey, "429 rate limit"));
	const exhausted = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	assert.equal(exhausted.exhausted, true);
	assert.equal(exhausted.retry, null);
	assert.equal(exhausted.operation.status, "failed");
	assert.equal(exhausted.state.status, "awaiting_user");
	assert.equal(store.runtimeAttemptByOperation(operation.id)?.attemptKey, last.attemptKey, "the exhausted attempt stays active for the operator");
	assert.ok(store.events(run.runId, 200).some((event) => event.type === "retry_exhausted"));
	// Operator-approved retry keeps the model attempt, resets the budget and supersedes the exhausted attempt.
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }), /is awaiting_user/);
	const approved = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id, approved: true });
	assert.deepEqual([approved.retry?.modelAttempt, approved.retry?.attempt, approved.operation.transient_attempts, approved.operation.status, approved.state.status], [1, 4, 4, "pending", "active"]);
	assert.ok(approved.previousAttempt?.supersededAt);
	assert.equal(approved.operation.retry_reason, "operator-approved-retry");
	// A fresh key: the counter advanced past every superseded identity instead of reusing attempt zero.
	assert.throws(() => store.beginRuntimeAttempt({ ...input, identity: onClaude, sessionId: onClaude.sessionName }), /conflicts with operation/);
	const fresh = createHeadlessAcpxAttemptIdentity({ ...onClaude, transientAttempt: 4 });
	assert.equal(store.beginRuntimeAttempt({ ...input, identity: fresh, sessionId: fresh.sessionName }).attemptKey, fresh.attemptKey);
});

test("an exact lock never falls back, a permanent failure parks immediately, and an exited attempt must be decided", () => {
	const { store, run, operation, input } = fixture("research");
	let identity = input.identity;
	for (let transient = 0; transient < 3; transient += 1) {
		store.beginRuntimeAttempt({ ...input, identity, sessionId: identity.sessionName });
		store.settleRuntimeAttempt(failedSettlement(identity.attemptKey, "502 bad gateway"));
		store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
		identity = createHeadlessAcpxAttemptIdentity({ ...identity, transientAttempt: transient + 1 });
	}
	store.beginRuntimeAttempt({ ...input, identity, sessionId: identity.sessionName });
	store.settleRuntimeAttempt(failedSettlement(identity.attemptKey, "502 bad gateway"));
	const exhausted = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	assert.deepEqual([exhausted.exhausted, exhausted.operation.model_attempt, exhausted.state.status], [true, 0, "awaiting_user"]);

	const permanent = fixture("research");
	permanent.store.beginRuntimeAttempt(permanent.input);
	permanent.store.settleRuntimeAttempt(failedSettlement(permanent.input.identity.attemptKey, "permission denied for fs/read_text_file"));
	const parked = permanent.store.retryRuntimeAttempt({ runId: permanent.run.runId, operationId: permanent.operation.id });
	assert.deepEqual([parked.exhausted, parked.classification, parked.operation.transient_attempts, parked.state.status], [true, "approval-block", 0, "awaiting_user"]);
	assert.ok(permanent.store.events(permanent.run.runId, 100).some((event) => event.type === "operation_failed"));

	const exited = fixture("research");
	exited.store.beginRuntimeAttempt(exited.input);
	const answer = exited.store.retainRuntimeContent(Buffer.from("Answer"));
	exited.store.settleRuntimeAttempt({ attemptKey: exited.input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] } });
	assert.throws(() => exited.store.retryRuntimeAttempt({ runId: exited.run.runId, operationId: exited.operation.id }), /with a candidate must be decided/);
	exited.store.decideRuntimeCandidate({ attemptKey: exited.input.identity.attemptKey, decision: "rejected", reason: "review found the synthesis unsupported" });
	assert.throws(() => exited.store.retryRuntimeAttempt({ runId: exited.run.runId, operationId: exited.operation.id }), /is awaiting_user/);
	const afterRejection = exited.store.retryRuntimeAttempt({ runId: exited.run.runId, operationId: exited.operation.id, approved: true, retryReason: "operator asked for a corrected synthesis" });
	assert.deepEqual([afterRejection.operation.status, afterRejection.state.status, afterRejection.previousAttempt?.acceptance], ["pending", "active", "rejected"]);
	assert.ok(afterRejection.previousAttempt?.supersededAt);
	assert.equal(exited.store.runtimeAttempt(exited.input.identity.attemptKey).decision?.decision, "rejected");
});

test("a launch failure with no registered attempt spends the same budget without superseding anything", () => {
	const { store, run, operation, input } = fixture("research");
	assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }), /launch failure text/);
	const failure = { runId: run.runId, operationId: operation.id, error: "worker preflight: no usable credential for openai-codex" };
	assert.throws(() => store.retryRuntimeAttempt(failure), /launched modelAttempt and transientAttempt/);
	assert.throws(() => store.retryRuntimeAttempt({ ...failure, launched: { modelAttempt: 0, transientAttempt: 1 } }), /stale launch failure/);
	const first = store.retryRuntimeAttempt({ ...failure, launched: { modelAttempt: 0, transientAttempt: 0 } });
	assert.deepEqual([first.previousAttempt, first.classification, first.operation.transient_attempts, first.operation.status], [null, "worker-credential-preflight", 1, "pending"]);
	// Replaying the same launch failure cannot spend the budget twice: the fence now points at transient attempt 1.
	assert.throws(() => store.retryRuntimeAttempt({ ...failure, launched: { modelAttempt: 0, transientAttempt: 0 } }), /stale launch failure/);
	assert.equal(store.getOperation(operation.id).transient_attempts, 1);
	assert.throws(() => store.beginRuntimeAttempt(input), /conflicts with operation/);
	const next = createHeadlessAcpxAttemptIdentity({ ...input.identity, transientAttempt: 1 });
	store.beginRuntimeAttempt({ ...input, identity: next, sessionId: next.sessionName });
	const never = store.retryRuntimeAttempt.bind(store);
	assert.throws(() => never({ runId: run.runId, operationId: operation.id, error: "late text" }), /still running/);
});

test("runtime runs share defer, abort and escalate and expose a derived ledger that decides nothing", () => {
	for (const decision of ["defer", "abort", "escalate"] as const) {
		const { store, run, operation, input } = fixture("research");
		store.beginRuntimeAttempt(input);
		store.settleRuntimeAttempt(failedSettlement(input.identity.attemptKey, "permission denied for fs/read_text_file"));
		assert.equal(store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }).state.status, "awaiting_user");
		assert.throws(() => store.resolveExhaustion(run.runId, operation.id, "retry"), /retryRuntimeAttempt/);
		const state = store.resolveExhaustion(run.runId, operation.id, decision, decision === "defer" ? "2030-01-01T00:00:00.000Z" : undefined);
		assert.equal(state.status, { defer: "deferred", abort: "cancelled", escalate: "blocked" }[decision]);
		assert.equal(store.runtimeAttempt(input.identity.attemptKey).supersededAt, null);
		if (decision === "defer") {
			const resumed = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id, approved: true });
			assert.deepEqual([resumed.state.status, resumed.operation.status], ["active", "pending"]);
		}
		const ledger = store.runtimeLedger(run.runId);
		assert.equal(ledger.derived, true);
		assert.equal(ledger.operations.find((item) => item.operationId === operation.id)?.attempts[0]?.attemptKey, input.identity.attemptKey);
		assert.equal(ledger.operations.find((item) => item.operationId === operation.id)?.attempts[0]?.processState, "failed");
		assert.ok(ledger.events.some((event) => event.type === "operation_failed"));
		assert.deepEqual(store.getState(run.runId), decision === "defer" ? store.getState(run.runId) : state, "the ledger read changed nothing");
	}
});

test("the schema itself refuses writes to superseded attempts and decisions against them", () => {
	const { store, run, operation, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	const answer = store.retainRuntimeContent(Buffer.from("partial"));
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "503 overloaded" }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "s", requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	const candidateId = store.runtimeAttempt(input.identity.attemptKey).candidateId;
	assert.ok(candidateId);
	store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	const db = new Database(store.dbPath);
	try {
		assert.throws(() => db.query("UPDATE runtime_attempts SET observation_json=NULL WHERE attempt_key=?").run(input.identity.attemptKey), /immutable/);
		assert.throws(() => db.query("UPDATE runtime_attempts SET agent_id=NULL WHERE attempt_key=?").run(input.identity.attemptKey), /immutable/);
		assert.throws(() => db.query("UPDATE runtime_attempts SET superseded_at=NULL WHERE attempt_key=?").run(input.identity.attemptKey), /immutable/);
		assert.throws(() => db.query("INSERT INTO runtime_decisions(attempt_key,candidate_id,decision,verdict,reason,integration_id,payload_json,decided_at) VALUES (?,?,'accepted',NULL,'stale',NULL,NULL,'now')").run(input.identity.attemptKey, candidateId), /active settled candidate/);
		assert.equal(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_decisions").get()?.n, 0);
	} finally { db.close(); }
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "stale" }), /superseded/);
});

test("v7 databases with settled attempts and decisions migrate to v8 with rows and decisions intact", () => {
	const { store, root, run, operation, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	const answer = store.retainRuntimeContent(Buffer.from("Finding"));
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] } });
	store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "reviewed", payload: { slices: [{ id: "s1", name: "s1", task: "Search", ownedPaths: [] }] } });
	store.close(); stores.splice(stores.indexOf(store), 1);
	const db = new Database(join(root, "graph.db"));
	const before = db.query<Record<string, unknown>, []>("SELECT attempt_key,run_id,operation_id,identity_json,outcome_json,candidate_json,candidate_id,started_at,finished_at,observation_json,agent_id FROM runtime_attempts").all();
	const decisions = db.query<Record<string, unknown>, []>("SELECT * FROM runtime_decisions").all();
	db.exec("PRAGMA foreign_keys=OFF");
	db.exec(`
		DROP TRIGGER runtime_decisions_candidate;
		CREATE TABLE runtime_attempts_v7 (
			attempt_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
			identity_json TEXT NOT NULL, outcome_json TEXT, candidate_json TEXT, candidate_id TEXT UNIQUE, started_at TEXT NOT NULL, finished_at TEXT, observation_json TEXT, agent_id TEXT REFERENCES agents(id));
		INSERT INTO runtime_attempts_v7 SELECT attempt_key,run_id,operation_id,identity_json,outcome_json,candidate_json,candidate_id,started_at,finished_at,observation_json,agent_id FROM runtime_attempts;
		DROP TABLE runtime_attempts; ALTER TABLE runtime_attempts_v7 RENAME TO runtime_attempts;
		DELETE FROM schema_version; INSERT INTO schema_version(version) VALUES (7);`);
	db.close();
	const migrated = new GraphStore({ dbPath: join(root, "graph.db") }); stores.push(migrated);
	const check = new Database(join(root, "graph.db"), { readonly: true });
	try {
		assert.equal(check.query<{ version: number }>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 11);
		assert.deepEqual(check.query<Record<string, unknown>, []>("SELECT attempt_key,run_id,operation_id,identity_json,outcome_json,candidate_json,candidate_id,started_at,finished_at,observation_json,agent_id FROM runtime_attempts").all(), before);
		assert.deepEqual(check.query<Record<string, unknown>, []>("SELECT * FROM runtime_decisions").all(), decisions);
		assert.equal(check.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='runtime_attempts_active'").get()?.n, 1);
	} finally { check.close(); }
	assert.equal(migrated.runtimeAttempt(input.identity.attemptKey).acceptance, "accepted");
	assert.equal(migrated.runtimeAttempt(input.identity.attemptKey).supersededAt, null);
	assert.equal(migrated.getOperation(operation.id).status, "completed");
	assert.notEqual(migrated.getState(run.runId).currentNode, operation.node);
});

test("an exited attempt with no candidate is a transient empty-answer failure that spends the same-model budget", () => {
	const { store, run, operation, input } = fixture("research");
	store.beginRuntimeAttempt(input);
	store.settleRuntimeAttempt({ attemptKey: input.identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, observation: { sessionId: "acp-1", requestId: "3", sessionOrigin: "loaded", captureStatus: "incomplete", manifest: null } });
	assert.equal(store.runtimeAttempt(input.identity.attemptKey).acceptance, "unavailable");
	assert.throws(() => store.decideRuntimeCandidate({ attemptKey: input.identity.attemptKey, decision: "accepted", reason: "nothing to accept" }), /requires a settled candidate/);
	const retried = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
	assert.deepEqual([retried.classification, retried.exhausted, retried.operation.transient_attempts, retried.operation.status, retried.state.status], ["worker-empty-answer", false, 1, "pending", "active"]);
	assert.match(retried.operation.last_error ?? "", /exited without a candidate \(capture incomplete\)/);
	assert.ok(store.runtimeAttempt(input.identity.attemptKey).supersededAt);
});
