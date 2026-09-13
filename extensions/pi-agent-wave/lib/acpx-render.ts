/**
 * Renders the ACPX JSON-RPC stream a worker produces (`--format json --json-strict`) as the content a person
 * watching the worker wants to see: assistant text as it streams, thoughts dimmed, one line per tool call,
 * short separators for turn boundaries. The JSON stream itself is never altered: settlement reads the retained
 * files, this only shapes what reaches a Herdr pane or a watch summary. Nothing here is a success signal.
 */

export interface AcpxRenderOptions {
	/** ANSI dimming for thoughts and separators; off for files and summaries. */
	readonly color?: boolean;
	/** Show agent thoughts (dimmed). Default true. */
	readonly thoughts?: boolean;
}

export interface RenderState {
	mode: "text" | "thought" | null;
	readonly tools: Map<string, string>;
	prompts: number;
	toolCalls: number;
	textBytes: number;
	carry: string;
}

const DIM = "[2m";
const RESET = "[0m";
const MARK_CALL = "▸"; // ▸
const MARK_DONE = "✓"; // ✓
const MARK_FAIL = "✗"; // ✗
const RULE = "──"; // ──
const ELLIPSIS = "…";

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function contentText(content: unknown): string {
	if (isRecord(content)) {
		if (content.type === "text") return text(content.text);
		if (content.type === "resource" && isRecord(content.resource)) return text(content.resource.text) || `[resource ${text(content.resource.uri)}]`;
		if (content.type === "image") return "[image]";
		if (content.type === "audio") return "[audio]";
		if (content.type === "resource_link") return `[${text(content.title) || text(content.uri)}]`;
	}
	if (Array.isArray(content)) return content.map(contentText).join("");
	return "";
}

export function createRenderState(): RenderState {
	return { mode: null, tools: new Map(), prompts: 0, toolCalls: 0, textBytes: 0, carry: "" };
}

/** Ends a streamed text or thought run with a newline so the next block starts on its own line. */
function leave(state: RenderState): string {
	if (state.mode === null) return "";
	state.mode = null;
	return "\n";
}

/** Renders one complete stream line; returns the text to show (possibly empty, or without a trailing newline for a streamed chunk). */
export function renderAcpxLine(line: string, state: RenderState, options: AcpxRenderOptions = {}): string {
	const dim = (value: string) => options.color ? `${DIM}${value}${RESET}` : value;
	const trimmed = line.replace(/\r$/, "");
	if (!trimmed.trim()) return "";
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch { return `${leave(state)}| ${trimmed}\n`; }
	if (!isRecord(parsed)) return "";
	const method = text(parsed.method);
	const params = isRecord(parsed.params) ? parsed.params : {};
	if (method === "session/update") {
		const update = isRecord(params.update) ? params.update : {};
		const kind = text(update.sessionUpdate);
		if (kind === "agent_message_chunk") {
			const chunk = contentText(update.content);
			if (!chunk) return "";
			state.textBytes += Buffer.byteLength(chunk);
			const prefix = state.mode === "text" ? "" : leave(state);
			state.mode = "text";
			return prefix + chunk;
		}
		if (kind === "agent_thought_chunk") {
			if (options.thoughts === false) return "";
			const chunk = contentText(update.content);
			if (!chunk) return "";
			const prefix = state.mode === "thought" ? "" : leave(state);
			state.mode = "thought";
			return prefix + dim(chunk);
		}
		if (kind === "tool_call") {
			state.toolCalls += 1;
			const id = text(update.toolCallId);
			const title = text(update.title) || text(update.kind) || "tool";
			if (id) state.tools.set(id, title);
			const status = text(update.status);
			const mark = status === "completed" ? MARK_DONE : status === "failed" ? MARK_FAIL : MARK_CALL;
			const kindLabel = text(update.kind);
			return `${leave(state)}${mark} ${title}${kindLabel && kindLabel !== title ? ` (${kindLabel})` : ""}\n`;
		}
		if (kind === "tool_call_update") {
			const id = text(update.toolCallId);
			const title = text(update.title) || state.tools.get(id) || "tool";
			if (id && update.title) state.tools.set(id, title);
			const status = text(update.status);
			if (status === "completed") return `${leave(state)}${MARK_DONE} ${title}\n`;
			if (status === "failed") return `${leave(state)}${MARK_FAIL} ${title}\n`;
			return "";
		}
		if (kind === "plan") {
			const entries = Array.isArray(update.entries) ? update.entries : [];
			const done = entries.filter((entry) => isRecord(entry) && entry.status === "completed").length;
			return `${leave(state)}${dim(`plan: ${done}/${entries.length} steps`)}\n`;
		}
		// user_message_chunk echoes the prompt; the rest is adapter bookkeeping (available_commands_update,
		// config_option_update, session_info_update, usage_update, current_mode_update, _auth/status_update).
		return "";
	}
	if (method === "session/prompt") {
		state.prompts += 1;
		return `${leave(state)}${dim(`${RULE} prompt ${RULE}`)}\n`;
	}
	if (method === "session/cancel") return `${leave(state)}${dim(`${RULE} cancel requested ${RULE}`)}\n`;
	if (method === "session/request_permission") {
		const call = isRecord(params.toolCall) ? params.toolCall : {};
		return `${leave(state)}? permission: ${text(call.title) || text(call.toolCallId) || "tool"}\n`;
	}
	if (method) return "";
	if ("result" in parsed) {
		const result = isRecord(parsed.result) ? parsed.result : {};
		const stop = text(result.stopReason);
		return stop ? `${leave(state)}${dim(`${RULE} ${stop} ${RULE}`)}\n` : "";
	}
	if (isRecord(parsed.error)) return `${leave(state)}${MARK_FAIL} ${text(parsed.error.message) || "error"}\n`;
	return "";
}

