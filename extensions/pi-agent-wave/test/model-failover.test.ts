import { afterEach, describe, expect, test } from "./test-api.mjs";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelFailoverExtension from "../model-failover.ts";
import {
	MODEL_FAILOVER_BLOCKED,
	MODEL_FAILOVER_RETRY,
	classifyFailoverError,
	findNextFailoverCandidate,
	loadTierRoute,
	parseFailoverRoute,
	sanitizeAssistantError,
} from "../lib/model-failover-native.mjs";

const temporaryRoots: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
	process.env = { ...originalEnv };
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const models = [
	{ provider: "provider-a", id: "one", contextWindow: 1000 },
	{ provider: "provider-a", id: "two", contextWindow: 1000 },
	{ provider: "provider-b", id: "three", contextWindow: 1000 },
	{ provider: "provider-c", id: "four", contextWindow: 1000 },
];

function assistantError(model: (typeof models)[number], text: string, extra: Record<string, unknown> = {}): any {
	return {
		role: "assistant",
		stopReason: "error",
		errorMessage: text,
		provider: model.provider,
		model: model.id,
		content: [],
		...extra,
	};
}

function assistantSuccess(model: (typeof models)[number], stopReason = "stop"): any {
	return {
		role: "assistant",
		stopReason,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "accepted" }],
	};
}

interface HarnessOptions {
	delegated?: boolean;
	exactLock?: boolean;
	route?: string[];
	authenticated?: Set<string>;
	available?: Set<string>;
}

async function createHarness(options: HarnessOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-wave-failover-"));
	temporaryRoots.push(root);
	const route = options.route ?? ["provider-a/one", "provider-a/two", "provider-b/three", "provider-c/four"];
	const settingsPath = join(root, "settings.json");
	const settingsBytes = '{\n  "defaultProvider": "provider-a",\n  "defaultModel": "one",\n  "theme": "dark"\n}\n';
	await writeFile(settingsPath, settingsBytes);
	const routingPath = join(root, "routing.jsonc");
	await writeFile(routingPath, JSON.stringify({ tiers: { coding: { models: route } } }));

	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_MODEL_ROUTING = routingPath;
	process.env.PI_DELEGATION_KIND = options.delegated ? "role" : "main";
	process.env.PI_FAILOVER_LOCKED = options.exactLock ? "1" : "0";
	process.env.PI_FAILOVER_ROUTE = route.join(",");
	process.env.PI_FAILOVER_TIER = "coding";
	process.env.PI_FAILOVER_ROLE = options.delegated ? "Reviewer" : "";

	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const entries: Array<{ type: string; data: any }> = [];
	const statuses: string[] = [];
	const notifications: string[] = [];
	const setModelCalls: string[] = [];
	let ctx: any;

	const pi = {
		on(name: string, handler: Function) { handlers.set(name, handler); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		appendEntry(type: string, data: any) { entries.push({ type, data }); },
		async setModel(model: (typeof models)[number]) {
			setModelCalls.push(`${model.provider}/${model.id}`);
			const previousModel = ctx.model;
			await writeFile(settingsPath, JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, theme: "dark" }));
			ctx.model = model;
			await handlers.get("model_select")?.({ source: "set", previousModel, model }, ctx);
			return true;
		},
	};

	ctx = {
		model: models[0],
		hasUI: true,
		ui: {
			setStatus(_id: string, text: string | undefined) { if (text) statuses.push(text); },
			notify(text: string) { notifications.push(text); },
		},
		modelRegistry: {
			find(provider: string, id: string) {
				const key = `${provider}/${id}`;
				if (options.available && !options.available.has(key)) return undefined;
				return models.find((model) => model.provider === provider && model.id === id);
			},
			hasConfiguredAuth(model: (typeof models)[number]) {
				return !options.authenticated || options.authenticated.has(`${model.provider}/${model.id}`);
			},
		},
		sessionManager: {
			getSessionFile: () => undefined,
			getEntries: () => [],
		},
	};

	modelFailoverExtension(pi as never);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);

	return {
		commands,
		ctx,
		entries,
		handlers,
		notifications,
		setModelCalls,
		settingsBytes,
		settingsPath,
		statuses,
		async beginOperation() {
			await handlers.get("before_agent_start")?.({}, ctx);
		},
		async finish(message: any, responseStatus?: number) {
			await handlers.get("before_provider_request")?.({}, ctx);
			if (responseStatus !== undefined) {
				await handlers.get("after_provider_response")?.({ status: responseStatus, headers: { authorization: "Bearer response-secret" } }, ctx);
			}
			return handlers.get("message_end")?.({ message }, ctx);
		},
	};
}

