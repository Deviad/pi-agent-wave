import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { parseAcpxNdjson, reconcileAcpxLifecycle, sanitizeAcpxNdjson, settleAcpxGraphOperation } from "./support/acpx-spike.ts";

const fixtureTranscript = [
	JSON.stringify({ jsonrpc: "2.0", id: "request-1", method: "session/prompt", params: { sessionId: "session-1", prompt: [{ type: "text", text: "task" }] } }),
	JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } } }),
	JSON.stringify({ jsonrpc: "2.0", id: "request-1", result: { stopReason: "end_turn" } }),
].join("\n");

describe("ACPX event mapping", () => {
	test("maps fixture NDJSON to typed lifecycle outcomes and rejects malformed input", () => {
		const events = parseAcpxNdjson(fixtureTranscript);
		assert.deepEqual(events.map((event) => event.kind), ["started", "progress", "completed"]);
		assert.equal(events[0]?.sessionId, "session-1");
		assert.throws(() => parseAcpxNdjson("not-json"), /invalid ACPX NDJSON/);
	});

	test("sanitizes sensitive values while preserving typed lifecycle structure", () => {
		const sensitive = [
			JSON.stringify({ jsonrpc: "2.0", id: "private-request", method: "session/prompt", params: { sessionId: "private-session", cwd: "/Users/example/private", prompt: [{ type: "text", text: "token sk-example-secret" }], _meta: { credential: "secret" } } }),
			JSON.stringify({ jsonrpc: "2.0", id: "private-request", result: { stopReason: "end_turn", _meta: { account: "person@example.com" } } }),
		].join("\n");
		const sanitized = sanitizeAcpxNdjson(sensitive);
		assert.doesNotMatch(sanitized, /sk-example-secret|private-session|private-request|\/Users\/example|person@example\.com|credential/);
		assert.deepEqual(parseAcpxNdjson(sanitized).map((event) => event.kind), ["started", "completed"]);
	});

	test("maps a sanitized real completed transcript when the bounded rehearsal produced one", { skip: !existsSync(join(process.cwd(), "agent-output", "acpx-headless-worker-spike", "acpx-session.ndjson")) }, () => {
		const transcript = readFileSync(join(process.cwd(), "agent-output", "acpx-headless-worker-spike", "acpx-session.ndjson"), "utf8");
		const events = parseAcpxNdjson(transcript);
		assert.ok(events.some((event) => event.kind === "started"));
		assert.ok(events.some((event) => event.kind === "completed"));
	});

	test("maps a sanitized real cancellation transcript when the bounded rehearsal produced one", { skip: !existsSync(join(process.cwd(), "agent-output", "acpx-headless-worker-spike", "acpx-cancel-session.ndjson")) }, () => {
		const transcript = readFileSync(join(process.cwd(), "agent-output", "acpx-headless-worker-spike", "acpx-cancel-session.ndjson"), "utf8");
		const events = parseAcpxNdjson(transcript);
		assert.ok(events.some((event) => event.kind === "started"));
		assert.ok(events.some((event) => event.kind === "cancelled"));
	});

	test("settles GraphStore only after process, session, Herdr, report, and evidence agree", () => {
		const directory = mkdtempSync(join(tmpdir(), "acpx-settlement-"));
		const reportPath = join(directory, "worker-report.json");
		writeFileSync(reportPath, "{}\n", { mode: 0o600 });
		const store = new GraphStore({ dbPath: join(directory, "graph.db") });
		try {
			const state = store.initRun("acpx-settlement", "operations", "Run harmless search", undefined, [{ id: "search", name: "Search", command: { executable: "/usr/bin/true", args: [], cwd: directory }, ownedPaths: [directory] }]);
			const operation = store.next(state.runId).operations[0];
			assert.ok(operation);
			const agentId = store.registerAgent({ runId: state.runId, name: "searcher-1", node: operation.node, role: "searcher", transport: "herdr", herdrAgent: "dg-acpx-searcher-1", tabId: "tab-1", herdrPaneId: "pane-1", currentTask: operation.task });
			store.record({ runId: state.runId, operationId: operation.id, status: "running", agentId, agentName: "searcher-1", transport: "herdr" });

			const completedTranscriptPath = join(process.cwd(), "agent-output", "acpx-headless-worker-spike", "acpx-session.ndjson");
			const completedTranscript = existsSync(completedTranscriptPath) ? readFileSync(completedTranscriptPath, "utf8") : fixtureTranscript;
			const incomplete = reconcileAcpxLifecycle({ events: parseAcpxNdjson(completedTranscript), exitCode: 0, sessionState: "idle", herdrVisible: true, reportValidated: false, evidenceAuditValid: true });
			assert.throws(() => settleAcpxGraphOperation(store, { runId: state.runId, operationId: operation.id, agentId, agentName: "searcher-1", reportPath, verdict: "DONE", lifecycle: incomplete }), /report is not validated/);
			assert.equal(store.getOperation(operation.id).status, "running");

			const complete = reconcileAcpxLifecycle({ events: parseAcpxNdjson(completedTranscript), exitCode: 0, sessionState: "idle", herdrVisible: true, reportValidated: true, evidenceAuditValid: true });
			settleAcpxGraphOperation(store, { runId: state.runId, operationId: operation.id, agentId, agentName: "searcher-1", reportPath, verdict: "DONE", lifecycle: complete });
			assert.equal(store.getOperation(operation.id).status, "completed");
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
