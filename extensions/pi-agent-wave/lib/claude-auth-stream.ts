/** Adapted from @cgaravitoq/pi-claude-code-auth 2.2.2; see claude-auth-LICENSE. */
/**
 * Anthropic streaming implementation, adapted from pi's
 * examples/extensions/custom-provider-anthropic/index.ts.
 *
 * Hardcoded to OAuth mode since this extension only ever talks to
 * api.anthropic.com with a Claude Code OAuth bearer token.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
 MessageParam, ToolResultBlockParam, Tool as AnthropicTool, ImageBlockParam, TextBlockParam,
	MessageCreateParamsStreaming,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";

import {
	getModelOverride,
	unprefixToolName,
} from "@cgaravitoq/claude-code-core";

import { buildClaudeRequestMetadata, transformClaudeRequest } from "./claude-auth-headers.ts";

// Map pi's ThinkingLevel to a valid Anthropic effort. "minimal" is not an API
// effort level; the API accepts low | medium | high | xhigh | max.
function toEffort(level: NonNullable<SimpleStreamOptions["reasoning"]>) {
	return level === "minimal" ? "low" : level;
}

// Preserve upstream tool-name mapping for responses and conversation replay.
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	const lowerName = name.toLowerCase();
	const matched = tools?.find((t) => t.name.toLowerCase() === lowerName);
	return matched?.name ?? name;
};

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(
	content: (TextContent | ImageContent)[],
): string | Array<TextBlockParam | ImageBlockParam> {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.flatMap((c) => c.type === "text" ? [c.text] : []).join("\n"));
	}

	const blocks: Array<TextBlockParam | ImageBlockParam> = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: imageMimeType(block.mimeType),
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}

	return blocks;
}

function convertMessages(messages: Message[]): MessageParam[] {
	const params: MessageParam[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "image" as const,
								source: { type: "base64" as const, media_type: imageMimeType(item.mimeType), data: item.data },
							},
				);
				if (blocks.length > 0) {
					params.push({ role: "user", content: blocks });
				}
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					// Skip: re-sending thinking blocks fails with claude-code beta because
					// the signature is bound to the original turn and cannot be revalidated.
					continue;
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: toClaudeCodeName(block.name),
						input: block.arguments,
					});
				}
			}
			if (blocks.length === 0) {
				// Preserve role alternation when thinking blocks are stripped.
				// Text must be non-empty: the API rejects empty text blocks with 400.
				blocks.push({ type: "text", text: "(no content)" });
			}
			params.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const toolResults: ToolResultBlockParam[] = [];
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const nextMsg = messages[j];
 if (nextMsg.role !== "toolResult") break;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Add cache control to last user message
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
				lastBlock.cache_control = { type: "ephemeral" };
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): AnthropicTool[] {
 return tools.map(tool => ({
  name: toClaudeCodeName(tool.name), description: tool.description,
  input_schema: { ...tool.parameters, type: "object" },
 }));
}

function imageMimeType(value: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
 if (value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp") return value;
 throw new Error(`Unsupported image MIME type: ${value}`);
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

export function streamClaudeCodeAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let rawStopReason: string | null = null;
			let stopDetails: RefusalStopDetails | null = null;
			const apiKey = options?.apiKey ?? "";

			const metadata = buildClaudeRequestMetadata(model.id);

			const client = new Anthropic({
				baseURL: model.baseUrl,
				apiKey: null,
				authToken: apiKey,
				defaultHeaders: metadata.headers,
			});

			// Build request params
			let params: MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertMessages(context.messages),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			// System prompt with Claude Code identity for OAuth
			params.system = [
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
					cache_control: { type: "ephemeral" },
				},
			];
			if (context.systemPrompt) {
				params.system.push({
					type: "text",
					text: sanitizeSurrogates(context.systemPrompt),
					cache_control: { type: "ephemeral" },
				});
			}

			if (context.tools) {
				params.tools = convertTools(context.tools);
			}

			// Handle thinking/reasoning
			if (options?.reasoning && model.reasoning) {
				if (getModelOverride(model.id)?.adaptiveThinking) {
					// Adaptive-thinking models (Opus 4.8+): manual budget_tokens is
					// rejected with a 400. Thinking depth is driven by effort instead.
					params.thinking = { type: "adaptive" };
					params.output_config = { effort: toEffort(options.reasoning) };
				} else {
					const defaultBudgets: Record<string, number> = {
						minimal: 1024,
						low: 4096,
						medium: 10240,
						high: 20480,
						xhigh: 32768,
						max: 64000,
					};
					const customBudget = options.reasoning === "xhigh" || options.reasoning === "max" ? undefined : options.thinkingBudgets?.[options.reasoning];
					params.thinking = {
						type: "enabled",
						budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
					};
				}
			}

			// Reshape system + tools + messages so Anthropic accepts this as a
			// legitimate Claude Code session (billing header, identity split,
			// move 3rd-party system prompts to user, mcp_<PascalCase> tool names).
			params = transformClaudeRequest(params, metadata);

			const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson?: string })) & {
				index?: number;
				argumentsParseError?: string;
				argumentsParseErrorWarned?: boolean;
			};
			const blocks: Block[] = [];
 output.content = blocks;
			const parseToolCallArguments = (block: Block) => {
				if (block.type !== "toolCall") return;
				// A tool call with no input streams an empty (or whitespace) partialJson;
				// that means "no arguments", not a parse failure. Treat it as {}.
				if (!block.partialJson || !block.partialJson.trim()) {
					block.arguments = {};
					delete block.argumentsParseError;
					return;
				}
				try {
					block.arguments = JSON.parse(block.partialJson);
					delete block.argumentsParseError;
				} catch (err) {
					block.arguments = {};
					block.argumentsParseError = String(err);
					if (!block.argumentsParseErrorWarned) {
						console.warn("Failed to parse tool_use partialJson", {
							id: block.id,
							name: block.name,
							partialJson: block.partialJson.slice(0, 200),
						});
						block.argumentsParseErrorWarned = true;
					}
				}
			};

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						blocks.push({ type: "text", text: "", index: event.index });
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						blocks.push({
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						});
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						// Echoed name is mcp_<PascalCase>; strip the prefix, then resolve
						// to the canonical pi tool name (case-insensitive lookup).
						const stripped = unprefixToolName(event.content_block.name);
						const resolved = fromClaudeCodeName(stripped, context.tools);
						blocks.push({
							type: "toolCall",
							id: event.content_block.id,
							name: resolved,
							arguments: {},
							partialJson: "",
							index: event.index,
						});
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						// Accumulate only; partial JSON is not valid mid-stream. Parse once
						// at content_block_stop to avoid spurious parse failures.
						block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					delete block.index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						parseToolCallArguments(block);
						delete block.partialJson;
						delete block.argumentsParseErrorWarned;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_details) stopDetails = event.delta.stop_details;
					if (event.delta.stop_reason) {
						rawStopReason = event.delta.stop_reason;
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					if (typeof event.usage.output_tokens === "number") {
						output.usage.output = event.usage.output_tokens;
					}
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (output.stopReason === "error" || output.stopReason === "aborted" || output.stopReason === "pending") {
				if (rawStopReason === "refusal") {
					const category = stopDetails?.category ? ` (category: ${stopDetails.category})` : "";
					throw new Error(`${model.id} stopped with refusal${category}: ${stopDetails?.explanation?.trim() || "The server supplied no explanation."}`);
				}
				throw new Error(`${model.id} returned unsupported stop_reason: ${JSON.stringify(rawStopReason)}`);
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
