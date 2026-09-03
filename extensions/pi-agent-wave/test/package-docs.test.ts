import { describe, expect, test } from "./test-api.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = join(ROOT, "..", "..");
const packageReadme = () => readFileSync(join(ROOT, "README.md"), "utf8");
const rootReadme = () => readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
const task = (name: string) => readFileSync(join(REPOSITORY_ROOT, "tasks", name), "utf8");

describe("package documentation", () => {
	test("scope records authorize Air/headless with optional Herdr while preserving safety invariants", () => {
		const airPrd = "tasks/prd-air-controlled-editor-independent-orchestration.md";
		for (const name of ["prd-package-delegate-graph.md", "prd-require-herdr.md", "prd-production-acpx-worker-backend.md"]) {
			const text = task(name);
			expect(text).toContain(airPrd);
			expect(text.toLowerCase()).toContain("optional");
		}
		const umbrella = task("prd-package-delegate-graph.md");
		for (const invariant of ["ACPX-only", "AgentFS", "frozen", "graph", "settlement", "evidence"]) expect(umbrella).toContain(invariant);
		const production = task("prd-production-acpx-worker-backend.md");
		for (const contract of ["`/delegate`", "`/graph`", "`delegate_graph`", "transport-aware settlement"]) expect(production).toContain(contract);
	});
	test("root README explains the product and user journey in plain sections", () => {
		const readme = rootReadme();
		for (const heading of ["# pi-agent-wave", "## Why use it?", "## Requirements", "## 1. Install ACPX and AgentFS", "## 2. Install pi-agent-wave", "## 3. Add Pi to JetBrains Air", "## 4. Run from Air", "## Optional: Herdr presentation", "## Uninstall"]) {
			expect(readme).toContain(heading);
		}
		for (const text of ["Control Pi from Air", "Keep complex work ordered", "Require proof", "Keep presentation optional"]) {
			expect(readme).toContain(text);
		}
		expect(readme).toContain("A graph");
		expect(readme.includes("development and research harness")).toBe(false);
	});

	test("documents Air/headless operation and optional Herdr presentation", () => {
		const contradictions = [
			/Herdr remains the sole visible transport/i,
			/JetBrains Air is intentionally unsupported/i,
			/Herdr is the only worker transport/i,
			/If Herdr is unavailable, the package fails/i,
		];
		for (const readme of [rootReadme(), packageReadme()]) {
			for (const text of ["pi-acp@0.0.31", "headless", "optional", "Herdr", "delegate_graph"]) expect(readme).toContain(text);
			expect(readme).not.toContain("Herdr is required");
			expect(/visible[- ]panel|panel transport|panel-backed/i.test(readme)).toBe(false);
			for (const contradiction of contradictions) expect(readme).not.toMatch(contradiction);
		}
		for (const text of ["Add ACP Agent", "acp.json", "command -v npx", "Air launches and owns the Pi ACP process"]) expect(rootReadme()).toContain(text);
	});

	test("documents mandatory ACPX-only execution and AgentFS sandboxing", () => {
		for (const readme of [rootReadme(), packageReadme()]) {
			for (const text of ["ACPX `0.13.2`", "AgentFS `0.6.4`", "npm install -g acpx@0.13.2", "acpx --version", "agentfs --version", "https://github.com/tursodatabase/agentfs/releases/tag/v0.6.4"]) expect(readme).toContain(text);
			expect(readme).toContain("copy-on-write");
			expect(readme).toContain("external");
			expect(readme).toContain("claude setup-token");
			expect(readme).toContain("PI_CLAUDE_OAUTH_TOKEN_FILE");
			expect(readme).toContain("production-audit.ts");
			expect(readme).toContain("--no-terminal");
		}
	});

	test("documents working source install, future npm install, operation, and uninstall", () => {
		for (const readme of [rootReadme(), packageReadme()]) {
			for (const text of [
				"pi install ./pi-agent-wave-new-design/extensions/pi-agent-wave",
				"has not been published yet",
				"pi install npm:@dpugliese/pi-agent-wave",
				"node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs",
				"node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/init.mjs apply",
				"node ./pi-agent-wave-new-design/extensions/pi-agent-wave/scripts/doctor.mjs",
				"After npm publication, the package binaries will be",
				"pi-agent-wave-init apply",
				"pi-agent-wave-doctor",
				"/delegate Implement tenant-scoped API keys",
				"/graph status <runId>",
				"/graph log <runId>",
				"pi remove ./pi-agent-wave-new-design/extensions/pi-agent-wave",
				"pi remove npm:@dpugliese/pi-agent-wave",
			]) expect(readme).toContain(text);
			expect(readme).toMatch(/does not remove (optional )?Herdr/);
		}
	});

	test("keeps detailed commands, recovery, migration, and security reference", () => {
		const readme = packageReadme();
		const normalized = readme.toLowerCase();
		for (const text of [
			"/delegate [--policy <auto|cheap|balanced|strong|local|long-context>] <task>",
			"/graph log <runId> [--tail <count>] [--agent <name>]",
			"/graph focus <runId> <node-or-agent>",
			"/graph resume <runId> <operationId>",
			"delegate_graph",
			"/failover enable",
			"pi-agent-wave-migrate",
			"rollback --manifest",
			"pi-fzf",
			"delegate-model",
			"route-picker.ts",
			"0.84.1",
			"0.84.2",
		]) expect(readme).toContain(text);
		for (const text of ["dry-run", "--force", "--non-interactive", "local-fast", "--json", "migration-backups/pi-agent-wave-init"]) {
			expect(normalized).toContain(text);
		}
		expect(readme).toContain("PI_CODING_AGENT_DIR");
		expect(normalized).toContain("full system access");
		expect(normalized).toContain("review the source");
	});

	test("documents structured operational search and serialized ownership", () => {
		const packageText = packageReadme();
		for (const text of ["### Operational search delegation", '"graph": "operations"', '"command"', '"ownedPaths"', "first execution command", "ledgered automatically by operation ID", "cannot own the same path or SQLite database"]) expect(packageText).toContain(text);
		expect(rootReadme()).toContain("README.md#operational-search-delegation");
	});

	test("ships the approved MIT license text", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
		expect(manifest.license).toBe("MIT");
		expect(license).toContain("MIT License");
		expect(license).toContain("Copyright (c) 2026 dpugliese");
		expect(license).toContain("Permission is hereby granted, free of charge");
	});
});
