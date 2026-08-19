import { describe, expect, test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentDir, resolveCatalogPath, resolveFzfPath, resolveRoutingPath } from "../lib/agent-paths.mjs";
import { analyzeCatalog, loadCatalog, redactCatalog, SENSITIVE_FIELDS } from "../lib/catalog.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { CAPABILITY_FLOORS, DELEGATE_GRAPH_ROLES, REQUIRED_TIERS, ROLE_CAPABILITY_FLOORS, ROLE_TIERS, generateRoutingTemplate } from "../lib/routing-template.mjs";

function withEnv(patch, run) {
	const previous = { ...process.env };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		process.env = previous;
	}
}

describe("agent-paths", () => {
	test("resolves the agent directory from flag, env, then home", () => {
		withEnv({ PI_CODING_AGENT_DIR: undefined }, () => {
			expect(resolveAgentDir("/explicit/dir")).toBe("/explicit/dir");
			expect(resolveAgentDir()).toBe(join(homedir(), ".pi", "agent"));
		});
		withEnv({ PI_CODING_AGENT_DIR: "/env/dir" }, () => {
			expect(resolveAgentDir()).toBe("/env/dir");
			expect(resolveAgentDir("/explicit/dir")).toBe("/explicit/dir");
		});
	});

	test("resolves routing and catalog paths with flag, env, then agent-dir fallback", () => {
		withEnv({ PI_MODEL_ROUTING: undefined, PI_MODEL_CATALOG: undefined }, () => {
			expect(resolveRoutingPath("/agent")).toBe(join("/agent", "model-routing.jsonc"));
			expect(resolveCatalogPath("/agent")).toBe(join("/agent", "models.json"));
			expect(resolveRoutingPath("/agent", "/flag/routing.jsonc")).toBe("/flag/routing.jsonc");
			expect(resolveCatalogPath("/agent", "/flag/models.json")).toBe("/flag/models.json");
		});
		withEnv({ PI_MODEL_ROUTING: "/env/routing.jsonc", PI_MODEL_CATALOG: "/env/models.json" }, () => {
			expect(resolveRoutingPath("/agent")).toBe("/env/routing.jsonc");
			expect(resolveCatalogPath("/agent")).toBe("/env/models.json");
			expect(resolveRoutingPath("/agent", "/flag/routing.jsonc")).toBe("/flag/routing.jsonc");
		});
		expect(resolveFzfPath("/agent")).toBe(join("/agent", "fzf.json"));
	});
});

describe("catalog", () => {
	test("derives selectable model ids strictly from providers.<provider>.models[].id", () => {
		const catalog = {
			providers: {
				one: { baseUrl: "https://example.com", models: [{ id: "alpha", name: "Alpha" }, { id: "beta" }] },
				two: { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "gamma" }] },
			},
		};
		const analysis = analyzeCatalog(catalog);
		expect(analysis.selectable.map((entry) => entry.modelId)).toEqual(["one/alpha", "one/beta", "two/gamma"]);
		expect(analysis.problems).toEqual([]);
	});

	test("excludes duplicate, malformed, and HF-style slashed ids with warnings", () => {
		const catalog = {
			providers: {
				one: { models: [{ id: "dup" }, { id: "dup" }, { id: "" }, {}, { id: "Deviad/DeepSeek-V4-Flash-MLX-Q4Q8" }] },
			},
		};
		const analysis = analyzeCatalog(catalog);
		expect(analysis.problems).toEqual([]);
		expect(analysis.warnings).toEqual([
			"duplicate model identifier 'one/dup'; excluded from selection",
			"provider 'one' has a model with a missing or empty id; excluded from selection",
			"provider 'one' has a model with a missing or empty id; excluded from selection",
			"provider 'one' model id 'Deviad/DeepSeek-V4-Flash-MLX-Q4Q8' contains '/'; excluded from selection",
		]);
		expect(analysis.selectable.map((entry) => entry.modelId)).toEqual(["one/dup"]);
	});

	test("treats a missing providers object as a problem", () => {
		expect(analyzeCatalog({}).problems).toEqual(["catalog has no providers object"]);
		expect(analyzeCatalog(null).problems).toEqual(["catalog has no providers object"]);
	});

	test("redacts credential-bearing provider fields and preserves structure", () => {
		const catalog = {
			providers: {
				one: { baseUrl: "https://example.com", apiKey: "SUPER_SECRET_SENTINEL", token: "tok", models: [{ id: "alpha" }] },
			},
		};
		const redacted = redactCatalog(catalog);
		expect(redacted.providers.one.apiKey).toBe("[redacted]");
		expect(redacted.providers.one.token).toBe("[redacted]");
		expect(redacted.providers.one.baseUrl).toBe("https://example.com");
		expect(redacted.providers.one.models).toEqual([{ id: "alpha" }]);
		expect(JSON.stringify(redacted)).not.toContain("SUPER_SECRET_SENTINEL");
		expect(SENSITIVE_FIELDS).toContain("apiKey");
	});

	test("loadCatalog reads JSON and throws clear errors on missing or malformed input", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-wave-catalog-"));
		const missing = join(dir, "absent.json");
		assert.throws(() => loadCatalog(missing), /cannot read model catalog/);
		writeFileSync(join(dir, "bad.json"), "{ not json ");
		assert.throws(() => loadCatalog(join(dir, "bad.json")), /invalid model catalog JSON/);
		writeFileSync(join(dir, "good.json"), JSON.stringify({ providers: {} }));
		expect(loadCatalog(join(dir, "good.json"))).toEqual({ providers: {} });
	});
});

