#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_EXPECT_CLAUDE_TOKEN && process.env.CLAUDE_CODE_OAUTH_TOKEN !== process.env.FAKE_EXPECT_CLAUDE_TOKEN) {
	process.stderr.write("missing ephemeral Claude token\n");
	process.exit(3);
}
if (args.includes("--version")) {
	process.stdout.write("0.13.2\n");
} else if (args.includes("ensure")) {
	process.stdout.write(`${JSON.stringify({ action: "session_created", acpxRecordId: "record-fixture", acpxSessionId: "session-fixture" })}\n`);
} else if (args.includes("read")) {
	process.stdout.write(`${JSON.stringify({ action: "session_history", entries: existsSync(join(process.env.HOME ?? ".", ".fake-acpx-cancelled")) ? [{ result: { stopReason: "cancelled" } }] : [] })}\n`);
} else if (args.includes("close")) {
	writeFileSync(join(process.env.HOME ?? ".", ".fake-acpx-closed"), "closed\n");
	process.stdout.write(`${JSON.stringify({ action: "session_closed", acpxRecordId: "record-fixture", acpxSessionId: "session-fixture" })}\n`);
} else if (args.includes("cancel")) {
	writeFileSync(join(process.env.HOME ?? ".", ".fake-acpx-cancelled"), "cancelled\n");
	process.stdout.write(`${JSON.stringify({ action: "cancel_result", acpxRecordId: "record-fixture", cancelled: true })}\n`);
} else if (args.includes("status")) {
	process.stdout.write(`${JSON.stringify({ action: "status_snapshot", status: existsSync(join(process.env.HOME ?? ".", ".fake-acpx-closed")) ? "no-session" : "idle" })}\n`);
} else {
	const sessionIndex = args.indexOf("--session");
	const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "fixture-session";
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "request-1", method: "session/prompt", params: { sessionId, prompt: [] } })}\n`);
	if (process.env.FAKE_ACPX_SILENT !== "1") {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.FAKE_ACPX_ASSISTANT ?? "fixture progress" } } } })}\n`);
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "request-1", result: { stopReason: "end_turn" } })}\n`);
	process.stderr.write("fixture-stderr\n");
	process.exitCode = Number(process.env.FAKE_ACPX_EXIT ?? "0");
}
