#!/usr/bin/env node
const [mode = "complete", sessionId = "fixture-session"] = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({ jsonrpc: "2.0", id: "req-1", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "harmless fixture task" }] } });
emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture progress" } } } });
process.stderr.write(`fixture-stderr:${process.env.ACPX_SPIKE_MARKER ?? "missing"}\n`);

if (mode === "complete" || mode === "reconnect") emit({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } });
else if (mode === "cancel") emit({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "cancelled" } });
else if (mode === "fail") emit({ jsonrpc: "2.0", id: "req-1", error: { code: -32000, message: "fixture failure" } });
else if (mode === "crash") process.exitCode = 17;
else if (mode !== "no-wait") throw new Error(`unknown fixture mode ${mode}`);
