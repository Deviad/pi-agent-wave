import { describe, expect, test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DELEGATE_GRAPH_ROLES, REQUIRED_TIERS } from "../lib/routing-template.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const INIT_BIN = manifest.bin["pi-agent-wave-init"];
const DOCTOR_BIN = manifest.bin["pi-agent-wave-doctor"];

const SENTINEL = "INIT_SECRET_SENTINEL_987654321";

function catalogJson() {
	return JSON.stringify(
		{
			providers: {
				localp: { baseUrl: "http://127.0.0.1:9999/v1", models: [{ id: "fast", name: "Local Fast", contextWindow: 128000 }] },
				cloudp: { baseUrl: "https://api.example.com", models: [{ id: "big", name: "Cloud Big", contextWindow: 1000000 }, { id: "small", name: "Cloud Small", contextWindow: 200000 }] },
				secretp: { baseUrl: "https://secret.example.com", apiKey: SENTINEL, models: [{ id: "hidden", name: "Hidden" }] },
			},
		},
		null,
		2,
	);
}

function fixture(extra = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-init-"));
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), extra.catalog ?? catalogJson());
	if (extra.settings) writeFileSync(join(agentDir, "settings.json"), extra.settings);
	if (extra.fzf) writeFileSync(join(agentDir, "fzf.json"), extra.fzf);
	return agentDir;
}

const TIER_FLAGS = [
	"--tools", "localp/fast",
	"--coding", "cloudp/big",
	"--test", "cloudp/small",
	"--review", "cloudp/big",
	"--reasoning", "cloudp/big",
	"--long-context", "cloudp/big",
];

