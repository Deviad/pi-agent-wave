import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimePublicCapture } from "../lib/runtime-capture.ts";

const identity = { attemptKey: "attempt-1", sessionId: "session-1", requestId: "request-1" };
const prompt = { jsonrpc: "2.0", id: identity.requestId, method: "session/prompt", params: { sessionId: identity.sessionId, prompt: [] } };
const terminal = { jsonrpc: "2.0", id: identity.requestId, result: { stopReason: "end_turn" } };
function update(text: string, sessionUpdate = "agent_message_chunk", sessionId = identity.sessionId) {
	return { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } } };
}
function stream(...events: unknown[]): Buffer { return Buffer.from(events.map((value) => JSON.stringify(value)).join("\n") + "\n"); }

test("a loaded ensured session binds an unknown request from its prompt", () => {
	// Pi (2026-09-12 evidence): acpx sends session/load for the ensured id, then session/prompt.
	const provenance: unknown[] = [];
	const capture = new RuntimePublicCapture({ ...identity, requestId: null }, (_text, source) => provenance.push(source));
	capture.write(stream({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: identity.sessionId, cwd: "/mnt", mcpServers: [] } }, { jsonrpc: "2.0", id: 1, result: { configOptions: [] } }, prompt, update("answer"), terminal));
	const result = capture.finish();
	assert.equal(result.captureStatus, "complete");
	assert.equal(result.requestId, identity.requestId);
	assert.equal(result.sessionId, identity.sessionId);
	assert.equal(result.sessionOrigin, "loaded");
	assert.deepEqual(provenance[0], { ...identity, eventIndex: 4, chunkIndex: 0 });
});

test("a replacement session created inside the exclusive prompt process binds under its observed id", () => {
	// Codex and Claude (2026-09-12 evidence): the adapter cannot resume, so acpx issues session/new
	// and prompts the fresh id; the ensured id never appears in the stream.
	const provenance: unknown[] = [];
	const capture = new RuntimePublicCapture({ ...identity, requestId: null }, (_text, source) => provenance.push(source));
	capture.write(stream(
		{ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/mnt", mcpServers: [] } },
		{ jsonrpc: "2.0", id: 2, result: { sessionId: "fresh", modes: null } },
		{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fresh", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } },
		{ ...prompt, id: 3, params: { sessionId: "fresh", prompt: [] } },
		update("answer", "agent_message_chunk", "fresh"),
		{ ...terminal, id: 3 },
	));
	const result = capture.finish();
	assert.equal(result.captureStatus, "complete");
	assert.equal(result.requestId, "3");
	assert.equal(result.sessionId, "fresh");
	assert.equal(result.sessionOrigin, "created");
	assert.deepEqual(provenance[0], { attemptKey: identity.attemptKey, sessionId: "fresh", requestId: "3", eventIndex: 5, chunkIndex: 0 });
});

test("a reconnected live adapter session binds from its prompt and is labelled resumed", () => {
	// Second Codex/Claude prompt (2026-09-12 evidence): no session/new or session/load, and the
	// prompt carries the id created by the previous process rather than the ensured id.
	const capture = new RuntimePublicCapture({ ...identity, requestId: null }, () => {});
	capture.write(stream({ ...prompt, id: 4, params: { sessionId: "alive", prompt: [] } }, update("answer", "agent_message_chunk", "alive"), { ...terminal, id: 4 }));
	const result = capture.finish();
	assert.equal(result.captureStatus, "complete");
	assert.deepEqual([result.sessionId, result.sessionOrigin], ["alive", "resumed"]);
});

test("an ensured session prompt without load or new is labelled expected", () => {
	const capture = new RuntimePublicCapture({ ...identity, requestId: null }, () => {});
	capture.write(stream(prompt, update("answer"), terminal));
	assert.deepEqual([capture.finish().sessionId, capture.finish().sessionOrigin], [identity.sessionId, "expected"]);
});

test("two distinct prompt sessions, a mismatched load and a second created session make capture incomplete", () => {
	for (const events of [
		[{ ...prompt, params: { sessionId: "other", prompt: [] } }, { ...prompt, id: "second" }, update("answer"), terminal],
		[{ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "other" } }, { ...prompt, params: { sessionId: "other", prompt: [] } }, update("answer", "agent_message_chunk", "other"), terminal],
		[{ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }, { jsonrpc: "2.0", id: 2, result: { sessionId: "one" } }, { jsonrpc: "2.0", id: 9, method: "session/new", params: {} }, { jsonrpc: "2.0", id: 9, result: { sessionId: "two" } }, { ...prompt, params: { sessionId: "two", prompt: [] } }, update("answer", "agent_message_chunk", "two"), terminal],
	]) {
		const capture = new RuntimePublicCapture({ ...identity, requestId: null }, () => {});
		capture.write(stream(...events));
		assert.equal(capture.finish().captureStatus, "incomplete", JSON.stringify(capture.finish().diagnostics));
	}
});

test("adapter bookkeeping updates before, inside and after the prompt are ignored rather than diagnosed", () => {
	// Observed 2026-09-12: Pi emits config_option_update before the prompt, Codex and Claude emit
	// available_commands_update before it, Claude emits session_info_update after end_turn.
	const bookkeeping = (sessionUpdate: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: identity.sessionId, update: { sessionUpdate } } });
	const capture = new RuntimePublicCapture({ ...identity, requestId: null }, () => {});
	capture.write(stream(bookkeeping("config_option_update"), bookkeeping("available_commands_update"), { jsonrpc: "2.0", method: "_auth/status_update", params: {} }, prompt, bookkeeping("session_info_update"), bookkeeping("usage_update"), update("answer"), terminal, bookkeeping("session_info_update")));
	const result = capture.finish();
	assert.equal(result.captureStatus, "complete", JSON.stringify(result.diagnostics));
	assert.equal(result.ignoredEvents, 5);
});

