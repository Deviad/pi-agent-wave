#!/usr/bin/env node
// scripts/policy-resolver.mjs — shared model-policy resolver for Delegate Graph.
//
// Single source of truth for turning a user-facing ModelPolicyInput into the
// effective per-role route: tier, ordered model chain, thinking level, session
// flag, and visible capability-floor promotion. Composes scripts/resolve-model.mjs
// (tier/chain reading) and lib/jsonc.mjs (JSONC parsing) rather than re-implementing
// either. Local-only resolution fails closed and is a pure function of its inputs,
// so the result is idempotent.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { readJsonc } from "../lib/jsonc.mjs";
import { resolveModel } from "./resolve-model.mjs";

/** Friendly preset names map to a tier; "local" additionally implies local-only. */
export const PRESET_ALIASES = Object.freeze({
	cheap: "tools",
	balanced: "coding",
	strong: "reasoning",
	local: "local-fast",
	"long-context": "long-context",
});

/**
 * Capability-strength ordering used for floor promotion, weakest first. A role's
 * effective tier is the stronger of its selected tier and the tier its capability
 * floor requires; the promotion is surfaced in preview output.
 */
export const TIER_RANK = Object.freeze({
	tools: 0,
	"local-fast": 1,
	test: 2,
	coding: 3,
	"long-context": 4,
	"long-coding": 5,
	review: 6,
	reasoning: 7,
	vision: 8,
});

const LOOPBACK_BASE_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i;

export function isLoopbackBaseUrl(baseUrl) {
	return LOOPBACK_BASE_URL.test(String(baseUrl ?? ""));
}

/** A model is local iff its provider's baseUrl in models.json is loopback. */
export function isLocalModel(modelId, models) {
	const provider = String(modelId ?? "").split("/", 1)[0];
	const baseUrl = models?.providers?.[provider]?.baseUrl;
	return isLoopbackBaseUrl(baseUrl);
}

/** Read the provider catalog (plain JSON); an unreadable file yields no providers. */
export function loadModels(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { providers: {} };
	}
}

function capabilityFloorTier(config, floor) {
	if (!floor) return null;
	const floors = config?.adaptive?.capability_floors ?? config?.adaptive?.capabilityFloors ?? {};
	const mapped = floors[floor];
	return mapped ? String(mapped) : String(floor);
}

function tierRank(tier) {
	const rank = TIER_RANK[tier];
	return rank === undefined ? -1 : rank;
}

/** Return the stronger of the selected tier and the capability floor's tier. */
export function promoteTier(baseTier, floorTier) {
	if (!floorTier) return baseTier;
	return tierRank(floorTier) > tierRank(baseTier) ? floorTier : baseTier;
}

/**
 * Normalize and validate a ModelPolicyInput tagged union:
 *   { kind: "auto" }
 *   { kind: "preset"; preset: "cheap"|"balanced"|"strong"|"local"|"long-context" }
 *   { kind: "tier"; tier: string }
 *   { kind: "model"; model: string; reason: string }
 * Returns { ok: true, input } or { ok: false, error }.
 */
export function normalizeModelPolicyInput(input) {
	const raw = input && typeof input === "object" ? input : {};
	const kind = raw.kind;
	if (kind === "auto") return { ok: true, input: { kind: "auto" } };
	if (kind === "preset") {
		const preset = String(raw.preset ?? "");
		const tier = PRESET_ALIASES[preset];
		if (!tier) return { ok: false, error: `unknown preset '${preset}'` };
		return { ok: true, input: { kind: "preset", preset, tier, localOnly: preset === "local" } };
	}
	if (kind === "tier") {
		const tier = String(raw.tier ?? "").trim();
		if (!tier) return { ok: false, error: "tier input requires a non-empty tier" };
		return { ok: true, input: { kind: "tier", tier } };
	}
	if (kind === "model") {
		const model = String(raw.model ?? "").trim();
		const reason = String(raw.reason ?? "").trim();
		if (!model) return { ok: false, error: "model input requires a non-empty model" };
		if (!reason) return { ok: false, error: "model input requires a non-empty reason" };
		return { ok: true, input: { kind: "model", model, reason } };
	}
	return { ok: false, error: `unknown policy kind '${String(kind)}'` };
}

