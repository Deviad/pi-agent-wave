import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "../sqlite.ts";
import { RuntimeContentStore } from "./runtime-content.ts";
import { canonical, parseRuntimeContent, runtimeDigest, type RuntimeContent } from "./runtime-results.ts";

interface FileImage { readonly content: RuntimeContent; readonly mode: number }
interface Entry { readonly path: string; readonly before: FileImage | null; readonly after: FileImage | null }
interface Manifest {
	readonly version: 1;
	readonly workspace: string;
	readonly baseRevision: string;
	readonly candidateId: string;
	readonly ownedPaths: readonly string[];
	readonly entries: readonly Entry[];
	/** False for operational candidates placed into a working directory that need not be a Git root. */
	readonly gitChecks: boolean;
}
type State = "prepared" | "applying" | "applied" | "rolled_back" | "needs_reconciliation";
type Direction = "apply" | "rollback";
interface JournalRow { id: string; manifest_json: string; state: State; direction: Direction | null; error: string | null }
export interface IntegrationStatus { readonly id: string; readonly state: State; readonly direction: Direction | null; readonly error: string | null }
export interface IntegrationInput {
	readonly workspace: string;
	readonly baseRevision: string;
	readonly candidateId: string;
	readonly ownedPaths: readonly string[];
	readonly changes: readonly { readonly path: string; readonly after: RuntimeContent | null; readonly mode: number }[];
	/** Default true. Coding candidates require the Git root, HEAD and clean tracked preimages; operational placement skips only those checks. */
	readonly gitChecks?: boolean;
}

function relativePath(path: string): string {
	if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`invalid integration path: ${JSON.stringify(path)}`);
	return path;
}
function mode(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) throw new Error("unsupported file mode");
	return value;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("invalid integration text"); return value; }
function fileImage(value: unknown): FileImage | null {
	if (value === null) return null;
	if (!object(value)) throw new Error("invalid integration image");
	return { content: parseRuntimeContent(value.content), mode: mode(value.mode) };
}
function parseManifest(raw: string): Manifest {
	const value: unknown = JSON.parse(raw);
	if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.ownedPaths)) throw new Error("invalid integration manifest");
	if (value.gitChecks !== undefined && typeof value.gitChecks !== "boolean") throw new Error("invalid integration manifest");
	return {
		version: 1, workspace: text(value.workspace), baseRevision: text(value.baseRevision), candidateId: text(value.candidateId),
		gitChecks: value.gitChecks !== false,
		ownedPaths: value.ownedPaths.map((path) => relativePath(text(path))),
		entries: value.entries.map((entry: unknown) => {
			if (!object(entry)) throw new Error("invalid integration entry");
			return { path: relativePath(text(entry.path)), before: fileImage(entry.before), after: fileImage(entry.after) };
		}),
	};
}
function git(workspace: string, arg: string): string {
	return execFileSync("git", ["-C", workspace, "rev-parse", arg], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}
function absent(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function syncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readBounded(fd: number): Buffer {
	const limit = 16 * 1024 * 1024;
	if (fstatSync(fd).size > limit) throw new Error("integration file exceeds 16 MiB limit");
	const chunks: Buffer[] = [];
	let bytes = 0;
	for (;;) {
		const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes));
		const count = readSync(fd, chunk, 0, chunk.length, null);
		if (!count) return Buffer.concat(chunks, bytes);
		bytes += count;
		if (bytes > limit) throw new Error("integration file exceeds 16 MiB limit");
		chunks.push(chunk.subarray(0, count));
	}
}

/** Serialized private filesystem checkpoints. This is not an ownership audit or semantic acceptance. */
export class RuntimeIntegration {
	private readonly db: Database;
	private readonly content: RuntimeContentStore;
	private readonly stagingRoot: string;

	constructor(dbPath: string) {
		this.content = new RuntimeContentStore(dbPath);
		this.stagingRoot = join(realpathSync(dirname(dbPath)), "runtime-integration-staging");
		this.db = new Database(dbPath);
		chmodSync(dbPath, 0o600);
		this.db.exec(`PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS runtime_integrations (
				id TEXT PRIMARY KEY, workspace TEXT NOT NULL, manifest_json TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('prepared','applying','applied','rolled_back','needs_reconciliation')),
				direction TEXT CHECK(direction IS NULL OR direction IN ('apply','rollback')), error TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS runtime_integration_owner ON runtime_integrations(workspace)
				WHERE state IN ('prepared','applying','needs_reconciliation');
			CREATE TRIGGER IF NOT EXISTS runtime_integration_manifest_immutable
				BEFORE UPDATE OF id,workspace,manifest_json ON runtime_integrations
				BEGIN SELECT RAISE(ABORT, 'integration manifest is immutable'); END;
		`);
	}

	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = work(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}

	private row(id: string): JournalRow {
		const row = this.db.query<JournalRow, [string]>("SELECT * FROM runtime_integrations WHERE id=?").get(id);
		if (!row) throw new Error("unknown integration");
		if (runtimeDigest(parseManifest(row.manifest_json)) !== id) throw new Error("integration manifest digest mismatch");
		return row;
	}