function runInit(args, env = {}) {
	const result = spawnSync(process.execPath, [join(ROOT, INIT_BIN), ...args], {
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

function routingHash(agentDir) {
	const path = join(agentDir, "model-routing.jsonc");
	if (!existsSync(path)) return undefined;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("pi-agent-wave-init", () => {
	test("declares the init and doctor bins targeting package scripts", () => {
		expect(INIT_BIN).toBe(join("scripts", "init.mjs"));
		expect(DOCTOR_BIN).toBe(join("scripts", "doctor.mjs"));
		expect(existsSync(join(ROOT, INIT_BIN))).toBe(true);
		expect(existsSync(join(ROOT, DOCTOR_BIN))).toBe(true);
	});

	test("dry-run is the default and writes nothing", () => {
		const agentDir = fixture();
		const before = routingHash(agentDir);
		const result = runInit(["--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.mode).toBe("dry-run");
		expect(result.json.ok).toBe(true);
		expect(routingHash(agentDir)).toBe(before);
		expect(existsSync(join(agentDir, "model-routing.jsonc"))).toBe(false);
		expect(existsSync(join(agentDir, "fzf.json"))).toBe(false);
	});

	test("resolves the catalog from --models, then PI_MODEL_CATALOG, then the agent directory", () => {
		const agentDir = fixture();
		const altDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-alt-"));
		writeFileSync(join(altDir, "models.json"), catalogJson());

		// explicit --models wins
		const explicit = runInit(["--agent-dir", agentDir, "--models", join(altDir, "models.json"), ...TIER_FLAGS]);
		expect(explicit.status).toBe(0);
		expect(explicit.json.modelsPath).toBe(join(altDir, "models.json"));

		// PI_MODEL_CATALOG wins over the agent-dir default
		const envCatalog = runInit(["--agent-dir", agentDir, ...TIER_FLAGS], { PI_MODEL_CATALOG: join(altDir, "models.json") });
		expect(envCatalog.status).toBe(0);
		expect(envCatalog.json.modelsPath).toBe(join(altDir, "models.json"));

		// agent-dir default
		const defaultCatalog = runInit(["--agent-dir", agentDir, ...TIER_FLAGS], { PI_MODEL_CATALOG: "" });
		expect(defaultCatalog.json.modelsPath).toBe(join(agentDir, "models.json"));
	});

	test("dry-run output lists paths, selections, roles, pi-fzf action, and validation without leaking credentials", () => {
		const agentDir = fixture();
		const result = runInit(["--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.routingPath).toBe(join(agentDir, "model-routing.jsonc"));
		expect(result.json.modelsPath).toBe(join(agentDir, "models.json"));
		expect(result.json.fzfPath).toBe(join(agentDir, "fzf.json"));
		expect(result.json.selectedModels.tools).toEqual(["localp/fast"]);
		expect(result.json.selectedModels["long-context"]).toEqual(["cloudp/big"]);
		expect(result.json.roles).toHaveLength(6);
		expect(result.json.roles.map((role) => role.role).sort()).toEqual([...DELEGATE_GRAPH_ROLES].sort());
		expect(result.json.piFzf.action).toBe("skip");
		expect(result.json.validation.ok).toBe(true);
		expect(result.stdout).not.toContain(SENTINEL);
	});

	test("apply writes the routing atomically with private permissions and the planned structure", () => {
		const agentDir = fixture();
		const plan = runInit(["--agent-dir", agentDir, ...TIER_FLAGS, "--local-fast", "localp/fast"]);
		const result = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS, "--local-fast", "localp/fast"]);
		expect(result.status).toBe(0);
		expect(result.json.ok).toBe(true);
		expect(result.json.routingWritten).toBe(true);

		const routingPath = join(agentDir, "model-routing.jsonc");
		expect(existsSync(routingPath)).toBe(true);
		expect(statSync(routingPath).mode & 0o777).toBe(0o600);
		const parsed = parseJsonc(readFileSync(routingPath, "utf8"));
		expect(Object.keys(parsed.tiers).sort()).toEqual([...REQUIRED_TIERS, "local-fast"].sort());
		expect(parsed.tiers.tools).toMatchObject({ models: ["localp/fast"], thinking: "off", session: false });
		expect(parsed.tiers.coding).toMatchObject({ models: ["cloudp/big"], thinking: "high", session: true });
		expect(parsed.tiers.test).toMatchObject({ models: ["cloudp/small"], thinking: "low", session: false });
		expect(parsed.tiers.review).toMatchObject({ models: ["cloudp/big"], thinking: "xhigh", session: true });
		expect(parsed.tiers.reasoning).toMatchObject({ models: ["cloudp/big"], thinking: "high", session: true });
		expect(parsed.tiers["long-context"]).toMatchObject({ models: ["cloudp/big"], thinking: "medium", session: true });
		expect(parsed.tiers["local-fast"]).toMatchObject({ models: ["localp/fast"], thinking: "off", session: false });
		for (const role of DELEGATE_GRAPH_ROLES) assert.ok(parsed.roles[role], `missing role ${role}`);
		// the written file matches the dry-run plan's selected models
		for (const tier of [...REQUIRED_TIERS, "local-fast"]) {
			expect(parsed.tiers[tier].models).toEqual(plan.json.selectedModels[tier]);
		}
		expect(readFileSync(routingPath, "utf8")).not.toContain(SENTINEL);
	});

	test("existing routing fails closed without --force and --force backs up before replacing", () => {
		const agentDir = fixture();
		const routingPath = join(agentDir, "model-routing.jsonc");
		writeFileSync(routingPath, "{\"default_tier\":\"tools\"}\n");
		const original = readFileSync(routingPath, "utf8");

		const refused = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(refused.status).toBe(1);
		expect(refused.json.ok).toBe(false);
		expect(refused.json.needsForce).toBe(true);
		expect(readFileSync(routingPath, "utf8")).toBe(original);

		const forced = runInit(["apply", "--force", "--backup-id", "overwrite-proof", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(forced.status).toBe(0);
		expect(forced.json.ok).toBe(true);
		expect(forced.json.backupPath).toContain(join("migration-backups", "pi-agent-wave-init", "overwrite-proof"));
		expect(forced.json.backupPath).not.toContain(join("extensions"));
		expect(readFileSync(routingPath, "utf8")).not.toBe(original);

		// byte-exact rollback restores the original routing
		const rolled = runInit(["rollback", "--manifest", forced.json.backupPath]);
		expect(rolled.status).toBe(0);
		expect(readFileSync(routingPath, "utf8")).toBe(original);
	});

	test("re-applying the same selections is idempotent", () => {
		const agentDir = fixture();
		const first = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(first.status).toBe(0);
		const hash = routingHash(agentDir);
		const second = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(second.status).toBe(0);
		expect(second.json.idempotent).toBe(true);
		expect(second.json.changed).toBe(false);
		expect(routingHash(agentDir)).toBe(hash);
	});

	test("catalog corruption, unavailable selections, and invalid existing fzf leave the target unchanged while duplicate ids only warn", () => {
		// invalid catalog JSON
		const badCatalog = fixture({ catalog: "{ not json " });
		expect(runInit(["apply", "--agent-dir", badCatalog, ...TIER_FLAGS]).status).toBe(1);
		expect(existsSync(join(badCatalog, "model-routing.jsonc"))).toBe(false);

		// duplicate model identifier
		const dupCatalog = fixture({ catalog: JSON.stringify({ providers: { p: { models: [{ id: "x" }, { id: "x" }] } } }) });
		const dupResult = runInit(["apply", "--agent-dir", dupCatalog, "--tools", "p/x", "--coding", "p/x", "--test", "p/x", "--review", "p/x", "--reasoning", "p/x", "--long-context", "p/x"]);
		expect(dupResult.status).toBe(0);
		expect(dupResult.json.warnings.join(" ")).toContain("duplicate model identifier");
		expect(existsSync(join(dupCatalog, "model-routing.jsonc"))).toBe(true);

		// unavailable selection
		const unavailable = fixture();
		const unavailableResult = runInit(["apply", "--agent-dir", unavailable, "--tools", "nope/missing", "--coding", "cloudp/big", "--test", "cloudp/small", "--review", "cloudp/big", "--reasoning", "cloudp/big", "--long-context", "cloudp/big"]);
		expect(unavailableResult.status).toBe(1);
		expect(unavailableResult.json.errors.join(" ")).toContain("unavailable model");
		expect(existsSync(join(unavailable, "model-routing.jsonc"))).toBe(false);

		// invalid existing fzf.json blocks a would-be merge without writing routing
		const invalidFzf = fixture({ settings: JSON.stringify({ packages: ["npm:pi-fzf"] }), fzf: "{ not json " });
		const invalidFzfResult = runInit(["apply", "--agent-dir", invalidFzf, ...TIER_FLAGS]);
		expect(invalidFzfResult.status).toBe(1);
		expect(existsSync(join(invalidFzf, "model-routing.jsonc"))).toBe(false);
	});

	test("real-shape catalogs keep valid models selectable while warning about slashed local ids", () => {
		const catalog = JSON.parse(catalogJson());
		catalog.providers.vmlx = {
			baseUrl: "http://127.0.0.1:1234/v1",
			models: [{ id: "Deviad/DeepSeek-V4-Flash-MLX-Q4Q8" }, { id: "plain-local" }],
		};
		const agentDir = fixture({ catalog: JSON.stringify(catalog) });
		const result = runInit(["--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.ok).toBe(true);
		expect(result.json.warnings.join(" ")).toContain("Deviad/DeepSeek-V4-Flash-MLX-Q4Q8");
		expect(result.json.models.map((model) => model.modelId)).toContain("vmlx/plain-local");
		expect(existsSync(join(agentDir, "model-routing.jsonc"))).toBe(false);
	});

	test("absent pi-fzf is skipped and never creates fzf.json", () => {
		const agentDir = fixture();
		const result = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.piFzf.action).toBe("skip");
		expect(existsSync(join(agentDir, "fzf.json"))).toBe(false);
	});

	test("present pi-fzf merges route/delegate-model commands that execute and list all six roles", () => {
		const agentDir = fixture({
			settings: JSON.stringify({ packages: ["npm:pi-fzf", "npm:other"] }),
			fzf: JSON.stringify({ commands: { file: { list: "fd --type f" }, notify: { list: "printf x" } } }),
		});
		const result = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.piFzf.installed).toBe(true);
		expect(result.json.piFzf.action).toBe("merge");

		const fzf = JSON.parse(readFileSync(join(agentDir, "fzf.json"), "utf8"));
		expect(fzf.commands.file.list).toBe("fd --type f");
		expect(fzf.commands.notify.list).toBe("printf x");
		expect(fzf.commands.route.list).toContain("--list");
		expect(fzf.commands["delegate-model"].list).toContain("--list");

		// execute the generated list command and confirm all six roles are listed
		const exec = spawnSync("bash", ["-lc", fzf.commands.route.list], {
			encoding: "utf8",
			env: { ...process.env, PI_MODEL_ROUTING: join(agentDir, "model-routing.jsonc") },
		});
		expect(exec.status).toBe(0);
		const listed = exec.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		for (const role of DELEGATE_GRAPH_ROLES) expect(listed).toContain(role);
	});

	test("pi-fzf present with an absent fzf.json creates a minimal file with send actions", () => {
		const agentDir = fixture({ settings: JSON.stringify({ packages: ["npm:pi-fzf"] }) });
		const result = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		expect(result.json.piFzf.installed).toBe(true);
		expect(result.json.piFzf.action).toBe("merge");
		const fzf = JSON.parse(readFileSync(join(agentDir, "fzf.json"), "utf8"));
		expect(fzf.commands.route.list).toContain("--list");
		expect(fzf.commands.route.preview).toContain("--preview");
		expect(fzf.commands.route.action).toEqual({ type: "send", template: "/route {{selected}}" });
		expect(fzf.commands["delegate-model"].action).toEqual({ type: "send", template: "/route {{selected}}" });
	});

	test("the generated routing resolves under the real policy resolver", () => {
		const agentDir = fixture();
		const result = runInit(["apply", "--agent-dir", agentDir, ...TIER_FLAGS]);
		expect(result.status).toBe(0);
		const resolver = spawnSync(
			process.execPath,
			[
				join(ROOT, "scripts", "policy-resolver.mjs"),
				"--config", join(agentDir, "model-routing.jsonc"),
				"--models", join(agentDir, "models.json"),
				"--roles", DELEGATE_GRAPH_ROLES.join(","),
				"--input", JSON.stringify({ kind: "auto" }),
			],
			{ encoding: "utf8" },
		);
		expect(resolver.status).toBe(0);
		const resolved = JSON.parse(resolver.stdout);
		expect(resolved.ok).toBe(true);
		expect(resolved.roles).toHaveLength(DELEGATE_GRAPH_ROLES.length);
		for (const route of resolved.roles) {
			assert.ok(Array.isArray(route.models) && route.models.length > 0, `role ${route.role} resolved to an empty chain`);
		}
	});

	test("interactive mode covers every required tier from stdin", () => {
		const agentDir = fixture();
		const child = spawnSync(process.execPath, [join(ROOT, INIT_BIN), "--agent-dir", agentDir], {
			encoding: "utf8",
			input: "1\n2\n2\n1\n2\n1\nn\n",
			env: { ...process.env },
		});
		expect(child.status).toBe(0);
		const json = JSON.parse(child.stdout);
		expect(json.interactive).toBe(true);
		for (const tier of REQUIRED_TIERS) expect(json.selectedModels[tier]).toHaveLength(1);
		expect(json.selectedModels["local-fast"]).toBeUndefined();
	});
});
