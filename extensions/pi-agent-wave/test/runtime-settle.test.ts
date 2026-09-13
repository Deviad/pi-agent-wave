import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { parseRuntimeSettleConfig, settleRuntimeWorker } from "../scripts/runtime-settle.ts";

const script = new URL("../scripts/runtime-settle.ts", import.meta.url).pathname;

function workerResult(root: string, attemptKey: string, answer: string, captureStatus: "complete" | "incomplete" | "empty", outcome: unknown = { kind: "exited", exitCode: 0 }): string {
	const outputDir = join(root, "runtime-output"); mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(outputDir, "public-answer.txt"), answer, { mode: 0o600 });
	writeFileSync(join(outputDir, "report.json"), "{not a report", { mode: 0o600 });
	const path = join(root, "worker-result.json");
	writeFileSync(path, JSON.stringify({ schemaVersion: 2, resultContract: "runtime-v1", agent: "codex", selectedModel: "openai-codex/gpt-5.6-sol", sessionName: "dg-session", attemptKey, outputDir, output: { schemaVersion: 1, attemptKey, sessionId: "dg-session", outcome, capture: { requestId: "3", sessionId: "acp-fresh", sessionOrigin: "created", captureStatus, responseCompleteness: "unverified", inputBytes: 10, answerBytes: answer.length, publicChunks: 1, ignoredEvents: 0, peakBufferedBytes: 10, diagnostics: captureStatus === "complete" ? [] : ["missing-completion"] }, stderrTruncated: false } }), { mode: 0o600 });
	return path;
}

test("research settlement retains the public answer as an unaccepted candidate and never reads a report", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-settle-research-"));
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	try {
		const run = store.initRun("settle", "research", "Investigate", { input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "test" }, routes: [{ role: "thinker", tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }] }, undefined, "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-session", requestId: null, policyDigest: store.policy(run.runId).digest });
		const configPath = join(root, "settle.json");
		const evidencePath = join(root, "runtime-settlement.json");
		writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(root, identity.attemptKey, "Finding: the answer", "complete"), kind: "research", baseDir: root, baseRevision: "none", ownedPaths: [], readOnly: true, snapshotPath: null, agentFsExecutable: "agentfs", evidencePath, dbPath: store.dbPath }));
		const settled = spawnSync(process.execPath, ["--experimental-strip-types", script], { env: { ...process.env, PI_RUNTIME_SETTLE_CONFIG: configPath }, encoding: "utf8" });
		assert.equal(settled.status, 0, settled.stderr);
		assert.equal(JSON.parse(settled.stdout).candidate, "research");
		const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
		assert.equal(evidence.candidate.kind, "research");
		assert.deepEqual(evidence.observation, { sessionId: "acp-fresh", requestId: "3", sessionOrigin: "created", captureStatus: "complete", manifest: null });
		const attempt = store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: evidence.outcome, candidate: evidence.candidate, observation: evidence.observation });
		assert.equal(attempt.acceptance, "pending");
		assert.equal(readFileSync(store.runtimeContentPath(evidence.answer), "utf8"), "Finding: the answer");
		const bytes = readFileSync(evidencePath);
		const again = spawnSync(process.execPath, ["--experimental-strip-types", script], { env: { ...process.env, PI_RUNTIME_SETTLE_CONFIG: configPath }, encoding: "utf8" });
		assert.equal(again.status, 0, again.stderr);
		assert.deepEqual(readFileSync(evidencePath), bytes, "an existing settlement record is never rewritten");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("partial, empty and failed output settle as recorded outcomes without a fabricated candidate", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-settle-partial-"));
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	try {
		const cases = [
			{ answer: "partial answer", status: "incomplete" as const, outcome: { kind: "failed", exitCode: 1, error: "worker exited 1" }, candidate: "research" },
			{ answer: "", status: "empty" as const, outcome: { kind: "exited", exitCode: 0 }, candidate: null },
			{ answer: "", status: "incomplete" as const, outcome: { kind: "cancelled", signal: "SIGTERM" }, candidate: null },
		];
		for (const [index, item] of cases.entries()) {
			const dir = join(root, `case-${index}`); mkdirSync(dir);
			const evidencePath = join(dir, "evidence.json");
			const evidence = settleRuntimeWorker(parseRuntimeSettleConfig({ schemaVersion: 1, attemptKey: `attempt-${index}`, workerResultPath: workerResult(dir, `attempt-${index}`, item.answer, item.status, item.outcome), kind: "research", baseDir: dir, baseRevision: "none", ownedPaths: [], readOnly: true, snapshotPath: null, agentFsExecutable: "agentfs", evidencePath, dbPath: store.dbPath }));
			assert.equal(evidence.outcome.kind, item.outcome.kind);
			assert.equal(evidence.candidate?.kind ?? null, item.candidate);
			assert.equal(evidence.observation.captureStatus, item.status);
		}
		assert.throws(() => parseRuntimeSettleConfig({ schemaVersion: 1, attemptKey: "a", workerResultPath: "/x", kind: "coding", baseDir: root, baseRevision: "b", ownedPaths: [], readOnly: true, snapshotPath: null, agentFsExecutable: "agentfs", evidencePath: join(root, "e") }), /owned-write AgentFS snapshot/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("coding settlement stages audited AgentFS changes and acceptance requires the applied integration", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-settle-coding-"));
	const stores: GraphStore[] = [];
	try {
		const base = join(root, "base"); mkdirSync(base);
		const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
		git("init"); writeFileSync(join(base, "note.txt"), "before"); git("add", "note.txt");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base");
		const baseRevision = git("rev-parse", "HEAD");
		const store = new GraphStore({ dbPath: join(home, "graph.db") }); stores.push(store);
		const run = store.initRun("settle", "build", "Implement", { input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "test" }, routes: [{ role: "thinker", tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }] }, undefined, "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-session", requestId: null, policyDigest: store.policy(run.runId).digest });
		execFileSync("agentfs", ["init", "--base", base, "candidate"], { cwd: root, env, stdio: "pipe" });
		const source = join(root, ".agentfs", "candidate.db"); const snapshotPath = join(root, "closed.db");
		execFileSync("agentfs", ["fs", source, "write", "/note.txt", "after"], { cwd: root, env, stdio: "pipe" });
		execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", source, snapshotPath]);
		const evidencePath = join(root, "runtime-settlement.json");
		const evidence = settleRuntimeWorker(parseRuntimeSettleConfig({ schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(root, identity.attemptKey, "Implemented the change", "complete"), kind: "coding", baseDir: base, baseRevision, ownedPaths: ["note.txt"], readOnly: false, snapshotPath, agentFsExecutable: "agentfs", evidencePath, dbPath: store.dbPath }));
		assert.equal(evidence.candidate?.kind, "coding");
		assert.equal(evidence.stagedFiles, 1);
		assert.ok(evidence.observation.manifest);
		rmSync(snapshotPath); rmSync(join(root, ".agentfs"), { recursive: true });
		const attempt = store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: evidence.outcome, candidate: evidence.candidate ?? undefined, observation: evidence.observation });
		assert.equal(attempt.acceptance, "pending");
		assert.throws(() => store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "checks passed" }), /applied integration/);
		assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
		const applied = store.applyRuntimeIntegration(identity.attemptKey, evidence.observation.manifest!);
		assert.equal(applied.state, "applied");
		assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "after");
		assert.deepEqual(store.applyRuntimeIntegration(identity.attemptKey, evidence.observation.manifest!), applied);
		const decided = store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "checks passed and review approved", payload: { slices: [{ id: "s1", name: "s1", task: "Implement", ownedPaths: ["note.txt"] }] } });
		assert.equal(decided.attempt.decision?.integrationId, applied.id);
		assert.equal(store.getOperation(operation.id).status, "completed");
	} finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const checkpoint of ["linkSync", "writeFileSync"] as const) test(`SIGKILL at ${checkpoint} between retention and evidence leaves no partial record and replays to the same settlement`, () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-settle-crash-"));
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	try {
		const run = store.initRun("crash", "research", "Investigate", { input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "test" }, routes: [{ role: "thinker", tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }] }, undefined, "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(run.runId).digest });
		const configPath = join(root, "settle.json");
		const evidencePath = join(root, "runtime-settlement-worker.json");
		writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(root, identity.attemptKey, "Finding after a crash", "complete"), kind: "research", baseDir: root, baseRevision: "none", ownedPaths: [], readOnly: true, snapshotPath: null, agentFsExecutable: "agentfs", evidencePath, dbPath: store.dbPath }));
		const crash = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