function resolveRoleRoute(roleName, roleConfig, context) {
	const { baseTier, kind, model, localOnly, config, models } = context;
	const floor = String(roleConfig.capability_floor ?? roleConfig.capabilityFloor ?? "").trim() || null;
	const floorTier = capabilityFloorTier(config, floor);

	if (kind === "model") {
		return {
			role: roleName,
			capabilityFloor: floor,
			floorTier,
			tier: "(explicit)",
			baseTier: null,
			promoted: false,
			promotedFrom: null,
			thinking: null,
			session: false,
			models: [model],
			localOnly: false,
			local: isLocalModel(model, models),
		};
	}

	const defaultTier = String(roleConfig.tier ?? config.default_tier ?? "tools");
	const selectedBase = baseTier ?? defaultTier;
	const effectiveTier = promoteTier(selectedBase, floorTier);
	const chain = resolveModel(config, effectiveTier);
	const rawModels = chain.tier === effectiveTier ? chain.models : [];
	const modelsList = localOnly ? rawModels.filter((m) => isLocalModel(m, models)) : rawModels;

	return {
		role: roleName,
		capabilityFloor: floor,
		floorTier,
		tier: effectiveTier,
		baseTier: selectedBase,
		promoted: effectiveTier !== selectedBase,
		promotedFrom: effectiveTier !== selectedBase ? selectedBase : null,
		thinking: chain.thinking,
		session: chain.session,
		models: modelsList,
		localOnly,
		local: modelsList.length > 0 && modelsList.every((m) => isLocalModel(m, models)),
	};
}

/**
 * Resolve a ModelPolicyInput against a routing config and provider catalog into
 * the effective per-role route snapshot. `roles` restricts resolution to the
 * requested role names (defaults to every configured role).
 */
export function resolveModelPolicy(input, options = {}) {
	const config = options.config ?? {};
	const models = options.models ?? { providers: {} };
	const roleNames = options.roles ?? Object.keys(config.roles ?? {});

	const normalized = normalizeModelPolicyInput(input);
	if (!normalized.ok) {
		return {
			ok: false,
			kind: String(input?.kind ?? "unknown"),
			input: input ?? {},
			baseTier: null,
			localOnly: false,
			model: null,
			reason: null,
			roles: [],
			errors: [normalized.error],
			affectedRoles: [],
		};
	}

	const policy = normalized.input;
	const kind = policy.kind;
	const baseTier = kind === "preset" ? policy.tier : kind === "tier" ? policy.tier : null;
	const localOnly = policy.localOnly === true;
	const model = kind === "model" ? policy.model : null;

	const errors = [];
	if (kind === "tier" && !config.tiers?.[policy.tier]) {
		errors.push(`unknown tier '${policy.tier}'`);
	}

	const roles = [];
	if (errors.length === 0) {
		for (const roleName of roleNames) {
			const roleConfig = config.roles?.[roleName] ?? {};
			roles.push(resolveRoleRoute(roleName, roleConfig, { baseTier, kind, model, localOnly, config, models }));
		}
	}

	const affectedRoles = [];
	if (localOnly) {
		for (const route of roles) {
			if (route.models.length === 0) {
				affectedRoles.push(route.role);
				errors.push(
					`role '${route.role}' has no local route satisfying capability floor '${route.capabilityFloor ?? "none"}' (tier '${route.tier}')`,
				);
			}
		}
	}

	return {
		ok: errors.length === 0,
		kind,
		input: policy,
		baseTier,
		localOnly,
		model,
		reason: kind === "model" ? policy.reason : null,
		roles,
		errors,
		affectedRoles,
	};
}

/** Stable, insertion-ordered JSON of the resolved snapshot (the digest source). */
export function canonicalPolicySnapshot(resolved) {
	return JSON.stringify({
		kind: resolved.kind,
		input: resolved.input,
		baseTier: resolved.baseTier,
		localOnly: resolved.localOnly,
		model: resolved.model,
		reason: resolved.reason,
		roles: resolved.roles.map((route) => ({
			role: route.role,
			tier: route.tier,
			baseTier: route.baseTier,
			capabilityFloor: route.capabilityFloor,
			floorTier: route.floorTier,
			promoted: route.promoted,
			promotedFrom: route.promotedFrom,
			thinking: route.thinking,
			session: route.session,
			models: route.models,
		})),
	});
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const DEFAULT_ROUTING = process.env.PI_MODEL_ROUTING?.trim() || join(AGENT_DIR, "model-routing.jsonc");
const DEFAULT_MODELS = process.env.PI_MODEL_CATALOG?.trim() || join(AGENT_DIR, "models.json");

function cliArgs(argv) {
	const args = { input: null, roles: null, config: DEFAULT_ROUTING, models: DEFAULT_MODELS };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--input") args.input = argv[++i];
		else if (flag === "--roles") args.roles = argv[++i];
		else if (flag === "--config") args.config = argv[++i];
		else if (flag === "--models") args.models = argv[++i];
	}
	return args;
}

const isMain = basename(process.argv[1] ?? "") === "policy-resolver.mjs";

if (isMain) {
	const args = cliArgs(process.argv.slice(2));
	let raw = args.input;
	if (raw == null) {
		raw = readFileSync(0, "utf8").trim();
	}
	const input = raw ? JSON.parse(raw) : { kind: "auto" };
	const roles = args.roles ? args.roles.split(",").map((r) => r.trim()).filter(Boolean) : undefined;
	const config = readJsonc(args.config);
	const models = loadModels(args.models);
	const resolved = resolveModelPolicy(input, { config, models, roles });
	process.stdout.write(JSON.stringify(resolved));
	process.exitCode = resolved.ok ? 0 : 1;
}
