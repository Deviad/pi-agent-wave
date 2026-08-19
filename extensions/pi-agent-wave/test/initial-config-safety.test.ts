import { describe, expect, test } from "./test-api.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPiFzf, fzfCommandTargets, mergeFzf, shellQuote } from "../lib/pi-fzf.mjs";
import { createBackup, defaultBackupId, isValidBackupId, restoreBackup, writeExact } from "../lib/safe-write.mjs";

describe("safe-write", () => {
	test("writeExact writes atomically with private permissions and no temp residue", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-wave-safe-"));
		const target = join(dir, "routing.jsonc");
		await writeExact(target, Buffer.from("content\n"), 0o600);
		expect(readFileSync(target, "utf8")).toBe("content\n");
		expect(existsSync(target)).toBe(true);
		// private mode: no group/other bits
		const { statSync } = await import("node:fs");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	test("writeExact leaves no temp file and the target unchanged on failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-wave-safe-"));
		const target = join(dir, "occupied");
		mkdirSync(target); // target is a directory, so rename must fail
		await assert.rejects(writeExact(target, Buffer.from("x"), 0o600));
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
		expect(existsSync(target)).toBe(true);
	});

	test("isValidBackupId and defaultBackupId constrain the namespace", () => {
		expect(isValidBackupId("backup-1")).toBe(true);
		expect(isValidBackupId("2026-08-19T17-26-25-927Z")).toBe(true);
		expect(isValidBackupId("..")).toBe(false);
		expect(isValidBackupId("")).toBe(false);
		expect(isValidBackupId("has space")).toBe(false);
		expect(isValidBackupId("a/b")).toBe(false);
		const id = defaultBackupId(new Date("2026-08-19T17:26:25.927Z"));
		expect(id).toBe("2026-08-19T17-26-25-927Z");
	});

	test("createBackup and restoreBackup round-trip byte-exactly", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-backup-"));
		const routing = join(agentDir, "model-routing.jsonc");
		const fzf = join(agentDir, "fzf.json");
		writeFileSync(routing, "ORIGINAL ROUTING\n");
		writeFileSync(fzf, "ORIGINAL FZF\n");
		const backup = await createBackup({
			agentDir,
			id: "round-trip",
			entries: [
				{ relativePath: "model-routing.jsonc", path: routing, existed: true, bytes: readFileSync(routing) },
				{ relativePath: "fzf.json", path: fzf, existed: true, bytes: readFileSync(fzf) },
			],
		});
		expect(backup.manifestPath).toContain(join("migration-backups", "pi-agent-wave-init", "round-trip"));
		expect(backup.manifest.entries).toHaveLength(2);
		writeFileSync(routing, "MUTATED ROUTING\n");
		writeFileSync(fzf, "MUTATED FZF\n");
		const result = await restoreBackup(backup.manifestPath);
		expect(readFileSync(routing, "utf8")).toBe("ORIGINAL ROUTING\n");
		expect(readFileSync(fzf, "utf8")).toBe("ORIGINAL FZF\n");
		expect(result.manifest.status).toBe("rolled-back");
		expect(result.restored.map((entry) => entry.relativePath)).toEqual(["model-routing.jsonc", "fzf.json"]);
	});

	test("restoreBackup rejects a manifest with a tampered sha256", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-backup-"));
		const routing = join(agentDir, "model-routing.jsonc");
		writeFileSync(routing, "ORIGINAL\n");
		const backup = await createBackup({
			agentDir,
			id: "tamper-sha",
			entries: [{ relativePath: "model-routing.jsonc", path: routing, existed: true, bytes: readFileSync(routing) }],
		});
		const manifest = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
		manifest.entries[0].sha256 = "0".repeat(64);
		writeFileSync(backup.manifestPath, JSON.stringify(manifest, null, 2));
		await assert.rejects(restoreBackup(backup.manifestPath), /integrity check/);
	});

	test("restoreBackup rejects a manifest whose entry path is tampered", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-backup-"));
		const routing = join(agentDir, "model-routing.jsonc");
		writeFileSync(routing, "ORIGINAL\n");
		const backup = await createBackup({
			agentDir,
			id: "tamper-path",
			entries: [{ relativePath: "model-routing.jsonc", path: routing, existed: true, bytes: readFileSync(routing) }],
		});
		const manifest = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
		manifest.entries[0].relativePath = "../escape.json";
		writeFileSync(backup.manifestPath, JSON.stringify(manifest, null, 2));
		await assert.rejects(restoreBackup(backup.manifestPath), /escapes the agent directory/);
	});
});

describe("pi-fzf", () => {
	test("detectPiFzf reads the settings.json packages array", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-wave-fzf-"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-fzf", "npm:other"] }));
		expect(detectPiFzf(agentDir).installed).toBe(true);

		const absent = mkdtempSync(join(tmpdir(), "pi-agent-wave-fzf-"));
		expect(detectPiFzf(absent).installed).toBe(false);
		expect(detectPiFzf(absent).reason).toBe("settings.json absent");

		writeFileSync(join(absent, "settings.json"), JSON.stringify({ packages: ["npm:other"] }));
		expect(detectPiFzf(absent).installed).toBe(false);
	});

	test("mergeFzf adds route and delegate-model commands and preserves unrelated commands", () => {
		const original = {
			commands: {
				file: { list: "fd --type f", action: { type: "editor" } },
				route: { action: { type: "send", template: "/route {{selected}}" }, shortcut: "ctrl+r" },
			},
		};
		const result = mergeFzf(original, "/pkg/route-picker.ts");
		expect(result.changed).toBe(true);
		expect(result.collisions).toEqual([]);
		expect(result.parsed.commands.file).toEqual(original.commands.file);
		expect(result.parsed.commands.route.shortcut).toBe("ctrl+r");
		expect(result.parsed.commands.route.list).toContain("/pkg/route-picker.ts");
		expect(result.parsed.commands.route.list).toContain("--list");
		expect(result.parsed.commands.route.preview).toContain("--preview");
		expect(result.parsed.commands.route.action).toEqual({ type: "send", template: "/route {{selected}}" });
		expect(result.parsed.commands["delegate-model"].list).toContain("--list");
		expect(result.parsed.commands["delegate-model"].action).toEqual({ type: "send", template: "/route {{selected}}" });
	});

	test("mergeFzf reports collisions when existing list, preview, or action differ", () => {
		const original = { commands: { route: { list: "old-list", preview: "old-preview", action: { type: "editor", template: "custom" } } } };
		const result = mergeFzf(original, "/pkg/route-picker.ts");
		expect(result.changed).toBe(true);
		expect(result.collisions).toEqual([
			{ command: "route", field: "list", existing: "old-list" },
			{ command: "route", field: "preview", existing: "old-preview" },
			{ command: "route", field: "action", existing: { type: "editor", template: "custom" } },
		]);
	});

	test("mergeFzf reports no change when targets already match", () => {
		const targets = fzfCommandTargets("/pkg/route-picker.ts");
		const original = { commands: { route: targets.route, "delegate-model": targets["delegate-model"] } };
		const result = mergeFzf(original, "/pkg/route-picker.ts");
		expect(result.changed).toBe(false);
		expect(result.collisions).toEqual([]);
	});

	test("shellQuote escapes embedded single quotes", () => {
		expect(shellQuote("/path/with'quote")).toBe(`'/path/with'\\''quote'`);
		expect(shellQuote("plain")).toBe("'plain'");
	});
});
