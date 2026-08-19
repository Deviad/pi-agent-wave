import { readJsonc } from "./jsonc.mjs";

export const MODEL_FAILOVER_RETRY = "HTTP 429 MODEL_FAILOVER_RETRY";
export const MODEL_FAILOVER_TRANSPORT_RETRY = "HTTP 503 MODEL_FAILOVER_RETRY";
export const MODEL_FAILOVER_BLOCKED = "MODEL_FAILOVER_BLOCKED";

const MODEL_PATTERN = /^[A-Za-z0-9._+-]+\/[A-Za-z0-9._:+-]+$/;
const STRUCTURED_KEYS = new Set(["type", "code", "error"]);
const TERMINAL_STRUCTURED = new Set([
	"invalid_request", "invalid_request_error", "invalid_schema", "schema_error", "validation_error",
	"invalid_argument", "invalid_parameter", "authentication", "authentication_error", "auth_error",
	"authorization", "authorization_error", "unauthorized", "forbidden", "invalid_api_key",
	"permission_denied", "access_denied", "not_authorized", "permission_denied_error", "access_denied_error",
	"billing", "billing_error", "payment_required", "refusal", "content_refusal", "policy_refusal",
	"policy_violation", "safety_refusal", "cancellation", "cancelled", "canceled", "abort", "aborted",
	"context_overflow", "context_window_exceeded", "context_length_exceeded", "tool_error", "tool_failure",
	"tool_result", "tool_use", "acceptance_quality", "acceptance_quality_rejection", "quality_rejection",
	"review_rejection",
]);
const QUOTA_CODES = new Set([
	"gousagelimiterror", "freeusagelimiterror", "monthly_usage_limit_reached", "insufficient_quota",
	"out_of_budget", "quota_exceeded",
]);
const ORDINARY_STATUS = new Set([429, 500, 502, 503, 504]);

function modelKey(model) {
	return model && typeof model.provider === "string" && typeof model.id === "string"
		? `${model.provider}/${model.id}`
		: "";
}

function normalizeSignal(value) {
	return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function collectStructuredValues(value, values = [], seen = new Set(), parentKey = "") {
	if (value === null || value === undefined) return values;
	if (typeof value !== "object") {
		if (STRUCTURED_KEYS.has(parentKey)) values.push(String(value));
		return values;
	}
	if (seen.has(value)) return values;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectStructuredValues(item, values, seen, parentKey);
		return values;
	}
	for (const [key, child] of Object.entries(value)) {
		collectStructuredValues(child, values, seen, key);
	}
	return values;
}

function structuredTerminal(values) {
	return values.some((value) => {
		const normalized = normalizeSignal(value);
		return TERMINAL_STRUCTURED.has(normalized) || /(?:^|_)(invalid_request|schema|validation|authentication|authorization|billing|refusal|policy|cancellation|cancelled|canceled|abort|context|tool|acceptance|quality|review)(?:_|$)/.test(normalized);
	});
}

function structuredQuota(values) {
	return values.some((value) => QUOTA_CODES.has(normalizeSignal(value)));
}

function structuredConnectionClosed(values) {
	return values.some((value) => normalizeSignal(value) === "connection_closed");
}

function statusCode(text) {
	const match = text.match(/\bHTTP\s+(\d{3})\b/i) ?? text.match(/\bstatus(?:\s*code)?\s*[=:]?\s*(\d{3})\b/i);
	return match ? Number(match[1]) : undefined;
}

function exactQuotaText(text) {
	const normalized = normalizeSignal(text);
	if (QUOTA_CODES.has(normalized)) return true;
	return /^HTTP\s+429\s+(?:GoUsageLimitError|FreeUsageLimitError):\s+Monthly usage limit reached$/i.test(text);
}

function terminalCategory(text, status) {
	if ([401, 403, 404].includes(status)) return "terminal";
	if (/\b(?:invalid\s+(?:request|schema|argument|parameter|api\s*key)|schema\s+(?:error|invalid)|validation\s+error|context\s+(?:window\s+)?overflow|cancel(?:led|lation)|abort(?:ed)?|content\s+refusal|policy\s+(?:refusal|violation)|safety\s+(?:refusal|block)|tool\s+(?:failure|error|result|use)|acceptance[- ]quality|review\s+rejection|authentication\s+(?:failed|error)|authorization\s+(?:failed|error)|permission\s+denied|access\s+denied|not\s+authorized|invalid\s+(?:api[- ]?key|credential)|\bbilling\b)\b/i.test(text)) {
		return "terminal";
	}
	return undefined;
}