/** Streaming renderer: feed raw bytes as they arrive; complete lines render at once, the tail waits for its newline. */
export class AcpxRenderer {
	private readonly state = createRenderState();
	private readonly write: (text: string) => void;
	private readonly options: AcpxRenderOptions;
	constructor(write: (text: string) => void, options: AcpxRenderOptions = {}) { this.write = write; this.options = options; }
	push(bytes: Buffer | string): void {
		const chunk = this.state.carry + (typeof bytes === "string" ? bytes : bytes.toString("utf8"));
		const lines = chunk.split("\n");
		this.state.carry = lines.pop() ?? "";
		for (const line of lines) {
			const rendered = renderAcpxLine(line, this.state, this.options);
			if (rendered) this.write(rendered);
		}
	}
	end(): void {
		if (this.state.carry) {
			const rendered = renderAcpxLine(this.state.carry, this.state, this.options);
			this.state.carry = "";
			if (rendered) this.write(rendered);
		}
		const tail = leave(this.state);
		if (tail) this.write(tail);
	}
}

export interface AcpxStreamSummary {
	/** The last rendered line, truncated; null when nothing renderable arrived yet. */
	readonly lastActivity: string | null;
	/** The most recent rendered lines, oldest first. */
	readonly recent: readonly string[];
	readonly prompts: number;
	readonly toolCalls: number;
	readonly textBytes: number;
}

/** Summarizes a captured stream for a watch view; pure and bounded, never a decision input. */
export function summarizeAcpxStream(stream: string, recentLimit = 5, lineLimit = 160): AcpxStreamSummary {
	const state = createRenderState();
	let buffer = "";
	for (const line of stream.split("\n")) buffer += renderAcpxLine(line, state, { color: false });
	buffer += leave(state);
	const lines = buffer.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0)
		.map((line) => line.length > lineLimit ? `${line.slice(0, lineLimit - 1)}${ELLIPSIS}` : line);
	return { lastActivity: lines.at(-1) ?? null, recent: lines.slice(-recentLimit), prompts: state.prompts, toolCalls: state.toolCalls, textBytes: state.textBytes };
}
