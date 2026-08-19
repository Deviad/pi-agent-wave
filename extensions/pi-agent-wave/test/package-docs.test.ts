import { describe, expect, test } from "./test-api.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");

describe("package documentation", () => {
	test("documents supported installation, operation, and recovery", () => {
		const readme = read("README.md");
		const normalized = readme.toLowerCase();
		for (const text of [
			"npm:@dpugliese/pi-agent-wave",
			"git:",
			"herdr",
			"visible panel",
			"migration",
			"rollback",
			"pi-fzf",
			"delegate-model",
			"route-picker.ts",
			"uninstall",
			"0.84.1",
			"0.84.2",
		]) expect(normalized).toContain(text);
		expect(readme).toContain("PI_CODING_AGENT_DIR");
		expect(normalized).toContain("full system access");
		expect(normalized).toContain("review the source");
	});

	test("documents the initializer and doctor onboarding flow", () => {
		const readme = read("README.md");
		const normalized = readme.toLowerCase();
		for (const text of [
			"pi-agent-wave-init",
			"pi-agent-wave-doctor",
			"dry-run",
			"--force",
			"--non-interactive",
			"local-fast",
			"--json",
			"migration-backups/pi-agent-wave-init",
		]) expect(normalized).toContain(text);
	});

	test("documents Pi commands, automation tools, and runtime scenarios", () => {
		const readme = read("README.md");
		const normalized = readme.toLowerCase();
		for (const text of [
			"/delegate [--policy <auto|cheap|balanced|strong|local|long-context>] <task>",
			"/graph status <runId>",
			"/graph log <runId> [--tail <count>] [--agent <name>]",
			"/graph focus <runId> <node-or-agent>",
			"/graph resume <runId> <operationId>",
			"/graph prune [days]",
			"/failover enable <tier>",
			"/failover status",
			"/failover unlock <tier>",
			"delegate_graph",
			"questionnaire",
			"pi-agent-wave-init [dry-run|apply|rollback]",
			"pi-agent-wave-migrate [preflight|dry-run|apply|rollback]",
			"--package-source",
			"panel-backed runs do not support this focus command",
		]) expect(readme).toContain(text);
		for (const text of [
			"build delegation",
			"research delegation",
			"observable worker transport",
			"headless or api-driven delegation",
			"route-exhausted",
			"unavailable or unauthenticated",
			"manual model selection",
			"exact-model lock",
			"semantic, invalid-request, refusal, context-overflow",
		]) expect(normalized).toContain(text);
	});

	test("ships the approved MIT license", () => {
		const manifest = JSON.parse(read("package.json"));
		const license = read("LICENSE");
		expect(manifest.license).toBe("MIT");
		expect(license).toContain("MIT License");
		expect(license).toContain("Copyright (c) 2026 dpugliese");
		expect(license).toContain("Permission is hereby granted, free of charge");
	});
});