function ordinaryCategory(text, status) {
	return ORDINARY_STATUS.has(status) || /\b(?:timeout|timed out|dns resolution failed|connection reset|connection refused)\b/i.test(text);
}

export function parseFailoverRoute(raw) {
	if (typeof raw !== "string") throw new TypeError("failover route must be a string");
	const entries = raw.split(",").map((entry) => entry.trim());
	if (!entries.length || entries.some((entry) => !MODEL_PATTERN.test(entry))) throw new Error("invalid failover route");
	if (new Set(entries).size !== entries.length) throw new Error("duplicate failover route entry");
	return entries;
}

export function loadTierRoute(configFile, tier) {
	if (typeof configFile !== "string" || typeof tier !== "string" || !tier.trim()) throw new Error("invalid failover tier");
	const config = readJsonc(configFile);
	const models = config?.tiers?.[tier]?.models;
	if (!Array.isArray(models)) throw new Error(`unknown failover tier: ${tier}`);
	return parseFailoverRoute(models.join(","));
}

export function classifyFailoverError(message, native = {}) {
	if (!message || message.role !== "assistant" || message.stopReason !== "error" || typeof message.errorMessage !== "string" || !message.errorMessage.trim()) {
		return { kind: "none", category: "none", statusCode: undefined, sourceRetryable: false };
	}
	const text = message.errorMessage.trim();
	const responseStatus = Number.isInteger(native.responseStatus) ? native.responseStatus : undefined;
	const status = responseStatus ?? statusCode(text);
	const structured = collectStructuredValues(message);
	const quota = exactQuotaText(text) || structuredQuota(structured);
	const sourceRetryable = Boolean(native.isRetryableAssistantError?.(message));
	if (status === 429) {
		return {
			kind: quota ? "quota" : "ordinary",
			category: quota ? "quota" : "rate-limit",
			statusCode: status,
			sourceRetryable,
		};
	}
	if (structuredTerminal(structured) || native.isContextOverflow?.(message, native.contextWindow ?? 0) || terminalCategory(text, status)) {
		return { kind: "terminal", category: "terminal", statusCode: status, sourceRetryable: false };
	}
	if (sourceRetryable && ordinaryCategory(text, status)) {
		return { kind: "ordinary", category: "provider", statusCode: status, sourceRetryable: true };
	}
	if (!sourceRetryable && quota) {
		return { kind: "quota", category: "quota", statusCode: status, sourceRetryable: false };
	}
	const literalConnectionClosed = text.replace(/\s+/g, " ").trim().toLowerCase() === "connection closed";
	if (!sourceRetryable && (literalConnectionClosed || structuredConnectionClosed(structured))) {
		return { kind: "connection-closed", category: "transport", statusCode: status, sourceRetryable: false };
	}
	return { kind: "terminal", category: "terminal", statusCode: status, sourceRetryable };
}

export function findNextFailoverCandidate({ route, cursor, currentModel, excludedProviders, modelRegistry }) {
	const currentKey = modelKey(currentModel);
	for (let index = cursor + 1; index < route.length; index++) {
		const key = route[index];
		const slash = key.indexOf("/");
		const provider = key.slice(0, slash);
		if (key === currentKey || excludedProviders?.has(provider)) continue;
		const model = modelRegistry?.find?.(provider, key.slice(slash + 1));
		if (!model || modelKey(model) !== key) continue;
		if (modelRegistry.hasConfiguredAuth && !modelRegistry.hasConfiguredAuth(model)) continue;
		return { model, index };
	}
	return undefined;
}

export function sanitizeAssistantError(message, marker) {
	return {
		role: "assistant",
		content: [],
		api: message?.api,
		provider: message?.provider,
		model: message?.model,
		usage: message?.usage,
		stopReason: "error",
		errorMessage: marker,
		timestamp: message?.timestamp,
	};
}