describe("model failover companion", () => {
	test("loads a JSONC tier from an explicit package-independent path", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-wave-routing-"));
		temporaryRoots.push(root);
		const config = join(root, "routing.jsonc");
		await writeFile(config, '{\n  // ordered fallback\n  "tiers": { "coding": { "models": ["provider-a/one", "provider-b/three"] } }\n}\n');
		expect(loadTierRoute(config, "coding")).toEqual(["provider-a/one", "provider-b/three"]);
	});

	test("classifies every genuine HTTP 429 while retaining rate-limit and quota diagnostics", () => {
		const generic = classifyFailoverError(assistantError(models[0], "opaque response-body sentinel"), {
			responseStatus: 429,
			isRetryableAssistantError: () => false,
		});
		const quota = classifyFailoverError(assistantError(models[0], "HTTP 429 opaque quota sentinel", {
			error: { code: "insufficient_quota" },
		}), {
			isRetryableAssistantError: () => true,
		});
		expect(generic).toMatchObject({ kind: "ordinary", category: "rate-limit", statusCode: 429 });
		expect(quota).toMatchObject({ kind: "quota", category: "quota", statusCode: 429 });

		for (const text of [
			"HTTP 400 invalid request",
			"content refusal",
			"context window overflow",
			"tool failure",
			"review rejection",
		]) {
			expect(classifyFailoverError(assistantError(models[0], text), { isRetryableAssistantError: () => false }).kind).toBe("terminal");
		}
	});

	test("selects only the first available authenticated model on a different non-excluded provider", () => {
		const route = parseFailoverRoute("provider-a/one,provider-a/two,provider-b/three,provider-c/four");
		const candidate = findNextFailoverCandidate({
			route,
			cursor: 0,
			currentModel: models[0],
			excludedProviders: new Set(["provider-a"]),
			modelRegistry: {
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: (typeof models)[number]) => model.provider !== "provider-b",
			},
		});
		expect(candidate).toMatchObject({ model: { provider: "provider-c", id: "four" }, index: 3 });
		expect(findNextFailoverCandidate({
			route: route.slice(0, 3),
			cursor: 0,
			currentModel: models[0],
			excludedProviders: new Set(["provider-a"]),
			modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
		})).toBe(undefined);
	});

	test("automatically retries delegated 429 work on the next provider and records one accepted result", async () => {
		const harness = await createHarness({ delegated: true, route: ["provider-a/one", "provider-a/two", "provider-b/three"] });
		await harness.beginOperation();
		const retry = await harness.finish(assistantError(models[0], "raw-response-body api-key=provider-secret"), 429);
		expect(harness.setModelCalls).toEqual(["provider-b/three"]);
		expect(retry?.message.errorMessage).toBe(MODEL_FAILOVER_RETRY);
		expect(JSON.stringify(retry)).not.toContain("provider-secret");
		expect(isRetryableAssistantError(retry.message)).toBe(true);

		let acceptedResults = 0;
		const accepted = assistantSuccess(models[2]);
		if (!(await harness.finish(accepted))) acceptedResults++;
		expect(acceptedResults).toBe(1);
		expect(`${harness.ctx.model.provider}/${harness.ctx.model.id}`).toBe("provider-b/three");
		expect(await readFile(harness.settingsPath, "utf8")).toBe(harness.settingsBytes);

		const receipt = harness.entries.find((entry) => entry.type === "model-failover-ready-v1")?.data;
		expect(receipt).toMatchObject({
			from: "provider-a/one",
			to: "provider-b/three",
			tier: "coding",
			classification: "rate-limit",
			routeIndex: 2,
			outcome: "success",
		});
		expect(JSON.stringify(harness.entries)).not.toContain("provider-secret");
		expect(JSON.stringify(harness.entries)).not.toContain("response-secret");

		await harness.commands.get("failover").handler("status", harness.ctx);
		const status = JSON.parse(harness.notifications.at(-1) ?? "{}");
		expect(status.recovery).toMatchObject({
			sourceModel: "provider-a/one",
			destinationModel: "provider-b/three",
			classification: "rate-limit",
			routeIndex: 2,
			outcome: "success",
		});
	});

	test("keeps main sessions disabled until enabled and honors manual and exact locks", async () => {
		const main = await createHarness({ route: ["provider-a/one", "provider-b/three"] });
		await main.beginOperation();
		expect(await main.finish(assistantError(models[0], "HTTP 429 disabled"), 429)).toBe(undefined);
		expect(main.setModelCalls).toEqual([]);

		await main.commands.get("failover").handler("enable coding", main.ctx);
		const retry = await main.finish(assistantError(models[0], "HTTP 429 enabled"), 429);
		expect(retry?.message.errorMessage).toBe(MODEL_FAILOVER_RETRY);
		expect(main.setModelCalls).toEqual(["provider-b/three"]);

		const manual = await createHarness({ route: ["provider-a/one", "provider-b/three"] });
		await manual.commands.get("failover").handler("enable coding", manual.ctx);
		await manual.handlers.get("model_select")?.({ source: "cycle", previousModel: models[0], model: models[2] }, manual.ctx);
		manual.ctx.model = models[2];
		expect(await manual.finish(assistantError(models[2], "HTTP 429 manual lock"), 429)).toBe(undefined);
		expect(manual.setModelCalls).toEqual([]);

		const exact = await createHarness({ delegated: true, exactLock: true, route: ["provider-a/one", "provider-b/three"] });
		await exact.beginOperation();
		expect(await exact.finish(assistantError(models[0], "HTTP 429 exact lock"), 429)).toBe(undefined);
		expect(exact.setModelCalls).toEqual([]);
	});

	test("continues across distinct providers, resets exclusions after success, and never crosses the route", async () => {
		const sequence = await createHarness({ delegated: true, route: ["provider-a/one", "provider-b/three", "provider-c/four"] });
		await sequence.beginOperation();
		expect((await sequence.finish(assistantError(models[0], "HTTP 429 first"), 429))?.message.errorMessage).toBe(MODEL_FAILOVER_RETRY);
		expect((await sequence.finish(assistantError(models[2], "HTTP 429 second"), 429))?.message.errorMessage).toBe(MODEL_FAILOVER_RETRY);
		expect(sequence.setModelCalls).toEqual(["provider-b/three", "provider-c/four"]);
		await sequence.finish(assistantSuccess(models[3]));

		const reset = await createHarness({ delegated: true, route: ["provider-a/one", "provider-b/three", "provider-a/two"] });
		await reset.beginOperation();
		await reset.finish(assistantError(models[0], "HTTP 429 first operation"), 429);
		await reset.finish(assistantSuccess(models[2]));
		await reset.beginOperation();
		await reset.finish(assistantError(models[2], "HTTP 429 second operation"), 429);
		expect(reset.setModelCalls).toEqual(["provider-b/three", "provider-a/two"]);

		const exhausted = await createHarness({ delegated: true, route: ["provider-a/one", "provider-b/three"] });
		await exhausted.beginOperation();
		await exhausted.finish(assistantError(models[0], "HTTP 429 first"), 429);
		const blocked = await exhausted.finish(assistantError(models[2], "raw route-exhausted secret"), 429);
		expect(blocked?.message.errorMessage).toBe(MODEL_FAILOVER_BLOCKED);
		expect(JSON.stringify(blocked)).not.toContain("route-exhausted secret");
		expect(exhausted.setModelCalls).toEqual(["provider-b/three"]);
		await exhausted.commands.get("failover").handler("status", exhausted.ctx);
		expect(JSON.parse(exhausted.notifications.at(-1) ?? "{}").recovery).toMatchObject({ outcome: "route-exhausted" });
	});

	test("sanitizes retry and blocked messages without carrying provider bodies or credentials", () => {
		const raw = assistantError(models[0], "Authorization: Bearer credential-sentinel response-body-sentinel", {
			headers: { authorization: "Bearer credential-sentinel" },
		});
		for (const marker of [MODEL_FAILOVER_RETRY, MODEL_FAILOVER_BLOCKED]) {
			const sanitized = sanitizeAssistantError(raw, marker);
			expect(sanitized.errorMessage).toBe(marker);
			expect(JSON.stringify(sanitized)).not.toContain("credential-sentinel");
			expect(JSON.stringify(sanitized)).not.toContain("response-body-sentinel");
		}
	});
});
