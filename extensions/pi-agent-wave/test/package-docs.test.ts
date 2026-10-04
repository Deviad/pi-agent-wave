import { describe, expect, test } from "./test-api.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = join(ROOT, "..", "..");
const packageReadme = () => readFileSync(join(ROOT, "README.md"), "utf8");
const rootReadme = () => readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
const planRecord = (name: string) => readFileSync(join(REPOSITORY_ROOT, name), "utf8");

describe("package documentation", () => {
	test("the plan record authorizes Air/headless with optional Herdr while preserving safety invariants", () => {
		// These assertions used to read the production PRDs, which were removed on 2026-09-21 (their history
		// is in git). The invariants and the public contracts they pinned are the same ones, now asserted
		// against the two documents that replaced the PRD set.
		const product = planRecord("product.md");
		const specification = planRecord("specification.md");
		for (const invariant of ["ACPX-only", "AgentFS", "frozen", "settlement", "evidence"]) expect(product).toContain(invariant);
		for (const invariant of ["ACPX", "AgentFS", "frozen", "settlement", "evidence"]) expect(specification).toContain(invariant);
		for (const text of ["optional", "Herdr", "headless", "Air"]) {
			expect(product).toContain(text);
			expect(specification).toContain(text);
		}
		for (const contract of ["/delegate", "/graph", "delegate_graph"]) {
			// The plain command names, not the backticked forms: the two documents mark them differently.
			expect(product).toContain(contract);
			expect(specification).toContain(contract);
		}
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

	test("states the wait contract once, in watch's own wording", () => {
		const packageText = packageReadme();
		expect(packageText.split("**Wait contract.**").length - 1).toBe(1);
		const contract = packageText.slice(packageText.indexOf("**Wait contract.**")).split("\n")[0];
		for (const text of ["own result file", "`process exited[ <code>], awaiting collect`", "not a settle signal", "advisory liveness probe"]) expect(contract).toContain(text);
		const watchRow = packageText.split("\n").find((line) => line.startsWith("| `watch` |")) ?? "";
		for (const text of ["`process exited[ <code>], awaiting collect`", "worker's own result file"]) expect(watchRow).toContain(text);
	});

	test("documents which status call returns a bounded task and which returns it in full", () => {
		const statusRow = packageReadme().split("\n").find((line) => line.startsWith("| `status` |")) ?? "";
		for (const text of ["optional `operationId`", "`task sha256=<hex> bytes=<n>", "full task", "`blocker=`"]) expect(statusRow).toContain(text);
		expect(planRecord("product.md")).toContain("`commands.ts:taskSummary`");
		expect(rootReadme()).toContain("pass an `operationId` to get that operation's full task");
	});

	test("documents the ledger command and its install step", () => {
		const packageText = packageReadme();
		for (const text of ["`scripts/delegate-ledger`", "scripts/install-ledger.mjs apply", "<agent dir>/scripts/delegate-ledger", "nothing\nis looked up in `settings.json`", "pi-agent-wave-install-ledger [dry-run|apply|rollback]"]) expect(packageText).toContain(text);
		expect(packageText.includes("PI_AGENT_WAVE_ROOT")).toBe(false);
	});

	test("documents input delivery, unattended preparation and retention limits", () => {
		for (const readme of [rootReadme(), packageReadme()]) {
			for (const text of ["inputs", "dispatchWorkspaceRoot", "32 MiB", "supervisor", "cancellation", "prune", "provenance"]) expect(readme).toContain(text);
		}
		for (const text of ["### Declared inputs and resource preparation", "same-user worker", "not filesystem confinement", "no content garbage collection", "pathIssues"]) expect(packageReadme()).toContain(text);
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
