import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseAcpxNdjson, parseAcpxStatus, sanitizeAcpxNdjson } from "../lib/acpx-events.ts";

describe("production ACPX structured events", () => {
	const completed = [
		JSON.stringify({ jsonrpc: "2.0", id: "request-private", method: "session/prompt", params: { sessionId: "session-private", prompt: [{ type: "text", text: "secret prompt" }] } }),
		JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-private", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress" } } } }),
		JSON.stringify({ jsonrpc: "2.0", id: "request-private", result: { stopReason: "end_turn", _meta: { token: "sk-not-real-secret-value" } } }),
	].join("\n");

	test("parses typed lifecycle messages and fails on malformed input", () => {
		assert.deepEqual(parseAcpxNdjson(completed).map((event) => event.kind), ["started", "progress", "completed"]);
		assert.throws(() => parseAcpxNdjson("not-json"), /invalid ACPX NDJSON/);
	});

	test("models tested client states separately and blocks unknown values", () => {
		assert.equal(parseAcpxStatus('{"action":"status_snapshot","status":"idle"}'), "idle");
		assert.equal(parseAcpxStatus('{"action":"status_snapshot","status":"alive"}'), "alive");
		assert.equal(parseAcpxStatus('{"action":"status_snapshot","status":"no-session"}'), "no-session");
		assert.throws(() => parseAcpxStatus('{"action":"status_snapshot","status":"running"}'), /unsupported ACPX state/);
	});

	test("sanitizes free text, metadata, paths, and identifiers without losing lifecycle structure", () => {
		const sanitized = sanitizeAcpxNdjson(completed.replace("secret prompt", "/Users/example token sk-example-1234567890"));
		assert.doesNotMatch(sanitized, /Users|sk-example|session-private|request-private|_meta/);
		assert.deepEqual(parseAcpxNdjson(sanitized).map((event) => event.kind), ["started", "progress", "completed"]);
	});

	test("maps cancellation and structured errors", () => {
		const cancelled = `${JSON.stringify({ jsonrpc: "2.0", id: "r", method: "session/prompt", params: { sessionId: "s", prompt: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", id: "r", result: { stopReason: "cancelled" } })}`;
		const failed = `${JSON.stringify({ jsonrpc: "2.0", id: "r", method: "session/prompt", params: { sessionId: "s", prompt: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", id: "r", error: { code: -32000, message: "failed" } })}`;
		assert.deepEqual(parseAcpxNdjson(cancelled).map((event) => event.kind), ["started", "cancelled"]);
		assert.deepEqual(parseAcpxNdjson(failed).map((event) => event.kind), ["started", "failed"]);
	});
});
