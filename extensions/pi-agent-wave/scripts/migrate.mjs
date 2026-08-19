#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_SOURCE = "npm:@dpugliese/pi-agent-wave";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROUTE_PICKER = join(PACKAGE_ROOT, "route-picker.ts");
const FZF_RELATIVE_PATH = "fzf.json";
const FZF_COMMANDS = ["route", "delegate-model"];
const FZF_FIELDS = ["list", "preview"];
const LOOSE_PATHS = [
	"extensions/delegate-graph",
	"extensions/questionnaire.ts",
	"extensions/cmux-session.ts",
	"extensions/model-failover.ts",
];
const HERDR_MANAGED_PATH = "extensions/herdr-agent-state.ts";

function parseArgs(argv) {
	let mode = "dry-run";
	let agentDir;
	let packageSource = PACKAGE_SOURCE;
	let manifest;
	let backupId;
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (["preflight", "dry-run", "apply", "rollback"].includes(value)) mode = value;
		else if (value === "--agent-dir") agentDir = argv[++index];
		else if (value === "--package-source") packageSource = argv[++index];
		else if (value === "--manifest") manifest = argv[++index];
		else if (value === "--backup-id") backupId = argv[++index];
		else throw new Error(`unknown argument '${value}'`);
	}
	if (backupId && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId) || backupId === "." || backupId === "..")) {
		throw new Error("backup id must contain only letters, numbers, dots, underscores, and hyphens");
	}
	return {
		mode,
		agentDir: resolve(agentDir || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")),
		packageSource,
		manifest: manifest ? resolve(manifest) : undefined,
		backupId,
	};
}

function hashBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function hashPath(path) {
	const hash = createHash("sha256");
	function visit(current) {
		const stat = lstatSync(current);
		const name = relative(path, current) || ".";
		hash.update(`${name}\0${stat.isDirectory() ? "d" : "f"}\0${stat.mode & 0o777}\0`);
		if (stat.isDirectory()) for (const entry of readdirSync(current).sort()) visit(join(current, entry));
		else hash.update(readFileSync(current));
	}
	visit(path);
	return hash.digest("hex");
}

function packageIdentity(value) {
	return typeof value === "string" ? value : value && typeof value === "object" ? value.source : undefined;
}

