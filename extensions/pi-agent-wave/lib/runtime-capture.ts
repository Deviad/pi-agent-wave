export interface RuntimeCaptureIdentity {
	readonly attemptKey: string;
	readonly sessionId: string;
	readonly requestId: string;
}

export interface RuntimeCaptureSource extends RuntimeCaptureIdentity {
	readonly eventIndex: number;
	readonly chunkIndex: number;
}

export type RuntimeSessionOrigin = "expected" | "loaded" | "created" | "resumed";

export interface RuntimeCaptureSummary {
	readonly requestId: string | null;
	/** ACP session id the captured prompt actually ran in; may differ from the ensured id. */
	readonly sessionId: string | null;
	readonly sessionOrigin: RuntimeSessionOrigin | null;
	readonly captureStatus: "complete" | "incomplete" | "empty";
	readonly responseCompleteness: "unverified";
	readonly inputBytes: number;
	readonly answerBytes: number;
	readonly publicChunks: number;
	readonly ignoredEvents: number;
	readonly peakBufferedBytes: number;
	readonly diagnostics: readonly string[];
}

interface CaptureLimits {
	readonly maxEventBytes: number;
	readonly maxTotalBytes: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): string | null {
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/**
 * Captures public text inside one observed prompt boundary. ACP notifications lack request IDs,
 * so attribution requires a single active matching prompt. The stream is one exclusive acpx prompt
 * process, and the ACP session id inside it is not stable across adapters (2026-09-12 evidence):
 * Pi loads the ensured session, while Codex and Claude cannot resume, so acpx creates a fresh
 * session on the first prompt and reconnects to the live agent on later ones. The session is
 * therefore bound from the stream itself and its origin is recorded. Final-answer semantics remain
 * unverified until each actual adapter has been proved; this helper alone never authorizes completion.
 */
export class RuntimePublicCapture {
	private readonly identity: Omit<RuntimeCaptureIdentity, "requestId">;
	private boundRequestId: string | null;
	private boundSessionId: string | null = null;
	private sessionOrigin: RuntimeSessionOrigin | null = null;
	private pendingSessionRequest: string | null = null;
	private readonly sink: (text: string, source: RuntimeCaptureSource) => void;
	private readonly limits: CaptureLimits;
	private readonly buffer: Buffer;
	private buffered = 0;
	private peakBufferedBytes = 0;
	private inputBytes = 0;
	private answerBytes = 0;
	private hasAnswerText = false;
	private publicChunks = 0;
	private ignoredEvents = 0;
	private eventIndex = 0;
	private active = false;
	private started = false;
	private completed = false;
	private halted = false;
	private discardingLine = false;
	private readonly diagnostics = new Set<string>();
	private summary: RuntimeCaptureSummary | undefined;

	constructor(identity: Omit<RuntimeCaptureIdentity, "requestId"> & { requestId: string | null }, sink: (text: string, source: RuntimeCaptureSource) => void, limits: CaptureLimits = { maxEventBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 }) {
		for (const value of Object.values(identity)) if (value !== null && !value.trim()) throw new Error("capture identity must be nonempty");
		for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("capture limits must be positive integers");
		if (limits.maxEventBytes > 16 * 1024 * 1024 || limits.maxTotalBytes > 1024 * 1024 * 1024) throw new Error("capture limits exceed private storage bounds");
		this.identity = { attemptKey: identity.attemptKey, sessionId: identity.sessionId };
		this.boundRequestId = identity.requestId;
		this.sink = sink;
		this.limits = { ...limits };
		this.buffer = Buffer.alloc(limits.maxEventBytes);
	}

	write(chunk: Buffer): void {
		if (this.summary) throw new Error("capture is finished");
		if (this.halted) return;
		const allowed = Math.min(chunk.length, this.limits.maxTotalBytes - this.inputBytes);
		this.inputBytes += allowed;
		let offset = 0;
		while (offset < allowed) {
			const newline = chunk.indexOf(10, offset);
			const end = newline >= 0 && newline < allowed ? newline : allowed;
			const length = end - offset;
			if (!this.discardingLine) {
				if (length > this.buffer.length - this.buffered) {
					this.diagnostics.add("event-limit");
					this.discardingLine = true;
					this.buffered = 0;
				} else {
					chunk.copy(this.buffer, this.buffered, offset, end);
					this.buffered += length;
					this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.buffered);
				}
			}
			if (end < allowed) {
				if (!this.discardingLine) this.line();
				this.buffered = 0;
				this.discardingLine = false;
			}
			offset = end + 1;
		}
		if (allowed < chunk.length) {
			this.diagnostics.add("total-limit");
			this.halted = true;
		}
	}

	private line(): void {
		if (!this.buffered) return;
		let event: unknown;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, this.buffered));
			if (!text.trim()) return;
			event = JSON.parse(text);
		} catch {
			this.diagnostics.add("malformed-event");
			return;
		}
		this.eventIndex++;
		if (!record(event) || event.jsonrpc !== "2.0") { this.diagnostics.add("invalid-envelope"); return; }
		const id = requestId(event.id);
		const params = record(event.params) ? event.params : null;
		if (event.method === "session/load") {
			this.bindSession(typeof params?.sessionId === "string" ? params.sessionId : null, "loaded");
			return;
		}
		if (event.method === "session/new") {
			if (id === null || this.started) { this.diagnostics.add("ambiguous-session"); return; }
			this.pendingSessionRequest = id;
			return;
		}
		if (id !== null && id === this.pendingSessionRequest && event.method === undefined) {
			this.pendingSessionRequest = null;
			const result = record(event.result) ? event.result : null;
			this.bindSession(typeof result?.sessionId === "string" ? result.sessionId : null, "created");
			return;
		}
		if (event.method === "session/prompt") {
			if (typeof params?.sessionId !== "string" || !params.sessionId) { this.diagnostics.add("ambiguous-session"); return; }
			if (this.boundSessionId === null) this.bindSession(params.sessionId, params.sessionId === this.identity.sessionId ? "expected" : "resumed");
			else if (params.sessionId !== this.boundSessionId) { this.diagnostics.add("ambiguous-prompt"); this.active = false; return; }
			if (this.started || id === null || (this.boundRequestId !== null && id !== this.boundRequestId)) {
				this.diagnostics.add("ambiguous-prompt");
				this.active = false;
				return;
			}
			this.boundRequestId = id;
			this.started = true;
			this.active = true;
			return;
		}
		if (event.method === "session/update") {
			const session = this.boundSessionId ?? this.identity.sessionId;
			if (params?.sessionId !== session || (id !== null && id !== this.boundRequestId)) { this.ignoredEvents++; return; }
			const update = record(params.update) ? params.update : null;
			if (update?.sessionUpdate !== "agent_message_chunk") { this.ignoredEvents++; return; }
			if (!this.active) { this.diagnostics.add("output-outside-prompt"); return; }
			const content = record(update.content) ? update.content : null;
			if (content?.type !== "text" || typeof content.text !== "string") { this.diagnostics.add("unsupported-public-content"); return; }
			if (!content.text) return;
			if (this.boundRequestId === null) throw new Error("public output has no bound request");
			try { this.sink(content.text, { attemptKey: this.identity.attemptKey, sessionId: session, requestId: this.boundRequestId, eventIndex: this.eventIndex, chunkIndex: this.publicChunks }); }
			catch (error) { this.halted = true; this.diagnostics.add("essential-sink-failure"); throw error; }
			this.publicChunks++;
			this.answerBytes += Buffer.byteLength(content.text);
			this.hasAnswerText ||= content.text.trim().length > 0;
			return;
		}
		if (id !== this.boundRequestId) { this.ignoredEvents++; return; }
		const result = record(event.result) ? event.result : null;
		if (event.error !== undefined || result?.stopReason !== undefined) {
			if (!this.active) { this.diagnostics.add("terminal-outside-prompt"); return; }
			this.active = false;
			this.completed = event.error === undefined && result?.stopReason === "end_turn";
			if (!this.completed) this.diagnostics.add("non-completed-turn");
		}
	}

	/** One session per exclusive prompt process; a loaded session must be the ensured one. */
	private bindSession(sessionId: string | null, origin: RuntimeSessionOrigin): void {
		if (sessionId === null || !sessionId || this.boundSessionId !== null || this.started) { this.diagnostics.add("ambiguous-session"); return; }
		if (origin === "loaded" && sessionId !== this.identity.sessionId) { this.diagnostics.add("session-mismatch"); return; }
		this.boundSessionId = sessionId;
		this.sessionOrigin = origin;
	}

	finish(): RuntimeCaptureSummary {
		if (this.summary) return this.summary;
		if (this.buffered && !this.halted && !this.discardingLine) this.line();
		if (!this.completed) this.diagnostics.add("missing-completion");
		this.summary = Object.freeze({
			requestId: this.boundRequestId, sessionId: this.boundSessionId, sessionOrigin: this.sessionOrigin,
			captureStatus: this.diagnostics.size ? "incomplete" : this.hasAnswerText ? "complete" : "empty",
			responseCompleteness: "unverified", inputBytes: this.inputBytes, answerBytes: this.answerBytes,
			publicChunks: this.publicChunks, ignoredEvents: this.ignoredEvents, peakBufferedBytes: this.peakBufferedBytes,
			diagnostics: Object.freeze([...this.diagnostics]),
		});
		return this.summary;
	}
}
