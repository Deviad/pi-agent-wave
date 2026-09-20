import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attemptDetail, refreshAgentListLiveViews } from "../agent-list.ts";
import { LIVE_VIEW_PENDING, LIVE_VIEW_UNAVAILABLE, liveViewFor, refreshLiveView, resetLiveViewsForTests, streamRunDirectory } from "../lib/live-stream.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { GraphStore } from "../store.ts";
import { packageRoot } from "./support/repoRoot.ts";

/**
 * The live view for a worker that has no terminal. US-003 gave a headless worker a stream to publish;
 * these prove the view actually reads it, that it does so without ever blocking the terminal, and that a
 * worker publishing nothing says so rather than showing a capture file in its place.
 */

const dirs: string[] = [];
const workers: ChildProcess[] = [];
afterEach(() => {
	resetLiveViewsForTests();
	for (const worker of workers.splice(0)) worker.kill("SIGKILL");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];
const MODEL = "openai-codex/gpt-5.6-sol";

interface StartedWorker { runDir: string; attemptDir: string; cancelScript: string; attemptKey: string }

/** Starts the real supervisor and a real worker, and reports where it put them. */
async function startLiveWorker(): Promise<StartedWorker> {
	const driver = spawn("python3", [join(packageRoot, "test/support/live-view-driver.py")], { stdio: ["ignore", "pipe", "pipe"] });
	workers.push(driver);
	let stderr = "";
	driver.stderr!.setEncoding("utf8");
	driver.stderr!.on("data", (chunk: string) => { stderr += chunk; });
	return await new Promise<StartedWorker>((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error(`the live-view driver did not report a worker in 20s; stderr: ${stderr.slice(-400)}`)), 20_000);
		driver.stdout!.setEncoding("utf8");
		driver.stdout!.on("data", (chunk: string) => {
			text += chunk;
			// The driver prints its record on one line and then holds the worker alive.
			const line = text.split("\n").find((item) => item.trim().startsWith("{"));
			if (!line) return;
			try {
				const parsed = JSON.parse(line) as StartedWorker;
				clearTimeout(timer);
				resolve(parsed);
			} catch { /* partial line: the next chunk completes it */ }
		});
		driver.on("error", (error) => { clearTimeout(timer); reject(error); });
	});
}

/** A run with the policy the store needs, so the detail view has real rows to read. */
function newRun(store: GraphStore, story: string): { runId: string; operationId: string } {
	const resolved = JSON.parse(spawnSync("node", [join(packageRoot, "scripts", "policy-resolver.mjs"), "--input", JSON.stringify({ kind: "model", model: MODEL, reason: "fixture" }), "--roles", ROLES.join(",")], { encoding: "utf8" }).stdout);
	const policy = { kind: "model" as const, input: resolved.input, routes: resolved.roles.map((route: Record<string, any>) => ({ role: route.role, tier: route.tier, chain: route.models, thinking: route.thinking ?? "off", session: route.session ?? false, capabilityFloor: route.capabilityFloor ?? "", promoted: route.promoted, promotedFrom: route.promotedFrom, promotionReason: null, selectionSource: "exact-model" })) };
	const state = store.initRun(story, "research", "Investigate", policy as never);
	return { runId: state.runId, operationId: store.next(state.runId).operations[0]!.id };
}

