import { describe, expect, test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRoutingTemplate } from "../lib/routing-template.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const DOCTOR_BIN = manifest.bin["pi-agent-wave-doctor"];

const SENTINEL = "DOCTOR_SECRET_SENTINEL_11223344";

function catalogJson() {
	return JSON.stringify(
		{
			providers: {
				localp: { baseUrl: "http://127.0.0.1:9999/v1", models: [{ id: "fast", name: "Local Fast", contextWindow: 128000 }] },
				cloudp: { baseUrl: "https://api.example.com", models: [{ id: "big", name: "Cloud Big", contextWindow: 1000000 }, { id: "small", name: "Cloud Small", contextWindow: 200000 }] },
				secretp: { baseUrl: "https://secret.example.com", apiKey: SENTINEL, models: [{ id: "hidden" }] },
			},
		},
		null,
		2,
	);
}

function chains() {
	return { tools: ["localp/fast"], coding: ["cloudp/big"], test: ["cloudp/small"], review: ["cloudp/big"], reasoning: ["cloudp/big"], "long-context": ["cloudp/big"] };
}

function seedHealthy(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), catalogJson());
	writeFileSync(join(agentDir, "model-routing.jsonc"), generateRoutingTemplate({ chains: chains() }));
}

function runDoctor(args, env = {}) {
	const result = spawnSync(process.execPath, [join(ROOT, DOCTOR_BIN), ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	let json;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		json = null;
	}
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function treeHash(path) {
	const hash = createHash("sha256");
	function visit(current) {
		const stat = lstatSync(current);
		hash.update(`${relative(path, current) || "."}\0${stat.isDirectory() ? "d" : "f"}\0`);
		if (stat.isDirectory()) for (const entry of readdirSync(current).sort()) visit(join(current, entry));
		else hash.update(readFileSync(current));
	}
	visit(path);
	return hash.digest("hex");
}

describe("pi-agent-wave-doctor", () => {
	test("is read-only: before and after tree hashes are identical", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const before = treeHash(agentDir);
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(0);
		expect(treeHash(agentDir)).toBe(before);
	});

	test("reports ok with a stable JSON schema on a healthy configuration", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(0);
		expect(result.json.schemaVersion).toBe(1);
		expect(result.json.ok).toBe(true);
		expect(result.json.agentDir).toBe(agentDir);
		expect(result.json.routingPath).toBe(join(agentDir, "model-routing.jsonc"));
		expect(result.json.modelsPath).toBe(join(agentDir, "models.json"));
		expect(result.json.fzfPath).toBe(join(agentDir, "fzf.json"));
		expect(result.json.fatal).toEqual([]);
		expect(Array.isArray(result.json.checks)).toBe(true);
		assert.ok(result.json.checks.length > 0);
		for (const entry of result.json.checks) {
			assert.ok(["ok", "warn", "fail"].includes(entry.status));
			assert.ok(typeof entry.check === "string" && entry.check.length > 0);
			assert.ok(typeof entry.detail === "string" && entry.detail.length > 0);
		}
		const checkNames = result.json.checks.map((entry) => entry.check);
		for (const name of ["agent-dir", "catalog", "routing-parse", "required-tiers", "required-roles", "non-empty-chains", "catalog-membership", "resolver", "route-picker", "entry-points"]) {
			assert.ok(checkNames.includes(name), `missing check ${name}`);
		}
	});

	test("never prints credentials or provider configuration", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.stdout).not.toContain(SENTINEL);
		expect(result.stdout).not.toContain("apiKey");
	});

	test("produces human-readable output when --json is omitted", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const result = runDoctor(["--agent-dir", agentDir]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("pi-agent-wave-doctor:");
		expect(result.stdout).not.toContain(SENTINEL);
	});

	test("catalog model quirks are warnings when valid selectable models remain", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const catalog = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		catalog.providers.vmlx = { baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "Deviad/DeepSeek-V4-Flash-MLX-Q4Q8" }] };
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(0);
		expect(result.json.warnings.map((entry) => entry.check)).toContain("catalog");
		expect(result.json.fatal.map((entry) => entry.check)).not.toContain("catalog");
	});

	test("explicit routing and models overrides are used by resolver and route-picker probes", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-agent-"));
		const configDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-config-"));
		const routingPath = join(configDir, "custom-routing.jsonc");
		const modelsPath = join(configDir, "custom-models.json");
		writeFileSync(routingPath, generateRoutingTemplate({ chains: chains() }));
		writeFileSync(modelsPath, catalogJson());
		const result = runDoctor(["--agent-dir", agentDir, "--routing", routingPath, "--models", modelsPath, "--json"]);
		expect(result.status).toBe(0);
		expect(result.json.routingPath).toBe(routingPath);
		expect(result.json.modelsPath).toBe(modelsPath);
		expect(result.json.checks.find((entry) => entry.check === "resolver")?.status).toBe("ok");
		expect(result.json.checks.find((entry) => entry.check === "route-picker")?.status).toBe("ok");
	});

	test("missing routing is fatal", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.json"), catalogJson());
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(1);
		expect(result.json.ok).toBe(false);
		expect(result.json.fatal.map((entry) => entry.check)).toContain("routing-parse");
	});

	test("invalid models are fatal", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		writeFileSync(join(agentDir, "models.json"), "{ not json ");
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(1);
		expect(result.json.ok).toBe(false);
		expect(result.json.fatal.map((entry) => entry.check)).toContain("catalog");
	});

	test("absent pi-fzf is a non-fatal warning", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(0);
		expect(result.json.warnings.map((entry) => entry.check)).toContain("pi-fzf");
	});

	test("an empty model chain is fatal and surfaces in the resolver check", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-doctor-"));
		seedHealthy(agentDir);
		const bad = { ...chains(), tools: [] };
		writeFileSync(join(agentDir, "model-routing.jsonc"), generateRoutingTemplate({ chains: bad }));
		const result = runDoctor(["--agent-dir", agentDir, "--json"]);
		expect(result.status).toBe(1);
		expect(result.json.ok).toBe(false);
		const fatalChecks = result.json.fatal.map((entry) => entry.check);
		assert.ok(fatalChecks.includes("non-empty-chains") || fatalChecks.includes("resolver"), "empty chain should be fatal");
	});
});