function settingsWithPackage(bytes, packageSource) {
	const parsed = bytes ? JSON.parse(bytes.toString("utf8")) : {};
	if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) throw new Error("settings.json packages must be an array");
	parsed.packages = [...(parsed.packages ?? []).filter((entry) => packageIdentity(entry) !== packageSource), packageSource];
	return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function rewriteFzf(bytes, agentDir) {
	if (!bytes) return { bytes: undefined, replacements: 0 };
	const parsed = JSON.parse(bytes.toString("utf8"));
	const oldPaths = [
		"~/.pi/agent/extensions/delegate-graph/route-picker.ts",
		join(agentDir, "extensions", "delegate-graph", "route-picker.ts"),
	];
	const replacement = shellQuote(PACKAGE_ROUTE_PICKER);
	let replacements = 0;
	for (const commandName of FZF_COMMANDS) {
		const command = parsed?.commands?.[commandName];
		if (!command || typeof command !== "object") continue;
		for (const field of FZF_FIELDS) {
			if (typeof command[field] !== "string") continue;
			for (const oldPath of oldPaths) {
				const occurrences = command[field].split(oldPath).length - 1;
				if (occurrences > 0) {
					command[field] = command[field].replaceAll(oldPath, replacement);
					replacements += occurrences;
				}
			}
		}
	}
	return { bytes: Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`), replacements };
}

function backupName() {
	return new Date().toISOString().replace(/[.:]/g, "-");
}

function discover(agentDir) {
	return LOOSE_PATHS.flatMap((relativePath) => {
		const source = join(agentDir, relativePath);
		return existsSync(source) ? [{ relativePath, source, sha256: hashPath(source) }] : [];
	});
}

function preflight(options) {
	const settingsPath = join(options.agentDir, "settings.json");
	const fzfPath = join(options.agentDir, FZF_RELATIVE_PATH);
	const fzfBytes = existsSync(fzfPath) ? readFileSync(fzfPath) : undefined;
	const fzfRewrite = rewriteFzf(fzfBytes, options.agentDir);
	const configChanges = fzfRewrite.replacements > 0
		? [{ relativePath: FZF_RELATIVE_PATH, path: fzfPath, replacements: fzfRewrite.replacements, target: PACKAGE_ROUTE_PICKER }]
		: [];
	const conflicts = discover(options.agentDir);
	const backupRoot = join(options.agentDir, "migration-backups", "pi-agent-wave", options.backupId || backupName());
	return {
		schemaVersion: 1,
		mode: options.mode,
		agentDir: options.agentDir,
		packageSource: options.packageSource,
		settingsPath,
		fzfPath,
		configChanges,
		conflicts,
		excluded: [{ relativePath: HERDR_MANAGED_PATH, exists: existsSync(join(options.agentDir, HERDR_MANAGED_PATH)) }],
		backupRoot,
		manifestPath: join(backupRoot, "manifest.json"),
		operations: [
			...conflicts.map((item) => ({ type: "move", from: item.source, to: join(backupRoot, "files", item.relativePath) })),
			...configChanges.map((change) => ({ type: "rewrite-config", path: change.path, replacements: change.replacements, target: change.target })),
			{ type: "enable-package", settingsPath, source: options.packageSource },
		],
	};
}

async function writeExact(path, bytes, mode) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	await writeFile(temporary, bytes, mode === undefined ? undefined : { mode });
	await rename(temporary, path);
}

async function apply(options) {
	const plan = preflight(options);
	if (existsSync(plan.backupRoot)) throw new Error(`backup already exists: ${plan.backupRoot}`);
	const settingsBytes = existsSync(plan.settingsPath) ? await readFile(plan.settingsPath) : undefined;
	const fzfBytes = existsSync(plan.fzfPath) ? await readFile(plan.fzfPath) : undefined;
	const fzfMode = existsSync(plan.fzfPath) ? lstatSync(plan.fzfPath).mode & 0o777 : undefined;
	const fzfRewrite = rewriteFzf(fzfBytes, options.agentDir);
	if (settingsBytes) settingsWithPackage(settingsBytes, options.packageSource);
	const manifest = {
		...plan,
		status: "pending",
		settings: {
			existed: settingsBytes !== undefined,
			bytesBase64: settingsBytes?.toString("base64") ?? "",
			sha256: settingsBytes ? hashBytes(settingsBytes) : undefined,
		},
		fzf: fzfRewrite.replacements > 0 ? {
			path: plan.fzfPath,
			existed: fzfBytes !== undefined,
			bytesBase64: fzfBytes?.toString("base64") ?? "",
			sha256: fzfBytes ? hashBytes(fzfBytes) : undefined,
			mode: fzfMode,
			replacements: fzfRewrite.replacements,
		} : undefined,
	};
	await mkdir(plan.backupRoot, { recursive: true, mode: 0o700 });
	await chmod(plan.backupRoot, 0o700);
	await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	const moved = [];
	let fzfWritten = false;
	try {
		for (const item of plan.conflicts) {
			const destination = join(plan.backupRoot, "files", item.relativePath);
			await mkdir(dirname(destination), { recursive: true });
			await rename(item.source, destination);
			moved.push({ ...item, destination });
		}
		if (fzfRewrite.replacements > 0 && fzfRewrite.bytes) {
			await writeExact(plan.fzfPath, fzfRewrite.bytes, fzfMode);
			fzfWritten = true;
		}
		await writeExact(plan.settingsPath, settingsWithPackage(settingsBytes, options.packageSource));
		manifest.status = "applied";
		manifest.moved = moved;
		await writeExact(plan.manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
		return manifest;
	} catch (error) {
		for (const item of moved.reverse()) {
			await mkdir(dirname(item.source), { recursive: true });
			if (existsSync(item.destination) && !existsSync(item.source)) await rename(item.destination, item.source);
		}
		if (fzfWritten) {
			if (fzfBytes) await writeExact(plan.fzfPath, fzfBytes, fzfMode);
			else if (existsSync(plan.fzfPath)) await unlink(plan.fzfPath);
		}
		if (settingsBytes) await writeExact(plan.settingsPath, settingsBytes);
		else if (existsSync(plan.settingsPath)) await unlink(plan.settingsPath);
		throw error;
	}
}

function validateRollbackManifest(manifest, manifestPath) {
	if (!manifest || typeof manifest !== "object") throw new Error("invalid rollback manifest");
	const agentDir = resolve(String(manifest.agentDir ?? ""));
	const backupRoot = resolve(String(manifest.backupRoot ?? ""));
	const expectedBackupParent = join(agentDir, "migration-backups", "pi-agent-wave");
	if (!backupRoot.startsWith(`${expectedBackupParent}/`) || resolve(manifestPath) !== join(backupRoot, "manifest.json")) {
		throw new Error("manifest path is outside the approved backup location");
	}
	if (resolve(String(manifest.settingsPath ?? "")) !== join(agentDir, "settings.json")) throw new Error("manifest path mismatch for settings");
	if (!Array.isArray(manifest.moved) || !manifest.settings || typeof manifest.settings !== "object") throw new Error("invalid rollback manifest contents");
	if (manifest.fzf) {
		if (resolve(String(manifest.fzf.path ?? "")) !== join(agentDir, FZF_RELATIVE_PATH)) throw new Error("manifest path mismatch for fzf config");
		if (typeof manifest.fzf.bytesBase64 !== "string" || typeof manifest.fzf.existed !== "boolean") throw new Error("invalid fzf rollback data");
	}
	for (const item of manifest.moved) {
		if (!LOOSE_PATHS.includes(item.relativePath)) throw new Error("manifest path contains an unknown loose extension");
		if (resolve(String(item.source ?? "")) !== join(agentDir, item.relativePath)) throw new Error("manifest path mismatch for restore source");
		if (resolve(String(item.destination ?? "")) !== join(backupRoot, "files", item.relativePath)) throw new Error("manifest path mismatch for backup source");
	}
}

async function rollback(options) {
	if (!options.manifest) throw new Error("rollback requires --manifest");
	const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
	if (manifest.status !== "applied") throw new Error(`manifest status must be applied, got '${manifest.status}'`);
	validateRollbackManifest(manifest, options.manifest);
	for (const item of manifest.moved ?? []) {
		if (!existsSync(item.destination)) throw new Error(`backup path missing: ${item.destination}`);
		if (existsSync(item.source)) throw new Error(`restore destination exists: ${item.source}`);
	}
	for (const item of manifest.moved ?? []) {
		await mkdir(dirname(item.source), { recursive: true });
		await rename(item.destination, item.source);
	}
	if (manifest.fzf) {
		const originalFzf = Buffer.from(manifest.fzf.bytesBase64, "base64");
		if (manifest.fzf.existed) await writeExact(manifest.fzf.path, originalFzf, manifest.fzf.mode);
		else if (existsSync(manifest.fzf.path)) await unlink(manifest.fzf.path);
	}
	const original = Buffer.from(manifest.settings.bytesBase64, "base64");
	if (manifest.settings.existed) await writeExact(manifest.settingsPath, original);
	else if (existsSync(manifest.settingsPath)) await unlink(manifest.settingsPath);
	manifest.status = "rolled-back";
	await writeExact(options.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
	return manifest;
}

export async function runMigration(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.mode === "rollback") return rollback(options);
	if (options.mode === "apply") return apply(options);
	return preflight(options);
}

if (["migrate.mjs", "pi-agent-wave-migrate"].includes(basename(process.argv[1] ?? ""))) {
	try {
		console.log(JSON.stringify(await runMigration(), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