test("public capture survives every byte boundary and keeps final-answer semantics unverified", () => {
	const text: string[] = [];
	const provenance: unknown[] = [];
	const capture = new RuntimePublicCapture(identity, (chunk, source) => { text.push(chunk); provenance.push(source); });
	const bytes = stream(prompt, update("Finding: café 🦊"), update(" more"), terminal);
	for (const byte of bytes) capture.write(Buffer.from([byte]));
	const result = capture.finish();
	assert.equal(text.join(""), "Finding: café 🦊 more");
	assert.equal(result.captureStatus, "complete");
	assert.equal(result.responseCompleteness, "unverified");
	assert.equal(result.answerBytes, Buffer.byteLength(text.join("")));
	assert.equal(result.publicChunks, 2);
	assert.deepEqual(provenance[0], { ...identity, eventIndex: 2, chunkIndex: 0 });
	assert.deepEqual(capture.finish(), result);
	assert.throws(() => capture.write(bytes), /finished/);
});

test("thoughts, tool text, other sessions and stale request output are never assistant answers", () => {
	const text: string[] = [];
	const capture = new RuntimePublicCapture(identity, (chunk) => text.push(chunk));
	capture.write(stream(prompt, update("private thought", "agent_thought_chunk"), update("tool stdout", "tool_call_update"), update("other session", "agent_message_chunk", "other"), { ...update("stale"), id: "old-request" }, update("authored"), terminal));
	assert.deepEqual(text, ["authored"]);
	assert.equal(capture.finish().ignoredEvents, 4);
});

test("empty and tool-only turns cannot produce a candidate answer", () => {
	for (const events of [[prompt, terminal], [prompt, update("", "agent_message_chunk"), update("tool", "tool_call"), terminal]]) {
		const capture = new RuntimePublicCapture(identity, () => assert.fail("empty turn wrote an answer"));
		capture.write(stream(...events));
		assert.equal(capture.finish().captureStatus, "empty");
	}
});

test("whitespace-only public output remains an empty answer", () => {
	const capture = new RuntimePublicCapture(identity, () => {});
	capture.write(stream(prompt, update(" \n\t"), terminal));
	assert.equal(capture.finish().captureStatus, "empty");
});

test("overlapping prompts and output outside the request boundary make capture incomplete", () => {
	for (const events of [
		[update("before request"), prompt, update("answer"), terminal],
		[prompt, { ...prompt, id: "overlap" }, update("ambiguous"), terminal],
		[prompt, update("answer"), terminal, update("late")],
	]) {
		const text: string[] = [];
		const capture = new RuntimePublicCapture(identity, (chunk) => text.push(chunk));
		capture.write(stream(...events));
		assert.equal(capture.finish().captureStatus, "incomplete");
		assert.doesNotMatch(text.join(""), /before request|ambiguous|late/);
	}
});

test("malformed, invalid UTF-8, truncated, failed and cancelled streams remain incomplete", () => {
	for (const bytes of [
		Buffer.concat([stream(prompt, update("retained")), Buffer.from("{broken\n")]),
		Buffer.concat([stream(prompt), Buffer.from([0xff, 10])]),
		stream(prompt, update("retained")),
		stream(prompt, { ...terminal, result: { stopReason: "cancelled" } }),
		stream(prompt, { jsonrpc: "2.0", id: identity.requestId, error: { code: -1, message: "failure" } }),
	]) {
		const capture = new RuntimePublicCapture(identity, () => {});
		capture.write(bytes);
		assert.equal(capture.finish().captureStatus, "incomplete");
	}
});

test("event and total limits bound buffering and never silently truncate to success", () => {
	const oversized = new RuntimePublicCapture(identity, () => {}, { maxEventBytes: 256, maxTotalBytes: 1024 });
	oversized.write(stream(prompt));
	oversized.write(Buffer.alloc(4096, 120));
	const result = oversized.finish();
	assert.equal(result.captureStatus, "incomplete");
	assert.ok(result.peakBufferedBytes <= 256);
	assert.ok(result.inputBytes <= 1024);
	assert.ok(result.diagnostics.includes("event-limit"));
	assert.ok(result.diagnostics.includes("total-limit"));
	const bytes = stream(prompt, update("answer"), terminal);
	const limited = new RuntimePublicCapture(identity, () => {}, { maxEventBytes: 256, maxTotalBytes: bytes.length - 1 });
	limited.write(bytes);
	assert.equal(limited.finish().captureStatus, "incomplete");
});

test("essential sink failure stops capture and propagates instead of becoming an optional diagnostic", () => {
	const capture = new RuntimePublicCapture(identity, () => { throw new Error("disk unavailable"); });
	assert.throws(() => capture.write(stream(prompt, update("answer"), terminal)), /disk unavailable/);
	assert.equal(capture.finish().captureStatus, "incomplete");
});
