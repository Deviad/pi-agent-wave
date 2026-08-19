import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc, readJsonc } from "./lib/jsonc.mjs";
import { resolveModel } from "./lib/model-routing.mjs";

export const DELEGATE_GRAPH_ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"] as const;
export type DelegateGraphRole = (typeof DELEGATE_GRAPH_ROLES)[number];

type CatalogModel = {
	id?: string;
	name?: string;
	contextWindow?: number;
	cost?: Record<string, number>;
};

type RouteModel = {
	providerModelId: string;
	displayName?: string;
	contextWindow?: number;
	cost?: Record<string, number>;
};

export type RoleRoute = {
	role: DelegateGraphRole;
	tier: string;
	thinking: string;
	session: boolean;
	capabilityFloor: string;
	models: RouteModel[];
};

export type RepinResult = {
	changed: boolean;
	backupPath?: string;
	previousTier: string;
	tier: string;
};

const LIST_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function resolveRoutingPath(): string {
	return process.env.PI_MODEL_ROUTING?.trim() || join(resolveAgentDir(), "model-routing.jsonc");
}

export function resolveCatalogPath(): string {
	return process.env.PI_MODEL_CATALOG?.trim() || join(resolveAgentDir(), "models.json");
}

/** Build a lookup keyed by the exact provider/model identifiers used in routing chains. */
function catalogIndex(catalog: any): Map<string, CatalogModel> {
	const index = new Map<string, CatalogModel>();
	for (const [provider, definition] of Object.entries<any>(catalog?.providers ?? {})) {
		for (const model of Array.isArray(definition?.models) ? definition.models : []) {
			if (typeof model?.id === "string" && model.id) index.set(`${provider}/${model.id}`, model);
		}
	}
	return index;
}

