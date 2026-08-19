import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export function hashBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function hashFile(path) {
	if (!existsSync(path)) return undefined;
	return hashBytes(readFileSync(path));
}

/** Atomic write: bytes land in a sibling temp file, then rename into place. */
export async function writeExact(path, bytes, mode = 0o600) {
	await mkdir(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, bytes, { mode });
		await chmod(temp, mode);
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

export function backupRoot(agentDir, id) {
	return join(agentDir, "migration-backups", "pi-agent-wave-init", id);
}

export function isValidBackupId(id) {
	return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== "." && id !== "..";
}

export function defaultBackupId(now = new Date()) {
	return now.toISOString().replace(/[.:]/g, "-");
}

const ALLOWED_BACKUP_PATHS = new Set(["model-routing.jsonc", "fzf.json"]);

function assertSafeRelativePath(relativePath) {
	if (typeof relativePath !== "string" || relativePath.length === 0) {
		throw new Error("backup manifest entry has an empty relative path");
	}
	if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
		throw new Error("backup manifest entry path must be relative");
	}
	if (relativePath.split(/[\\/]/).includes("..")) {
		throw new Error("backup manifest entry path escapes the agent directory");
	}
	if (!ALLOWED_BACKUP_PATHS.has(relativePath)) {
		throw new Error(`unexpected backup manifest entry '${relativePath}'`);
	}
	return relativePath;
}

/**
 * Record private, content-addressable backup evidence under
 * migration-backups/pi-agent-wave-init/<id>/ before any mutation. The manifest
 * carries base64 bytes plus sha256 so a later restore can be byte-exact and
 * reject tampering.
 */
export async function createBackup({ agentDir, id, entries }) {
	if (!isValidBackupId(id)) throw new Error(`invalid backup id '${id}'`);
	const root = backupRoot(agentDir, id);
	const manifestPath = join(root, "manifest.json");
	const normalized = [];
	for (const entry of entries) {
		const relativePath = assertSafeRelativePath(entry.relativePath);
		const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(String(entry.bytes ?? ""));
		normalized.push({
			relativePath,
			path: entry.path,
			existed: entry.existed !== false,
			bytes,
			mode: typeof entry.mode === "number" ? entry.mode : 0o600,
			bytesBase64: bytes.toString("base64"),
			sha256: hashBytes(bytes),
		});
	}
	const manifest = {
		schemaVersion: 1,
		status: "pending",
		id,
		agentDir,
		createdAt: new Date().toISOString(),
		backupRoot: root,
		entries: normalized.map(({ relativePath, path, existed, mode, bytesBase64, sha256 }) => ({
			relativePath,
			path,
			existed,
			mode,
			bytesBase64,
			sha256,
		})),
	};
	await mkdir(root, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	for (const entry of normalized) {
		const destination = join(root, "files", entry.relativePath);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, entry.bytes, { mode: 0o600 });
	}
	return { manifest, manifestPath, root };
}

export async function finalizeBackup(manifestPath, status = "applied") {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.status = status;
	await writeExact(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
	return manifest;
}

/**
 * Restore a backup manifest byte-exactly. Rejects manifests whose declared
 * paths do not match their location, whose entries escape the agent directory,
 * or whose bytes fail the recorded sha256 — the same tamper guards as migrate.
 */
export async function restoreBackup(manifestPath) {
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (manifest.status !== "applied" && manifest.status !== "pending") {
		throw new Error(`backup manifest status must be applied or pending, got '${manifest.status}'`);
	}
	if (manifest.schemaVersion !== 1) throw new Error(`unsupported backup manifest schema ${manifest.schemaVersion}`);
	if (typeof manifest.agentDir !== "string" || !manifest.agentDir) throw new Error("backup manifest has no agent directory");
	if (!isValidBackupId(manifest.id)) throw new Error(`backup manifest has an invalid id '${manifest.id}'`);
	const expectedRoot = backupRoot(manifest.agentDir, manifest.id);
	if (dirname(resolve(manifestPath)) !== resolve(expectedRoot)) {
		throw new Error("backup manifest path does not match its declared agent directory and id");
	}
	if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("backup manifest has no entries");
	const restored = [];
	for (const entry of manifest.entries) {
		const relativePath = assertSafeRelativePath(entry.relativePath);
		const destination = join(manifest.agentDir, relativePath);
		if (entry.path && resolve(entry.path) !== resolve(destination)) {
			throw new Error(`backup manifest entry path '${entry.path}' does not match destination '${destination}'`);
		}
		const source = join(expectedRoot, "files", relativePath);
		const bytes = await readFile(source);
		if (entry.sha256 !== hashBytes(bytes)) throw new Error(`backup file '${relativePath}' failed integrity check`);
		const declaredBase64 = entry.bytesBase64;
		if (typeof declaredBase64 === "string" && declaredBase64.length > 0 && Buffer.from(declaredBase64, "base64").toString("base64") !== bytes.toString("base64")) {
			throw new Error(`backup manifest '${relativePath}' bytes mismatch`);
		}
		if (entry.existed) await writeExact(destination, bytes, typeof entry.mode === "number" ? entry.mode : 0o600);
		else if (existsSync(destination)) await unlink(destination);
		restored.push({ relativePath, destination });
	}
	manifest.status = "rolled-back";
	await writeExact(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
	return { manifest, restored };
}