import { parseRuntimeSettleConfig, settleRuntimeWorker } from ${JSON.stringify(new URL("../scripts/runtime-settle.ts", import.meta.url).href)};
const original = fs[${JSON.stringify(checkpoint)}];
// linkSync sees the temporary path; the evidence body is the only file-descriptor write in the settle path.
fs[${JSON.stringify(checkpoint)}] = (...args) => { if (typeof args[0] === 'number' || String(args[0]).includes('runtime-settlement-worker.json')) process.kill(process.pid, 'SIGKILL'); return original(...args); };
syncBuiltinESMExports();
settleRuntimeWorker(parseRuntimeSettleConfig(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))));`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", crash, configPath], { encoding: "utf8", timeout: 10_000 });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		assert.equal(existsSync(evidencePath), false, "no partial evidence may exist after the crash");
		const stale = readdirSync(root).filter((entry) => entry.startsWith("runtime-settlement-worker.json.tmp-"));
		assert.equal(stale.length, 1, "the temporary is opened before the body write, so either crash leaves exactly one private temporary");
		const replay = spawnSync(process.execPath, ["--experimental-strip-types", script], { env: { ...process.env, PI_RUNTIME_SETTLE_CONFIG: configPath }, encoding: "utf8" });
		assert.equal(replay.status, 0, replay.stderr);
		assert.deepEqual(readdirSync(root).filter((entry) => entry.startsWith("runtime-settlement-worker.json.tmp-")), []);
		const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
		assert.equal(evidence.candidate.kind, "research");
		assert.equal(readFileSync(store.runtimeContentPath(evidence.answer), "utf8"), "Finding after a crash");
		const settled = store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: evidence.outcome, candidate: evidence.candidate, observation: evidence.observation });
		assert.equal(settled.processState, "exited");
		// A second replay against the complete record is a no-op that keeps the same bytes.
		const bytes = readFileSync(evidencePath);
		const again = spawnSync(process.execPath, ["--experimental-strip-types", script], { env: { ...process.env, PI_RUNTIME_SETTLE_CONFIG: configPath }, encoding: "utf8" });
		assert.equal(again.status, 0, again.stderr);
		assert.deepEqual(readFileSync(evidencePath), bytes);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