/** Read the six graph-worker routes through the shared JSONC parser and model resolver. */
export function loadRoleRoutes(configFile = resolveRoutingPath(), modelsFile = resolveCatalogPath()): RoleRoute[] {
	const config = readJsonc(configFile);
	let catalog: any = { providers: {} };
	try {
		catalog = JSON.parse(readFileSync(modelsFile, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const models = catalogIndex(catalog);
	return DELEGATE_GRAPH_ROLES.map((role) => {
		const resolved = resolveModel(config, role);
		if (resolved.warning || !config.roles?.[role]) throw new Error(`missing Delegate Graph role '${role}'`);
		return {
			role,
			tier: resolved.tier,
			thinking: resolved.thinking,
			session: resolved.session,
			capabilityFloor: String(config.roles[role].capability_floor ?? "not configured"),
			models: resolved.models.map((providerModelId: string) => {
				const metadata = models.get(providerModelId);
				return {
					providerModelId,
					displayName: metadata?.name,
					contextWindow: metadata?.contextWindow,
					cost: metadata?.cost,
				};
			}),
		};
	});
}

function listPrice(cost?: Record<string, number>): string {
	const fields = LIST_PRICE_FIELDS.flatMap((field) => cost?.[field] === undefined ? [] : [`${field}=$${cost[field]}/M tokens`]);
	return fields.length ? fields.join(", ") : "not listed";
}

function modelSummary(model: RouteModel): string {
	const display = model.displayName ?? "display name not listed";
	const context = model.contextWindow === undefined ? "not listed" : `${model.contextWindow.toLocaleString("en-US")} tokens`;
	return `${display} | provider/model ID: ${model.providerModelId} | context window: ${context} | list price: ${listPrice(model.cost)}`;
}

/** Format a single-line picker row without dropping any ordered-chain metadata. */
export function formatRoleOption(route: RoleRoute): string {
	return `${route.role} | tier: ${route.tier} | thinking: ${route.thinking} | session: ${route.session} | capability floor: ${route.capabilityFloor} | chain: ${route.models.map(modelSummary).join(" -> ")}`;
}

/** Format the multiline fzf preview for one graph role. */
export function formatRolePreview(route: RoleRoute): string {
	const chain = route.models.length
		? route.models.map((model, index) => `${index + 1}. ${modelSummary(model)}`).join("\n")
		: "(empty)";
	return [
		`Role: ${route.role}`,
		`Tier: ${route.tier}`,
		`Thinking: ${route.thinking}`,
		`Session: ${route.session}`,
		`Capability floor: ${route.capabilityFloor}`,
		"Ordered chain:",
		chain,
	].join("\n");
}

type JsonToken = { type: "string" | "punct"; value: string; start: number; end: number };

/** Tokenize only the JSONC structure needed to replace one exact property value. */
function jsoncTokens(source: string): JsonToken[] {
	const tokens: JsonToken[] = [];
	for (let index = 0; index < source.length;) {
		if (/\s/.test(source[index])) {
			index++;
			continue;
		}
		if (source[index] === "/" && source[index + 1] === "/") {
			index += 2;
			while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index++;
			continue;
		}
		if (source[index] === "/" && source[index + 1] === "*") {
			index += 2;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
			index += 2;
			continue;
		}
		if (source[index] === '"') {
			const start = index++;
			while (index < source.length) {
				if (source[index] === "\\") index += 2;
				else if (source[index++] === '"') break;
			}
			const raw = source.slice(start, index);
			tokens.push({ type: "string", value: JSON.parse(raw), start, end: index });
			continue;
		}
		if ("{}[]:,".includes(source[index])) tokens.push({ type: "punct", value: source[index], start: index, end: index + 1 });
		index++;
	}
	return tokens;
}

function matchingClose(tokens: JsonToken[], openIndex: number): number {
	const pairs: Record<string, string> = { "{": "}", "[": "]" };
	const open = tokens[openIndex]?.value;
	const close = pairs[open];
	if (!close) throw new Error("expected object or array");
	let depth = 0;
	for (let index = openIndex; index < tokens.length; index++) {
		if (tokens[index].value === open) depth++;
		if (tokens[index].value === close && --depth === 0) return index;
	}
	throw new Error("unterminated JSONC structure");
}

function objectProperty(tokens: JsonToken[], openIndex: number, name: string): number {
	const closeIndex = matchingClose(tokens, openIndex);
	let nested = 0;
	for (let index = openIndex + 1; index < closeIndex; index++) {
		const token = tokens[index];
		if (token.value === "{" || token.value === "[") {
			nested++;
			continue;
		}
		if (token.value === "}" || token.value === "]") {
			nested--;
			continue;
		}
		if (nested === 0 && token.type === "string" && token.value === name && tokens[index + 1]?.value === ":") return index + 2;
	}
	throw new Error(`missing exact JSONC property '${name}'`);
}

function roleTierSpan(source: string, role: DelegateGraphRole): { start: number; end: number; value: string } {
	const tokens = jsoncTokens(source);
	const root = tokens.findIndex((token) => token.value === "{");
	if (root < 0) throw new Error("routing config must contain an object");
	const roles = objectProperty(tokens, root, "roles");
	if (tokens[roles]?.value !== "{") throw new Error("routing config roles must be an object");
	const roleObject = objectProperty(tokens, roles, role);
	if (tokens[roleObject]?.value !== "{") throw new Error(`role '${role}' must be an object`);
	const tier = tokens[objectProperty(tokens, roleObject, "tier")];
	if (tier?.type !== "string") throw new Error(`role '${role}' tier must be a string`);
	return { start: tier.start, end: tier.end, value: tier.value };
}

async function timestampedBackup(configFile: string, bytes: Buffer, mode: number, now: Date): Promise<string> {
	const timestamp = now.toISOString().replace(/:/g, "-");
	for (let suffix = 0; suffix < 100; suffix++) {
		const backup = `${configFile}.${timestamp}${suffix ? `-${suffix}` : ""}.bak`;
		try {
			await writeFile(backup, bytes, { flag: "wx", mode });
			return backup;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("could not allocate timestamped routing backup");
}

/** Re-pin exactly one role tier after rereading, backing up, parsing, resolving, and atomically replacing the latest file. */
export async function repinRole(
	role: DelegateGraphRole,
	tier: string,
	configFile = resolveRoutingPath(),
	now = new Date(),
): Promise<RepinResult> {
	if (!DELEGATE_GRAPH_ROLES.includes(role)) throw new Error(`unsupported Delegate Graph role '${role}'`);
	const original = await readFile(configFile);
	const source = original.toString("utf8");
	const parsed = parseJsonc(source, configFile);
	const current = resolveModel(parsed, role);
	if (current.warning || !parsed.roles?.[role]) throw new Error(`missing Delegate Graph role '${role}'`);
	if (!parsed.tiers?.[tier]) throw new Error(`unknown routing tier '${tier}'`);
	if (current.tier === tier) return { changed: false, previousTier: current.tier, tier };

	const fileMode = (await stat(configFile)).mode;
	const backupPath = await timestampedBackup(configFile, original, fileMode, now);
	const span = roleTierSpan(source, role);
	const candidate = `${source.slice(0, span.start)}${JSON.stringify(tier)}${source.slice(span.end)}`;
	const temp = join(dirname(configFile), `.${resolve(configFile).split("/").pop()}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, candidate, { mode: fileMode });
		await chmod(temp, fileMode);
		const validated = readJsonc(temp);
		const resolvedRoute = resolveModel(validated, role);
		if (resolvedRoute.warning || resolvedRoute.tier !== tier || resolvedRoute.models.length === 0) {
			throw new Error(`validation failed for ${role} tier '${tier}'`);
		}
		const latest = await readFile(configFile);
		if (!latest.equals(original)) throw new Error("routing config changed during re-pin; no mutation applied");
		await rename(temp, configFile);
		return { changed: true, backupPath, previousTier: span.value, tier };
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

function tierOptions(configFile: string, modelsFile: string): Array<{ tier: string; option: string }> {
	const config = readJsonc(configFile);
	let catalog: any = { providers: {} };
	try {
		catalog = JSON.parse(readFileSync(modelsFile, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const models = catalogIndex(catalog);
	return Object.keys(config.tiers ?? {}).map((tier) => {
		const route = resolveModel(config, tier);
		const chain = route.models.map((providerModelId: string) => {
			const metadata = models.get(providerModelId);
			return modelSummary({ providerModelId, displayName: metadata?.name, contextWindow: metadata?.contextWindow, cost: metadata?.cost });
		}).join(" -> ");
		return { tier, option: `${tier} | thinking: ${route.thinking} | session: ${route.session} | chain: ${chain}` };
	});
}

export default function routePicker(pi: ExtensionAPI): void {
	pi.registerCommand("route", {
		description: "Inspect and safely re-pin Delegate Graph role routes.",
		handler: async (args, ctx) => {
			try {
				const configFile = resolveRoutingPath();
				const modelsFile = resolveCatalogPath();
				const routes = loadRoleRoutes(configFile, modelsFile);
				let role = args.trim().toLowerCase() as DelegateGraphRole;
				if (!role) {
					const options = routes.map(formatRoleOption);
					const selected = await ctx.ui.select("Delegate Graph routes — select a role to re-pin, or cancel to inspect only", options);
					if (!selected) return;
					const match = routes.find((route) => formatRoleOption(route) === selected);
					if (!match) throw new Error("selected route is no longer available");
					role = match.role;
				}
				if (!DELEGATE_GRAPH_ROLES.includes(role)) throw new Error(`usage: /route [${DELEGATE_GRAPH_ROLES.join("|")}]`);
				const tiers = tierOptions(configFile, modelsFile);
				const selectedTier = await ctx.ui.select(`Re-pin ${role} — cancel to leave the file unchanged`, tiers.map((entry) => entry.option));
				if (!selectedTier) return;
				const target = tiers.find((entry) => entry.option === selectedTier);
				if (!target) throw new Error("selected tier is no longer available");
				const result = await repinRole(role, target.tier, configFile);
				ctx.ui.notify(result.changed ? `${role}: ${result.previousTier} → ${result.tier}; backup: ${result.backupPath}` : `${role} already uses ${result.tier}; no file changed`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	const [operation, role] = process.argv.slice(2);
	const routes = loadRoleRoutes();
	if (operation === "--list") {
		console.log(routes.map((route) => route.role).join("\n"));
	} else if (operation === "--preview") {
		const route = routes.find((entry) => entry.role === role);
		if (!route) throw new Error(`unknown Delegate Graph role '${role ?? ""}'`);
		console.log(formatRolePreview(route));
	} else {
		console.error("usage: route-picker.ts --list | --preview <role>");
		process.exitCode = 2;
	}
}
