import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type ToolCall } from "@earendil-works/pi-ai";

function record(value: unknown) {
	if (process.env.FAKE_SUPERVISOR_LOG) appendFileSync(process.env.FAKE_SUPERVISOR_LOG, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamSimple(model: Model<Api>, context: Context) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	let reply = "FAKE_SUPERVISOR_IDLE";
	let call: ToolCall | undefined;
	const messages = context.messages;
	let userIndex = messages.length - 1;
	while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex--;
	const user = messages[userIndex];
	const userText = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
	const contract = /Delegate Graph run (\S+) started for:/;
	const priorContract = [...messages].reverse().find((message) => message.role === "user" && contract.test(typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
	const collect = /^collect (\S+) (\S+)$/.exec(userText);
	const runId = contract.exec(userText)?.[1] ?? collect?.[1] ?? (userText === "dispatch next" && priorContract ? contract.exec(typeof priorContract.content === "string" ? priorContract.content : JSON.stringify(priorContract.content))?.[1] : undefined);
	const last = messages.at(-1);
	const emit = (args: Record<string, unknown>) => {
		call = { type: "toolCall", id: `fake_${messages.length}_${args.op}`, name: "delegate_graph", arguments: args };
		record({ kind: "toolCall", ...call });
	};
	if (last?.role === "toolResult") {
		const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const matchingCall = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []).find((part) => part.id === last.toolCallId);
		record({ kind: "toolResult", toolCallId: last.toolCallId, arguments: matchingCall?.arguments, text: text.slice(0, 4096), isError: last.isError });
		if (matchingCall?.name === "delegate_graph" && runId) {
			try {
				const result: unknown = JSON.parse(text);
				if (!isRecord(result) || last.isError) throw new Error(text);
				if (matchingCall.arguments.op === "next") {
					const operation = Array.isArray(result.operations) ? result.operations.find((entry: unknown) => isRecord(entry) && entry.status === "pending") : undefined;
					if (!isRecord(operation) || typeof operation.id !== "string") throw new Error("no pending operation");
					emit({ op: "dispatch", runId, operationId: operation.id });
				} else if (matchingCall.arguments.op === "dispatch") {
					reply = result.dispatched === false || result.blocked ? `FAKE_SUPERVISOR_BLOCKED ${result.blocked}: ${result.reason ?? "unspecified"}` : `FAKE_SUPERVISOR_DISPATCHED ${matchingCall.arguments.operationId}`;
				} else if (matchingCall.arguments.op === "collect") {
					reply = `FAKE_SUPERVISOR_COLLECTED ${matchingCall.arguments.operationId}`;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reply = matchingCall.arguments.op === "collect" ? `FAKE_SUPERVISOR_COLLECT_FAILED ${message}` : `FAKE_SUPERVISOR_BLOCKED ${message}`;
			}
		}
	} else if (runId && !messages.slice(userIndex + 1).some((message) => message.role === "toolResult")) {
		if (collect) emit({ op: "collect", runId, operationId: collect[2] });
		else emit({ op: "next", runId });
	}
	stream.push({ type: "start", partial: output });
	if (call) {
		output.content.push(call);
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
		stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: output });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
		output.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: output });
	} else {
		output.content.push({ type: "text", text: reply });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
	}
	stream.end();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("fake-e2e", {
		baseUrl: "http://127.0.0.1:1", apiKey: "fake", api: "fake-e2e-api",
		models: [{ id: "scripted", name: "Scripted supervisor", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		streamSimple,
	});
}
