import { parseAcpxState, type AcpxState } from "./acpx-types.ts";

interface AcpxEventBase {
	readonly sessionId: string | null;
	readonly requestId: string | null;
	readonly raw: Readonly<Record<string, unknown>>;
}

export type AcpxLifecycleEvent =
	| (AcpxEventBase & { readonly kind: "started" })
	| (AcpxEventBase & { readonly kind: "progress"; readonly updateType: string })
	| (AcpxEventBase & { readonly kind: "completed"; readonly stopReason: "end_turn" })
	| (AcpxEventBase & { readonly kind: "cancelled"; readonly stopReason: string })
	| (AcpxEventBase & { readonly kind: "failed"; readonly message: string });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectProperty(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return isRecord(value) ? value : null;
}

function stringProperty(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function requestId(record: Record<string, unknown>): string | null {
	const value = record.id;
	return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Parses strict ACP JSON-RPC into lifecycle events without using free text as a success signal. */
export function parseAcpxNdjson(ndjson: string): AcpxLifecycleEvent[] {
	const events: AcpxLifecycleEvent[] = [];
	const sessions = new Map<string, string>();
	for (const [index, line] of ndjson.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`invalid ACPX NDJSON at line ${index + 1}`);
		}
		if (!isRecord(parsed)) throw new Error(`invalid ACPX JSON-RPC object at line ${index + 1}`);
		const id = requestId(parsed);
		const method = stringProperty(parsed, "method");
		if (method === "session/prompt") {
			const params = objectProperty(parsed, "params");
			const sessionId = params ? stringProperty(params, "sessionId") : null;
			if (!id || !sessionId) throw new Error(`invalid ACPX session/prompt at line ${index + 1}`);
			sessions.set(id, sessionId);
			events.push(Object.freeze({ kind: "started", sessionId, requestId: id, raw: parsed }));
			continue;
		}
		if (method === "session/update" || method === "session/cancel") {
			const params = objectProperty(parsed, "params");
			const update = params ? objectProperty(params, "update") : null;
			const sessionId = params ? stringProperty(params, "sessionId") : null;
			const updateType = method === "session/cancel" ? "session/cancel" : update ? stringProperty(update, "sessionUpdate") : null;
			if (!sessionId || !updateType) throw new Error(`invalid ACPX ${method} at line ${index + 1}`);
			events.push(Object.freeze({ kind: "progress", sessionId, requestId: id, updateType, raw: parsed }));
			continue;
		}
		const error = objectProperty(parsed, "error");
		if (error) {
			events.push(Object.freeze({ kind: "failed", sessionId: id ? sessions.get(id) ?? null : null, requestId: id, message: stringProperty(error, "message") ?? "ACPX JSON-RPC error", raw: parsed }));
			continue;
		}
		const result = objectProperty(parsed, "result");
		const stopReason = result ? stringProperty(result, "stopReason") : null;
		if (!stopReason || !id) continue;
		const sessionId = sessions.get(id) ?? null;
		if (stopReason === "end_turn") events.push(Object.freeze({ kind: "completed", sessionId, requestId: id, stopReason, raw: parsed }));
		else if (stopReason.toLowerCase().includes("cancel")) events.push(Object.freeze({ kind: "cancelled", sessionId, requestId: id, stopReason, raw: parsed }));
		else events.push(Object.freeze({ kind: "failed", sessionId, requestId: id, message: `unsupported ACPX stop reason: ${stopReason}`, raw: parsed }));
	}
	return events;
}

/** Parses the tested ACPX status envelope and rejects version-incompatible states. */
export function parseAcpxStatus(json: string): AcpxState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("invalid ACPX status JSON");
	}
	if (!isRecord(parsed) || parsed.action !== "status_snapshot") throw new Error("invalid ACPX status envelope");
	return parseAcpxState(parsed.status);
}

const STRUCTURAL_STRING_KEYS = new Set(["jsonrpc", "method", "sessionUpdate", "type", "stopReason", "action", "status"]);

function sanitizedId(value: string | number, identifiers: Map<string, string>): string {
	const key = String(value);
	const existing = identifiers.get(key);
	if (existing) return existing;
	const replacement = `request-${identifiers.size + 1}`;
	identifiers.set(key, replacement);
	return replacement;
}

function sanitizeValue(value: unknown, key: string | null, identifiers: Map<string, string>): unknown {
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, null, identifiers));
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			if (childKey === "_meta") continue;
			result[childKey] = sanitizeValue(childValue, childKey, identifiers);
		}
		return result;
	}
	if (key === "id" && (typeof value === "string" || typeof value === "number")) return sanitizedId(value, identifiers);
	if (key === "sessionId" && typeof value === "string") return "session-redacted";
	if (typeof value === "string" && !STRUCTURAL_STRING_KEYS.has(key ?? "")) return "<redacted>";
	return value;
}

/** Removes metadata, paths, identifiers, and free text while retaining lifecycle structure. */
export function sanitizeAcpxNdjson(ndjson: string): string {
	const identifiers = new Map<string, string>();
	const lines: string[] = [];
	for (const [index, line] of ndjson.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`invalid ACPX NDJSON at line ${index + 1}`);
		}
		if (!isRecord(parsed)) throw new Error(`invalid ACPX JSON-RPC object at line ${index + 1}`);
		lines.push(JSON.stringify(sanitizeValue(parsed, null, identifiers)));
	}
	return `${lines.join("\n")}\n`;
}
