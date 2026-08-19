import { readFileSync } from "node:fs";
import { isLocalModel, isLoopbackBaseUrl } from "../scripts/policy-resolver.mjs";

export { isLocalModel, isLoopbackBaseUrl };

/** Provider/catalog fields that may carry credentials and must never be printed. */
export const SENSITIVE_FIELDS = Object.freeze([
	"apiKey",
	"api_key",
	"apiToken",
	"api_token",
	"token",
	"accessToken",
	"access_token",
	"refreshToken",
	"refresh_token",
	"secret",
	"clientSecret",
	"client_secret",
	"password",
	"authorization",
	"credentials",
	"authToken",
	"auth_token",
]);

/**
 * Read the provider catalog (plain JSON). Unlike the resolver's loadModels, a
 * missing or malformed file throws so the initializer can fail closed rather
 * than silently treating an invalid catalog as empty.
 */
export function loadCatalog(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`cannot read model catalog '${path}': ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`invalid model catalog JSON '${path}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Derive selectable model identifiers strictly from providers.<provider>.models[].id.
 *
 * Returns the canonical `provider/id` list plus two distinct diagnostic buckets:
 * - `problems` carries only catalog-level corruption (no providers object), which
 *   is fatal to both init and doctor.
 * - `warnings` carries per-provider/per-model quirks — slashed ids (HF-style local
 *   ids such as `Deviad/DeepSeek-V4-Flash-MLX-Q4Q8`), duplicate identifiers, and
 *   missing/empty ids. Those models are excluded from selection with a warning,
 *   never aborted: the rest of a real catalog remains selectable.
 */
export function analyzeCatalog(catalog) {
	const providers = catalog && typeof catalog === "object" && !Array.isArray(catalog) ? catalog.providers : null;
	if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
		return { selectable: [], problems: ["catalog has no providers object"], warnings: [], byModelId: new Map(), providers: {} };
	}
	const selectable = [];
	const problems = [];
	const warnings = [];
	const byModelId = new Map();
	for (const [providerName, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
			warnings.push(`provider '${providerName}' is not an object; skipped`);
			continue;
		}
		const models = Array.isArray(provider.models) ? provider.models : [];
		for (const model of models) {
			const id = model?.id;
			if (typeof id !== "string" || id.trim() === "") {
				warnings.push(`provider '${providerName}' has a model with a missing or empty id; excluded from selection`);
				continue;
			}
			if (id.includes("/")) {
				warnings.push(`provider '${providerName}' model id '${id}' contains '/'; excluded from selection`);
				continue;
			}
			const modelId = `${providerName}/${id}`;
			if (byModelId.has(modelId)) {
				warnings.push(`duplicate model identifier '${modelId}'; excluded from selection`);
				continue;
			}
			const entry = { provider: providerName, id, modelId, name: model?.name, contextWindow: model?.contextWindow };
			byModelId.set(modelId, entry);
			selectable.push(entry);
		}
	}
	return { selectable, problems, warnings, byModelId, providers };
}

export function listSelectableModels(catalog) {
	return analyzeCatalog(catalog).selectable;
}

/** Deep-copy a catalog while replacing any credential-bearing field with a sentinel. */
export function redactCatalog(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(redactCatalog);
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		out[key] = SENSITIVE_FIELDS.includes(key) ? "[redacted]" : redactCatalog(entry);
	}
	return out;
}
