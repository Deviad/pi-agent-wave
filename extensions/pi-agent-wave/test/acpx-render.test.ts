import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpxRenderer, summarizeAcpxStream } from "../lib/acpx-render.ts";

const update = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } });
const STREAM = [
	JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } }),
	JSON.stringify({ jsonrpc: "2.0", id: "1", method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "the task" }] } }),
	update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me look at the cache." } }),
	update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read src/cache.ts", kind: "read", status: "pending" }),
	update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }),
	update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "const entries = ..." } }] }),
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The cache lives in " } }),
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "src/cache.ts." } }),
	update({ sessionUpdate: "usage_update", used: 100, size: 1000 }),
	update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash: npm test", kind: "execute" }),
	update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed" }),
	"not json at all",
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nVERDICT: DONE" } }),
	JSON.stringify({ jsonrpc: "2.0", id: "1", result: { stopReason: "end_turn", usage: { totalTokens: 1 } } }),
].join("\n") + "\n";

test("the renderer shows content and never the transport envelope", () => {
	let out = "";
	const renderer = new AcpxRenderer((piece) => { out += piece; }, { color: false });
	// Feed in uneven chunks to prove line buffering.
	for (let i = 0; i < STREAM.length; i += 37) renderer.push(STREAM.slice(i, i + 37));
	renderer.end();
	for (const envelope of ["jsonrpc", "sessionUpdate", "\"params\"", "agent_message_chunk", "toolCallId", "available_commands_update", "usage_update"]) assert.equal(out.includes(envelope), false, `${envelope} leaked into the pane`);
	assert.match(out, /\u2500\u2500 prompt \u2500\u2500\n/);
	assert.match(out, /Let me look at the cache\.\n/);
	assert.match(out, /\u25b8 read src\/cache\.ts \(read\)\n\u2713 read src\/cache\.ts\n/);
	assert.match(out, /The cache lives in src\/cache\.ts\.\n/);
	assert.match(out, /\u25b8 bash: npm test \(execute\)\n\u2717 bash: npm test\n/);
	assert.match(out, /\| not json at all\n/);
	assert.match(out, /VERDICT: DONE\n\u2500\u2500 end_turn \u2500\u2500\n$/);
	const silent = (() => { let text = ""; const r = new AcpxRenderer((piece) => { text += piece; }, { color: false, thoughts: false }); r.push(STREAM); r.end(); return text; })();
	assert.equal(silent.includes("Let me look"), false);
	const colored = (() => { let text = ""; const r = new AcpxRenderer((piece) => { text += piece; }, { color: true }); r.push(STREAM); r.end(); return text; })();
	assert.match(colored, /\u001b\[2mLet me look at the cache\.\u001b\[0m/);
});

test("the stream summary reports the last activity and counts without deciding anything", () => {
	const summary = summarizeAcpxStream(STREAM, 3);
	assert.equal(summary.lastActivity, "\u2500\u2500 end_turn \u2500\u2500");
	assert.deepEqual(summary.recent.length, 3);
	assert.deepEqual([summary.prompts, summary.toolCalls], [1, 2]);
	assert.equal(summary.textBytes, Buffer.byteLength("The cache lives in src/cache.ts.\n\nVERDICT: DONE"));
	assert.deepEqual(summarizeAcpxStream(""), { lastActivity: null, recent: [], prompts: 0, toolCalls: 0, textBytes: 0 });
	const partial = summarizeAcpxStream(STREAM.split("\n").slice(0, 7).join("\n"));
	assert.equal(partial.lastActivity, "The cache lives in", "a streamed chunk is summarized with trailing space trimmed");
});