/** Registers a headless worker bound to the real cancel script the driver created, exactly as dispatch does. */
function registerFor(store: GraphStore, dir: string, runId: string, operationId: string, cancelScript: string, attemptKey: string): string {
	const operation = store.getOperation(operationId);
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: "thinker", modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel: MODEL, agent: "codex" });
	const attemptDir = join(dir, "provenance");
	mkdirSync(attemptDir, { recursive: true });
	const agentId = store.registerAgent({ runId, name: "dg-liveview-thinker", node: operation.node, role: "thinker", transport: "headless", selectedModel: MODEL, modelAttempt: operation.model_attempt, acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
	return identity.attemptKey;
}

describe("headless live view", () => {
	test("a running headless worker's view shows the lines its supervisor publishes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "live-view-")); dirs.push(dir);
		const worker = await startLiveWorker();
		// The registration carries the real paths the launcher recorded, which is how the view finds the stream.
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		try {
			const run = newRun(store, "live-view");
			const attemptKey = registerFor(store, dir, run.runId, run.operationId, worker.cancelScript, worker.attemptKey);
			await refreshLiveView(attemptKey, streamRunDirectory(worker.cancelScript), 12);
			const detail = attemptDetail(store, { number: 1, attemptKey, runId: run.runId, operationId: run.operationId });
			assert.ok(detail.liveOutput.some((line) => line.includes("LIVE VIEW LINE ONE")), `the view must show what the worker published: ${JSON.stringify(detail.liveOutput)}`);
			assert.equal(detail.liveOutputNote, null, "lines are shown, so there is nothing to explain");
			// The stream carries terminal colouring; the view must render text, not escape sequences.
			assert.ok(detail.liveOutput.some((line) => line.includes("COLOURED LIVE LINE")), `the coloured line is shown: ${JSON.stringify(detail.liveOutput)}`);
			assert.equal(detail.liveOutput.some((line) => line.includes("\u001b")), false, "no escape sequence reaches the view");
		} finally { store.close(); }
	});

	test("the run directory is discovered from the registration, not assumed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "live-view-dir-")); dirs.push(dir);
		const worker = await startLiveWorker();
		// The real layout: <run>/acpx/<agent>/cancel-acpx.sh, with the descriptor three levels up.
		assert.equal(dirname(dirname(dirname(worker.cancelScript))), worker.runDir, "the fixture matches the layout the search walks");
		assert.equal(streamRunDirectory(worker.cancelScript), worker.runDir, "the search finds the descriptor's directory");
		assert.equal(streamRunDirectory(join(worker.attemptDir, "cancel-acpx.sh")), worker.runDir, "and from the attempt directory too");
		assert.equal(streamRunDirectory(join(dir, "nowhere", "cancel-acpx.sh")), null, "a script with no descriptor above it has no stream");
		assert.equal(streamRunDirectory(null), null);
	});

	test("reading the stream never blocks the view, and an unreachable endpoint is a note", async () => {
		const dir = mkdtempSync(join(tmpdir(), "live-view-dead-")); dirs.push(dir);
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		try {
			const run = newRun(store, "dead-endpoint");
			// A descriptor pointing at a port nothing listens on: the read must give up, not hang.
			const runDir = join(dir, "run"); mkdirSync(runDir, { recursive: true });
			writeFileSync(join(runDir, "headless-w.stream-endpoint.json"), JSON.stringify({ schemaVersion: 1, backend: "loopback-tcp", host: "127.0.0.1", port: 9 }) + "\n", { mode: 0o600 });
			writeFileSync(join(runDir, "headless-w.stream-token"), "token\n", { mode: 0o600 });
			const attemptKey = registerFor(store, dir, run.runId, run.operationId, join(dir, "provenance", "cancel-acpx.sh"), "key-dead");

			// Before any read, the view renders immediately with a pending note: never a stall, never a blank.
			const started = Date.now();
			const pending = attemptDetail(store, { number: 1, attemptKey, runId: run.runId, operationId: run.operationId });
			assert.ok(Date.now() - started < 250, "rendering must not wait for a read");
			assert.equal(pending.liveOutput.length, 0);
			assert.equal(pending.liveOutputNote, LIVE_VIEW_PENDING);

			const readStarted = Date.now();
			await refreshLiveView(attemptKey, runDir, 12);
			assert.ok(Date.now() - readStarted < 5_000, "an unreachable endpoint gives up inside the budget");
			assert.equal(liveViewFor(attemptKey)?.note, LIVE_VIEW_UNAVAILABLE);
		} finally { store.close(); }
	});

	test("a run directory with no descriptor is a note, and a capture file beside it is never shown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "live-view-none-")); dirs.push(dir);
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		try {
			const run = newRun(store, "no-stream");
			const runDir = join(dir, "run", "acpx", "agent"); mkdirSync(join(runDir, "runtime-output"), { recursive: true });
			// A capture file full of renderable events sitting exactly where the old display path read it.
			writeFileSync(join(runDir, "runtime-output", "worker.stdout.ndjson"), JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FILE ONLY: never displayed" } } } }) + "\n", { mode: 0o600 });
			const attemptKey = registerFor(store, dir, run.runId, run.operationId, join(runDir, "cancel-acpx.sh"), "key-none");
			await refreshLiveView(attemptKey, streamRunDirectory(join(runDir, "cancel-acpx.sh")), 12);
			const detail = attemptDetail(store, { number: 1, attemptKey, runId: run.runId, operationId: run.operationId });
			assert.equal(detail.liveOutputNote, LIVE_VIEW_UNAVAILABLE);
			assert.equal(JSON.stringify(detail).includes("FILE ONLY"), false, "the capture file is never a display source");
		} finally { store.close(); }
	});
});