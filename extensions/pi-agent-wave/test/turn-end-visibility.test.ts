import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { attemptDetail, listRows, noteRegisteredAttempt, processLabel, resetAgentListForTests, type AgentListActions } from "../agent-list.ts";
import { resetLiveViewsForTests } from "../lib/live-stream.ts";
import { setPaneReaderForTests } from "../lib/pane-read.ts";
import { turnEndFor } from "../lib/turn-end.ts";
import { packageRoot } from "./support/repoRoot.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A worker whose turn ended but which nobody has collected. The store still holds `running`, because it
 * records the process outcome at settlement; the display paths must say the process exited and collection
 * is pending, without waiting on anything and without changing what settlement means.
 */

const dirs: string[] = [];
afterEach(() => {
	resetAgentListForTests();
	resetLiveViewsForTests();
	setPaneReaderForTests(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODEL = "openai-codex/gpt-5.6-sol";
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

function newRun(store: GraphStore, story: string): { runId: string; operationId: string } {
	const resolved = JSON.parse(spawnSync("node", [join(packageRoot, "scripts", "policy-resolver.mjs"), "--input", JSON.stringify({ kind: "model", model: MODEL, reason: "fixture" }), "--roles", ROLES.join(",")], { encoding: "utf8" }).stdout);
	const policy = { kind: "model" as const, input: resolved.input, routes: resolved.roles.map((route: Record<string, any>) => ({ role: route.role, tier: route.tier, chain: route.models, thinking: route.thinking ?? "off", session: route.session ?? false, capabilityFloor: route.capabilityFloor ?? "", promoted: route.promoted, promotedFrom: route.promotedFrom, promotionReason: null, selectionSource: "exact-model" })) };
	const state = store.initRun(story, "research", "Investigate", policy as never);
	return { runId: state.runId, operationId: store.next(state.runId).operations[0]!.id };
}

/** An attempt whose worker is registered exactly as dispatch registers it, with a real attempt directory. */
function registerWorker(store: GraphStore, dir: string, run: { runId: string; operationId: string }): { attemptKey: string; attemptDir: string; runDir: string } {
	const operation = store.getOperation(run.operationId);
	const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: run.operationId, role: "thinker", modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel: MODEL, agent: "codex" });
	const runDir = join(dir, "private-run");
	const attemptDir = join(runDir, "acpx", "worker-1");
	mkdirSync(attemptDir, { recursive: true });
	const cancelScript = join(attemptDir, "cancel-acpx.sh");
	writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const agentId = store.registerAgent({ runId: run.runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", selectedModel: MODEL, modelAttempt: operation.model_attempt, acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(run.runId).digest, agentId });
	return { attemptKey: identity.attemptKey, attemptDir, runDir };
}

/** What the worker writes when its turn is over, byte-shaped like `scripts/acpx-worker.ts`. */
function writeWorkerResult(attemptDir: string, attemptKey: string): void {
	writeFileSync(join(attemptDir, "worker-result.json"), JSON.stringify({ schemaVersion: 2, resultContract: "runtime-v1", agent: "codex", selectedModel: MODEL, sessionName: "dg-session", attemptKey, outputDir: join(attemptDir, "runtime-output"), output: {} }, null, 2) + "\n", { mode: 0o600 });
}

/** What the headless supervisor writes at `headless_supervisor.py:110`. */
function writeSupervisorStatus(runDir: string, exitCode: number): void {
	writeFileSync(join(runDir, "headless-worker-1.status.json"), JSON.stringify({ schemaVersion: 1, workerPid: 4242, exitCode }) + "\n", { mode: 0o600 });
}

test("a worker whose turn ended reads as awaiting collect, while the operation is still running", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-end-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	try {
		const run = newRun(store, "turn-end");
		const worker = registerWorker(store, dir, run);
		const entry = { number: 1, attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId };

		// While the worker is genuinely running there is no result file, and nothing claims otherwise.
		assert.equal(turnEndFor(join(worker.attemptDir, "cancel-acpx.sh")).ended, false);
		assert.equal(attemptDetail(store, entry).processState, "running");

		writeWorkerResult(worker.attemptDir, worker.attemptKey);
		writeSupervisorStatus(worker.runDir, 0);

		const detail = attemptDetail(store, entry);
		assert.equal(detail.processState, "process exited 0, awaiting collect", "the detail view states the turn ended and collection is pending");
		assert.equal(store.getOperation(run.operationId).status, "running", "the operation is genuinely still running: nothing settled it");
		assert.equal(store.runtimeAttempt(worker.attemptKey).processState, "running", "and the stored process state is untouched");
		assert.equal(store.runtimeAttempt(worker.attemptKey).acceptance, "unavailable", "no candidate has been settled, so there is nothing to accept yet");
	} finally { store.close(); }
});

test("the agent list row says so too, and a worker with no supervisor record still reports the turn ended", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-end-row-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	try {
		const run = newRun(store, "turn-end-row");
		const worker = registerWorker(store, dir, run);
		const ctx = { mode: "tui", cwd: process.cwd(), ui: { getEditorText: () => "", notify: () => {}, setWidget: () => {}, onTerminalInput: () => () => {} } } as unknown as ExtensionContext;
		noteRegisteredAttempt(store, ctx, { attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }, 2_000, {} as AgentListActions);
		assert.equal(listRows(store)[0]!.state, "running");

		// The Herdr transport publishes no status file; the result file alone is the signal.
		writeWorkerResult(worker.attemptDir, worker.attemptKey);
		assert.deepEqual(turnEndFor(join(worker.attemptDir, "cancel-acpx.sh")), { ended: true, exitCode: null });
		assert.equal(listRows(store)[0]!.state, "process exited, awaiting collect");
		assert.equal(listRows(store)[0]!.running, true, "it is still an uncollected worker, so cancel still reaches it");
	} finally { store.close(); }
});

test("the turn-end read never waits and never throws, whatever it is pointed at", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-end-safe-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	try {
		const run = newRun(store, "turn-end-safe");
		const worker = registerWorker(store, dir, run);

		// A hung worker: a FIFO where the result file goes. Opening it for read would block forever; the
		// view must stat it, see it is not a regular file, and report the turn as still running.
		const fifo = join(worker.attemptDir, "worker-result.json");
		const made = spawnSync("mkfifo", [fifo]);
		assert.equal(made.status, 0, `the fixture needs a FIFO: ${made.stderr}`);
		const started = Date.now();
		assert.equal(turnEndFor(fifo.replace("worker-result.json", "cancel-acpx.sh")).ended, false, "a worker whose result is not a regular file has not finished its turn");
		assert.equal(attemptDetail(store, { number: 1, attemptKey: worker.attemptKey, runId: run.runId, operationId: run.operationId }).processState, "running");
		assert.ok(Date.now() - started < 1_000, "the read returns immediately rather than blocking on the hung worker");

		assert.equal(turnEndFor(null).ended, false);
		assert.equal(turnEndFor(join(dir, "nowhere", "cancel-acpx.sh")).ended, false);
	} finally { store.close(); }
});

test("a settled attempt's label comes from its recorded outcome, never from a leftover result file", () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-end-settled-")); dirs.push(dir);
	const store = new GraphStore({ dbPath: join(dir, "graph.db") });
	try {
		const run = newRun(store, "turn-end-settled");
		const worker = registerWorker(store, dir, run);
		writeWorkerResult(worker.attemptDir, worker.attemptKey);
		const answer = store.retainRuntimeContent(Buffer.from("Finding: the answer"));
		store.settleRuntimeAttempt({ attemptKey: worker.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "dg-session", requestId: null, sessionOrigin: "created", captureStatus: "complete", manifest: null } });
		const attempt = store.runtimeAttempt(worker.attemptKey);
		assert.equal(attempt.processState, "exited");
		assert.equal(processLabel(attempt, join(worker.attemptDir, "cancel-acpx.sh")), "settled (exited 0)", "a settled attempt is described by what settlement recorded");
	} finally { store.close(); }
});