describe("routing-template", () => {
	test("generates the six required tiers with standard thinking/session defaults", () => {
		const chains = Object.fromEntries(REQUIRED_TIERS.map((tier) => [tier, ["fixture/model"]]));
		const parsed = parseJsonc(generateRoutingTemplate({ chains }));
		expect(Object.keys(parsed.tiers).sort()).toEqual([...REQUIRED_TIERS].sort());
		expect(parsed.tiers.tools).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "off", session: false });
		expect(parsed.tiers.coding).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "high", session: true });
		expect(parsed.tiers.test).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "low", session: false });
		expect(parsed.tiers.review).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "xhigh", session: true });
		expect(parsed.tiers.reasoning).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "high", session: true });
		expect(parsed.tiers["long-context"]).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "medium", session: true });
		expect(parsed.tiers["local-fast"]).toBeUndefined();
	});

	test("includes local-fast only when selected and maps roles to standard tiers", () => {
		const chains = Object.fromEntries(REQUIRED_TIERS.map((tier) => [tier, ["fixture/model"]]));
		chains["local-fast"] = ["fixture/model"];
		const parsed = parseJsonc(generateRoutingTemplate({ chains, includeLocalFast: true }));
		expect(parsed.tiers["local-fast"]).toMatchObject({ label: expect.any(String), models: ["fixture/model"], thinking: "off", session: false });
		expect(Object.keys(parsed.roles).sort()).toEqual([...DELEGATE_GRAPH_ROLES].sort());
		for (const role of DELEGATE_GRAPH_ROLES) {
			expect(parsed.roles[role]).toEqual({ tier: ROLE_TIERS[role], capability_floor: ROLE_CAPABILITY_FLOORS[role] });
		}
		expect(parsed.adaptive.capability_floors).toEqual({ ...CAPABILITY_FLOORS });
		expect(parsed.default_tier).toBe("tools");
	});

	test("is deterministic for identical selections", () => {
		const chains = Object.fromEntries(REQUIRED_TIERS.map((tier) => [tier, ["fixture/model"]]));
		const first = generateRoutingTemplate({ chains, includeLocalFast: true });
		const second = generateRoutingTemplate({ chains, includeLocalFast: true });
		expect(first).toBe(second);
	});

	test("preserves ordered model chains per tier", () => {
		const parsed = parseJsonc(generateRoutingTemplate({ chains: { tools: ["a/one", "b/two"] } }));
		expect(parsed.tiers.tools.models).toEqual(["a/one", "b/two"]);
	});
});
