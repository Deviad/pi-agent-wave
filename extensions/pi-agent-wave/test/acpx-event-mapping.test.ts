import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAcpxNdjson, reconcileAcpxLifecycle, sanitizeAcpxNdjson } from "./support/acpx-spike.ts";
import { repoRoot } from "./support/repoRoot.ts";

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

	test("maps a sanitized real completed transcript when the bounded rehearsal produced one", { skip: !existsSync(join(repoRoot, "agent-output", "acpx-headless-worker-spike", "acpx-session.ndjson")) }, () => {
		const transcript = readFileSync(join(repoRoot, "agent-output", "acpx-headless-worker-spike", "acpx-session.ndjson"), "utf8");
		const events = parseAcpxNdjson(transcript);
		assert.ok(events.some((event) => event.kind === "started"));
		assert.ok(events.some((event) => event.kind === "completed"));
	});

	test("maps a sanitized real cancellation transcript when the bounded rehearsal produced one", { skip: !existsSync(join(repoRoot, "agent-output", "acpx-headless-worker-spike", "acpx-cancel-session.ndjson")) }, () => {
		const transcript = readFileSync(join(repoRoot, "agent-output", "acpx-headless-worker-spike", "acpx-cancel-session.ndjson"), "utf8");
		const events = parseAcpxNdjson(transcript);
		assert.ok(events.some((event) => event.kind === "started"));
		assert.ok(events.some((event) => event.kind === "cancelled"));
	});
});
