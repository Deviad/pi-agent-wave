#!/usr/bin/env node
/**
 * Installs `<agent dir>/scripts/delegate-ledger`, the launcher for the package's story-ledger command.
 *
 * The launcher only `exec`s the package's own `scripts/delegate-ledger` by absolute path, so the command
 * line lives in the package and nothing has to discover the package from `settings.json`. Re-run after
 * moving the package. Defaults to dry-run; `apply` writes after recording a backup; `rollback --manifest`
 * restores the previous file or removes a launcher this installer created.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveAgentDir } from "../lib/agent-paths.mjs";
import { packageRoot, shellQuote } from "../lib/pi-fzf.mjs";
import { createBackup, defaultBackupId, finalizeBackup, restoreBackup, writeExact } from "../lib/safe-write.mjs";

const MODES = ["dry-run", "apply", "rollback"];
const LAUNCHER = join("scripts", "delegate-ledger");
const LAUNCHER_MODE = 0o755;

export function parseArgs(argv) {
	const args = { mode: "dry-run", agentDir: undefined, force: false, backupId: undefined, manifest: undefined, help: false };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (MODES.includes(value)) args.mode = value;
		else if (value === "--agent-dir") args.agentDir = argv[++index];
		else if (value === "--force") args.force = true;
		else if (value === "--backup-id") args.backupId = argv[++index];
		else if (value === "--manifest") args.manifest = argv[++index];
		else if (value === "--help" || value === "-h") args.help = true;
		else throw new Error(`unknown argument '${value}'`);
	}
	return args;
}

export function usage() {
	return [
		"usage: pi-agent-wave-install-ledger [dry-run|apply|rollback] [options]",
		"",
		"  Installs <agent dir>/scripts/delegate-ledger, a launcher for this package's ledger command.",
		"  Modes default to dry-run (no writes). `rollback --manifest <path>` undoes an apply.",
		"",
		"  --agent-dir <path>   explicit Pi agent directory (else PI_CODING_AGENT_DIR, else ~/.pi/agent)",
		"  --force              back up and replace a differing existing file",
		"  --backup-id <id>     override the backup id",
	].join("\n");
}

/** The launcher's exact bytes for the package at `root`. */
export function launcherText(root = packageRoot()) {
	return [
		"#!/bin/sh",
		"# Installed by pi-agent-wave-install-ledger: runs the pi-agent-wave story ledger command.",
		"# Re-run the installer after moving the package.",
		`exec ${shellQuote(join(root, "scripts", "delegate-ledger"))} "$@"`,
		"",
	].join("\n");
}

export async function runInstallLedger(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) return { schemaVersion: 1, mode: args.mode, ok: true, help: usage() };
	if (args.mode === "rollback") {
		if (!args.manifest) throw new Error("rollback requires --manifest");
		const restored = await restoreBackup(args.manifest);
		return { schemaVersion: 1, mode: "rollback", ok: true, manifest: args.manifest, restored: restored.restored.map((entry) => entry.destination) };
	}
	const agentDir = resolveAgentDir(args.agentDir);
	const path = join(agentDir, LAUNCHER);
	const bytes = Buffer.from(launcherText(), "utf8");
	const exists = existsSync(path);
	const existing = exists ? await readFile(path) : undefined;
	const existingMode = exists ? (await stat(path)).mode & 0o777 : undefined;
	const action = !exists ? "create" : existing.equals(bytes) && existingMode === LAUNCHER_MODE ? "no-change" : "replace";
	const result = { schemaVersion: 1, mode: args.mode, ok: true, agentDir, path, target: join(packageRoot(), "scripts", "delegate-ledger"), action, force: args.force };
	if (args.mode === "dry-run") return result;
	if (action === "no-change") return { ...result, changed: false, backupPath: null };
	if (action === "replace" && !args.force) return { ...result, ok: false, error: "an existing delegate-ledger differs; re-run with --force to back it up and replace it" };

	const backup = await createBackup({
		agentDir,
		id: args.backupId ?? defaultBackupId(),
		entries: [exists ? { relativePath: LAUNCHER, path, existed: true, bytes: existing, mode: existingMode } : { relativePath: LAUNCHER, path, existed: false, bytes: Buffer.alloc(0) }],
	});
	try {
		await writeExact(path, bytes, LAUNCHER_MODE);
	} catch (error) {
		await restoreBackup(backup.manifestPath).catch(() => undefined);
		throw error;
	}
	await finalizeBackup(backup.manifestPath, "applied");
	return { ...result, changed: true, backupPath: backup.manifestPath };
}

const isMain = ["install-ledger.mjs", "pi-agent-wave-install-ledger"].includes(basename(process.argv[1] ?? ""));
if (isMain) {
	try {
		const result = await runInstallLedger();
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		process.exitCode = result.ok === false ? 1 : 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
