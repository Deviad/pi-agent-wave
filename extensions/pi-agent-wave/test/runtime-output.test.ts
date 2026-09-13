import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeOutputFiles } from "../lib/runtime-output.ts";

test("durable output retains ordinary prose and provenance without reading report files", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-output-"));
	try {
		writeFileSync(join(root, "report.json"), "malformed bookkeeping");
		const output = new RuntimeOutputFiles(root, { attemptKey: "attempt", sessionId: "session", requestId: null });
		for (const event of [
			{ jsonrpc: "2.0", method: "session/prompt", id: "request", params: { sessionId: "session" } },
			{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Authored answer" } } } },
			{ jsonrpc: "2.0", id: "request", result: { stopReason: "end_turn" } },
		]) output.stdout(Buffer.from(JSON.stringify(event) + "\n"));
		output.stderr(Buffer.from("diagnostic"));
		const result = output.finish({ kind: "exited", exitCode: 0 });
		assert.equal(result.capture.captureStatus, "complete");
		assert.equal(result.capture.responseCompleteness, "unverified");
		assert.equal(readFileSync(join(root, "public-answer.txt"), "utf8"), "Authored answer");
		assert.match(readFileSync(join(root, "public-provenance.ndjson"), "utf8"), /"requestId":"request"/);
		assert.equal(statSync(join(root, "public-answer.txt")).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "runtime-output.json"), "utf8")), result);
		assert.throws(() => new RuntimeOutputFiles(root, { attemptKey: "attempt", sessionId: "session", requestId: null }), /EEXIST/);
		assert.equal(readFileSync(join(root, "public-answer.txt"), "utf8"), "Authored answer");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed process and bounded stderr remain durable without semantic success", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-output-failure-"));
	try {
		const output = new RuntimeOutputFiles(root, { attemptKey: "attempt", sessionId: "session", requestId: null });
		output.stderr(Buffer.alloc(2 * 1024 * 1024, 120));
		const result = output.finish({ kind: "failed", exitCode: 1, error: "provider failure" });
		assert.equal(result.outcome.kind, "failed");
		assert.equal(result.capture.captureStatus, "incomplete");
		assert.equal(result.stderrTruncated, true);
		assert.equal(statSync(join(root, "worker.stderr.txt")).size, 1024 * 1024);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