	get(id: string): IntegrationStatus {
		const row = this.row(id);
		return { id, state: row.state, direction: row.direction, error: row.error };
	}

	private target(workspace: string, path: string): string {
		relativePath(path);
		const parts = path.split("/");
		let parent = workspace;
		for (const part of parts.slice(0, -1)) {
			parent = join(parent, part);
			const stat = lstatSync(parent);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("integration parent must be an existing real directory");
			try { lstatSync(join(parent, ".git")); throw new Error("submodule or nested repository path is unsupported"); }
			catch (error) { if (!absent(error)) throw error; }
		}
		return join(workspace, ...parts);
	}

	private snapshot(workspace: string, path: string, retain: boolean): FileImage | null {
		const target = this.target(workspace, path);
		let stat;
		try { stat = lstatSync(target); } catch (error) { if (absent(error)) return null; throw error; }
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("integration requires a regular file without symlinks or hard links");
		if (stat.size > 16 * 1024 * 1024) throw new Error("integration file exceeds 16 MiB limit");
		const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes: Buffer;
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("integration preimage changed while reading");
			bytes = readBounded(fd);
		} finally { closeSync(fd); }
		const content = retain ? this.content.retain(bytes) : { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
		return { content, mode: stat.mode & 0o777 };
	}

	prepare(input: IntegrationInput, validate: () => void = () => {}): IntegrationStatus {
		const workspace = realpathSync(resolve(input.workspace));
		const ownedPaths = input.ownedPaths.map(relativePath);
		const gitChecks = input.gitChecks !== false;
		if (!input.changes.length) throw new Error("integration requires file changes");
		return this.transaction(() => {
			validate();
			const previous = this.db.query<JournalRow, [string, string]>("SELECT * FROM runtime_integrations WHERE workspace=? AND json_extract(manifest_json,'$.candidateId')=?").get(workspace, input.candidateId);
			if (previous) {
				const manifest = parseManifest(previous.manifest_json);
				const changes = manifest.entries.map((entry) => ({ path: entry.path, after: entry.after?.content ?? null, mode: entry.after?.mode ?? 0o644 }));
				const requested = input.changes.map((change) => ({ ...change, mode: change.after === null ? 0o644 : change.mode }));
				if (manifest.baseRevision !== input.baseRevision || manifest.gitChecks !== gitChecks || canonical(manifest.ownedPaths) !== canonical(ownedPaths) || canonical(changes) !== canonical(requested)) throw new Error("conflicting candidate integration");
				for (const entry of manifest.entries) { if (entry.before) this.content.verify(entry.before.content); if (entry.after) this.content.verify(entry.after.content); }
				return this.get(previous.id);
			}
			this.stagingDirectory(workspace);
			if (gitChecks) {
				if (realpathSync(git(workspace, "--show-toplevel")) !== workspace) throw new Error("integration workspace must be the Git root");
				if (git(workspace, "HEAD") !== input.baseRevision) throw new Error("candidate base revision changed");
			} else if (!lstatSync(workspace).isDirectory()) throw new Error("integration workspace must be a directory");
			const active = this.db.query("SELECT id FROM runtime_integrations WHERE workspace=? AND state IN ('prepared','applying','needs_reconciliation')").get(workspace);
			if (active) throw new Error("workspace has an active integration");
			const seen: string[] = [];
			const entries = input.changes.map((change): Entry => {
				const path = relativePath(change.path);
				if (!ownedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`))) throw new Error("unowned integration path");
				if (seen.some((other) => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) throw new Error("overlapping integration entries");
				seen.push(path);
				const before = this.snapshot(workspace, path, true);
				if (gitChecks) {
					const status = execFileSync("git", ["--literal-pathspecs", "-C", workspace, "status", "--porcelain", "--untracked-files=all", "--", path], { encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
					if (status.trim()) throw new Error("candidate preimage is dirty or untracked");
					if (before) {
						try { execFileSync("git", ["--literal-pathspecs", "-C", workspace, "ls-files", "--error-unmatch", "--", path], { stdio: "pipe", timeout: 10_000 }); }
						catch { throw new Error("candidate preimage is untracked or ignored"); }
					}
				}
				const after = change.after === null ? null : { content: parseRuntimeContent(change.after), mode: mode(change.mode) };
				if (after) { if (after.content.bytes > 16 * 1024 * 1024) throw new Error("integration file exceeds 16 MiB limit"); this.content.verify(after.content); }
				return { path, before, after };
			});
			const manifest: Manifest = { version: 1, workspace, baseRevision: input.baseRevision, candidateId: text(input.candidateId), ownedPaths, entries, gitChecks };
			const id = runtimeDigest(manifest);
			this.db.query("INSERT INTO runtime_integrations(id,workspace,manifest_json,state) VALUES (?,?,?,'prepared')").run(id, workspace, canonical(manifest));
			return this.get(id);
		});
	}

	private stagingDirectory(workspace: string): void {
		mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 });
		const stat = lstatSync(this.stagingRoot);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("integration staging requires a private real directory");
		if (stat.dev !== lstatSync(workspace).dev) throw new Error("integration staging and workspace must be on the same filesystem");
		syncDirectory(dirname(this.stagingRoot));
	}

	private temporary(manifest: Manifest, entry: Entry): string {
		this.stagingDirectory(manifest.workspace);
		return join(this.stagingRoot, runtimeDigest({ manifest, path: entry.path }));
	}

	private clearTemporary(path: string): void {
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe integration staging file");
			unlinkSync(path);
			syncDirectory(this.stagingRoot);
		} catch (error) { if (!absent(error)) throw error; }
	}

	private replace(manifest: Manifest, entry: Entry, image: FileImage | null): void {
		const target = this.target(manifest.workspace, entry.path);
		if (image === null) { unlinkSync(target); syncDirectory(dirname(target)); return; }
		this.content.verify(image.content);
		const contentFd = openSync(this.content.path(image.content), constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes: Buffer;
		try { bytes = readBounded(contentFd); } finally { closeSync(contentFd); }
		if (bytes.length !== image.content.bytes || createHash("sha256").update(bytes).digest("hex") !== image.content.sha256) throw new Error("integration content digest mismatch");
		const temporary = this.temporary(manifest, entry);
		this.clearTemporary(temporary);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			try { writeFileSync(fd, bytes); fchmodSync(fd, image.mode); fsyncSync(fd); }
			finally { closeSync(fd); }
			syncDirectory(this.stagingRoot);
			renameSync(temporary, target); syncDirectory(dirname(target)); syncDirectory(this.stagingRoot);
		}
		finally { try { unlinkSync(temporary); } catch (error) { if (!absent(error)) throw error; } }
	}

	/** One filesystem step per transaction; content states remain authoritative after a lost acknowledgement. */
	advance(id: string, direction: Direction): IntegrationStatus {
		// Commit the recovery direction before any filesystem mutation; a rollback intent must
		// survive a crash even when the next file's acknowledgement never reaches SQLite.
		this.transaction(() => {
			const row = this.row(id);
			if (row.state === "applied" || row.state === "rolled_back") return;
			if (row.direction === "rollback" && direction === "apply") throw new Error("integration is rolling back");
			this.db.query("UPDATE runtime_integrations SET direction=? WHERE id=?").run(direction, id);
		});
		const result = this.transaction((): { status: IntegrationStatus; failure?: Error } => {
			const row = this.row(id);
			if (row.state === "applied" || row.state === "rolled_back") {
				if ((row.state === "applied") !== (direction === "apply")) throw new Error(`integration is ${row.state}`);
				return { status: this.get(id) };
			}
			if (row.direction === "rollback" && direction === "apply") throw new Error("integration is rolling back");
			const manifest = parseManifest(row.manifest_json);
			try {
				if (realpathSync(manifest.workspace) !== manifest.workspace || (manifest.gitChecks && git(manifest.workspace, "HEAD") !== manifest.baseRevision)) throw new Error("integration base revision changed");
				const observed = manifest.entries.map((entry) => {
					this.clearTemporary(this.temporary(manifest, entry));
					for (const image of [entry.before, entry.after]) if (image) this.content.verify(image.content);
					const image = this.snapshot(manifest.workspace, entry.path, false);
					if (canonical(image) !== canonical(entry.before) && canonical(image) !== canonical(entry.after)) throw new Error(`integration conflict at ${entry.path}`);
					return image;
				});
				const index = manifest.entries.findIndex((entry, index) => canonical(observed[index]) !== canonical(direction === "apply" ? entry.after : entry.before));
				if (index === -1) {
					this.db.query("UPDATE runtime_integrations SET state=?,direction=?,error=NULL WHERE id=?").run(direction === "apply" ? "applied" : "rolled_back", direction, id);
				} else {
					const entry = manifest.entries[index];
					this.replace(manifest, entry, direction === "apply" ? entry.after : entry.before);
					this.db.query("UPDATE runtime_integrations SET state='applying',direction=?,error=NULL WHERE id=?").run(direction, id);
				}
				return { status: this.get(id) };
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				this.db.query("UPDATE runtime_integrations SET state='needs_reconciliation',direction=?,error=? WHERE id=?").run(direction, failure.message, id);
				return { status: this.get(id), failure };
			}
		});
		if (result.failure) throw result.failure;
		return result.status;
	}

	apply(id: string): IntegrationStatus { return this.finish(id, "apply"); }
	rollback(id: string): IntegrationStatus { return this.finish(id, "rollback"); }
	private finish(id: string, direction: Direction): IntegrationStatus {
		let result = this.advance(id, direction);
		while (result.state === "applying") result = this.advance(id, direction);
		return result;
	}
	close(): void { this.db.close(); }
}
