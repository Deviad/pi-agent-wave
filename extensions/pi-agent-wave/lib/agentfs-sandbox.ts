import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "../sqlite.ts";

export interface AgentFsSandboxSpec {
	readonly sessionId: string;
	readonly baseDir: string;
	readonly homeDir: string;
	readonly privateDir: string;
	readonly command: string;
	readonly args: readonly string[];
}

export interface AgentFsInvocation {
	readonly executable: "agentfs";
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export type AgentFsChangeKind = "file" | "directory" | "delete";
export interface AgentFsChange {
	readonly path: string;
	readonly kind: AgentFsChangeKind;
	readonly mode?: number;
}

/**
 * A path whose state could not be established. A failed `agentfs fs cat` or an owned path that
 * escapes the sandbox base is neither a genuine difference nor a clean result, so it is reported
 * separately from violations and fails the export with its own message.
 */
export type AgentFsAuditErrorKind = "audit_error" | "owned_path_escape";
export interface AgentFsAuditError {
	readonly path: string;
	readonly kind: AgentFsAuditErrorKind;
	readonly detail: string;
}

export interface AgentFsChangeInventory {
	readonly changes: readonly AgentFsChange[];
	readonly errors: readonly AgentFsAuditError[];
}

export interface AgentFsAudit {
	readonly changes: readonly AgentFsChange[];
	readonly owned: readonly AgentFsChange[];
	readonly ignored: readonly AgentFsChange[];
	readonly violations: readonly AgentFsChange[];
	readonly errors: readonly AgentFsAuditError[];
}

export interface AgentFsAuditOptions {
	readonly ignoredPaths?: readonly string[];
	readonly agentFsExecutable?: string;
	/** Whole-base ownership (an owned entry equal to baseDir) is refused unless explicitly enabled. */
	readonly ownWholeBase?: boolean;
}

interface PathRow {
	path: string;
	mode: number;
	base_ino: number | null;
}

interface WhiteoutRow {
	path: string;
}

function requiredAbsolute(path: string, name: string): string {
	if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
	return resolve(path);
}

/** Builds the exact AgentFS 0.6.4 copy-on-write sandbox argv for one attempt. */
export function buildAgentFsInvocation(spec: AgentFsSandboxSpec, env: NodeJS.ProcessEnv = process.env): AgentFsInvocation {
	const baseDir = requiredAbsolute(spec.baseDir, "baseDir");
	const homeDir = requiredAbsolute(spec.homeDir, "homeDir");
	const privateDir = requiredAbsolute(spec.privateDir, "privateDir");
	const command = requiredAbsolute(spec.command, "command");
	if (!spec.sessionId.trim()) throw new Error("AgentFS sessionId is required");
	return Object.freeze({
		executable: "agentfs",
		args: Object.freeze(["run", "--session", spec.sessionId, "--no-default-allows", "--allow", privateDir, command, ...spec.args]),
		cwd: baseDir,
		env: { ...env, HOME: homeDir },
	});
}

/** Strict by default; private callers may explicitly discard paths without granting ownership. */
/** Mirrored by DEFAULT_IGNORED_PATHS in scripts/delegate_core.py; the Git index refresh from a worker's own `git status`/`git diff` is discarded, never refused or exported (2026-09-12 build measurement). */
export const DEFAULT_IGNORED_PATHS: readonly string[] = Object.freeze([".git/index"]);

function normalizeChangedPath(path: string): string {
	return path.replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

function platformMetadata(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("._") || part === ".DS_Store");
}

/** Reads AgentFS schema 0.4 directly for a machine-readable changed-path inventory. */
export function agentFsChanges(dbPath: string, baseDir?: string, agentFsExecutable = "agentfs"): AgentFsChange[] {
	const inventory = agentFsChangeInventory(dbPath, baseDir, agentFsExecutable);
	if (inventory.errors.length) throw new Error(agentFsAuditErrorMessage(inventory.errors));
	return inventory.changes.filter((change) => !platformMetadata(change.path));
}

/**
 * Like agentFsChanges, but a failed `agentfs fs cat` during host comparison is reported as an
 * audit error instead of being silently promoted to a modified file, and platform metadata
 * (`._*`, `.DS_Store`) is kept so the caller can decide by ownership whether to export it.
 */
export function agentFsChangeInventory(dbPath: string, baseDir?: string, agentFsExecutable = "agentfs"): AgentFsChangeInventory {
	const db = new Database(dbPath, { readonly: true });
	let paths: PathRow[];
	let whiteouts: WhiteoutRow[];
	try {
		paths = db.query<PathRow, []>(`
			WITH RECURSIVE paths(ino,path,mode) AS (
				SELECT i.ino, '', i.mode FROM fs_inode i WHERE i.ino=1
				UNION ALL
				SELECT d.ino, paths.path || '/' || d.name, i.mode
				FROM fs_dentry d JOIN paths ON d.parent_ino=paths.ino JOIN fs_inode i ON i.ino=d.ino
			)
			SELECT paths.path,paths.mode,fs_origin.base_ino
			FROM paths LEFT JOIN fs_origin ON fs_origin.delta_ino=paths.ino
			WHERE paths.path<>'' ORDER BY paths.path
		`).all();
		whiteouts = db.query<WhiteoutRow, []>("SELECT path FROM fs_whiteout ORDER BY path").all();
	} finally {
		db.close();
	}
	const changes: AgentFsChange[] = [];
	const errors: AgentFsAuditError[] = [];
	for (const row of paths) {
		const path = normalizeChangedPath(row.path);
		if (!path) continue;
		const kind: AgentFsChangeKind = (row.mode & 0o170000) === 0o040000 ? "directory" : "file";
		if (baseDir && row.base_ino !== null) {
			try {
				const hostPath = resolve(baseDir, path);
				const metadata = statSync(hostPath, { throwIfNoEntry: false });
				if (kind === "directory" && metadata?.isDirectory()) continue;
				if (kind === "file" && metadata?.isFile()) {
					const exported = spawnSync(agentFsExecutable, ["fs", dbPath, "cat", `/${path}`], { encoding: null, shell: false, maxBuffer: Infinity });
					if (exported.error || exported.status !== 0) {
						throw exported.error ?? new Error(`${agentFsExecutable} fs cat exited ${exported.status ?? "by signal"}${exported.stderr?.length ? `: ${exported.stderr.toString("utf8").trim().slice(0, 500)}` : ""}`);
					}
					if (Buffer.compare(exported.stdout, readFileSync(hostPath)) === 0 && (row.mode & 0o777) === (metadata.mode & 0o777)) continue;
				}
			} catch (error) {
				errors.push(Object.freeze({ path, kind: "audit_error", detail: error instanceof Error ? error.message : String(error) }));
				continue;
			}
		}
		changes.push(Object.freeze({ path, kind, mode: row.mode & 0o777 }));
	}
	for (const row of whiteouts) {
		const path = normalizeChangedPath(row.path);
		if (path) changes.push(Object.freeze({ path, kind: "delete" }));
	}
	return Object.freeze({ changes: Object.freeze(changes), errors: Object.freeze(errors) });
}

/** Resolve symlinks before parent traversal, including links whose targets do not exist yet. */
export function realpathExistingPrefix(path: string): string {
	const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
	let root = parse(absolute).root;
	let current = root;
	const pending = absolute.slice(root.length).split(sep);
	let links = 0;
	while (pending.length) {
		const component = pending.shift();
		if (!component || component === ".") continue;
		if (component === "..") {
			current = dirname(current);
			continue;
		}
		const candidate = resolve(current, component);
		const metadata = lstatSync(candidate, { throwIfNoEntry: false });
		if (metadata?.isSymbolicLink()) {
			if (++links > 40) throw new Error(`too many symlinks in path: ${path}`);
			const target = readlinkSync(candidate);
			if (isAbsolute(target)) {
				root = parse(target).root;
				current = root;
				pending.unshift(...target.slice(root.length).split(sep));
			} else pending.unshift(...target.split(sep));
		} else current = candidate;
	}
	return current;
}

interface RelativeOwnership {
	readonly relative: string[];
	readonly errors: AgentFsAuditError[];
}

/**
 * Normalizes declared paths to base-relative POSIX form. Both sides are realpath'd on their
 * existing prefix so a symlinked workspace or owned entry resolves the way delegate_core does. An
 * entry that escapes the base is recorded per path instead of aborting the whole audit, and the
 * whole-base entry is refused unless the caller opted into it.
 */
function ownedRelativePaths(realBase: string, ownedPaths: readonly string[], label: string, ownWholeBase: boolean): RelativeOwnership {
	const relativePaths: string[] = [];
	const errors: AgentFsAuditError[] = [];
	for (const ownedPath of ownedPaths) {
		let absolute: string;
		try { absolute = realpathExistingPrefix(ownedPath); }
		catch (error) {
			errors.push(Object.freeze({ path: ownedPath, kind: "owned_path_escape", detail: `cannot resolve ${label} path: ${error instanceof Error ? error.message : String(error)}` }));
			continue;
		}
		const rel = relative(realBase, absolute);
		if (!rel || rel === ".") {
			if (ownWholeBase) relativePaths.push("");
			else errors.push(Object.freeze({ path: ownedPath, kind: "owned_path_escape", detail: `${label} path covers the whole base directory; set ownWholeBase to allow it` }));
			continue;
		}
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			errors.push(Object.freeze({ path: ownedPath, kind: "owned_path_escape", detail: `${label} path escapes base directory ${realBase}` }));
			continue;
		}
		relativePaths.push(rel.split(sep).join("/"));
	}
	return { relative: relativePaths, errors };
}

function isPathList(value: readonly string[] | AgentFsAuditOptions | undefined): value is readonly string[] {
	return Array.isArray(value);
}

function auditOptions(value: readonly string[] | AgentFsAuditOptions | undefined): Required<AgentFsAuditOptions> {
	const options: AgentFsAuditOptions = isPathList(value) ? { ignoredPaths: value } : value ?? {};
	return { ignoredPaths: options.ignoredPaths ?? [], agentFsExecutable: options.agentFsExecutable ?? "agentfs", ownWholeBase: options.ownWholeBase === true };
}

/** Rejects every non-metadata overlay change outside declared graph ownership. */
export function auditAgentFsChanges(dbPath: string, baseDir: string, ownedPaths: readonly string[], options: readonly string[] | AgentFsAuditOptions = {}): AgentFsAudit {
	const { ignoredPaths, agentFsExecutable, ownWholeBase } = auditOptions(options);
	const root = realpathExistingPrefix(baseDir);
	const allowedOwnership = ownedRelativePaths(root, ownedPaths, "owned", ownWholeBase);
	const ignoredOwnership = ownedRelativePaths(root, ignoredPaths, "ignored", false);
	const allowed = allowedOwnership.relative;
	const ignoredAllowed = ignoredOwnership.relative;
	const inventory = agentFsChangeInventory(dbPath, root, agentFsExecutable);
	const owned: AgentFsChange[] = [];
	const ignored: AgentFsChange[] = [];
	const violations: AgentFsChange[] = [];
	const under = (change: AgentFsChange, paths: readonly string[]): boolean => paths.some((path) => path === "" || change.path === path || change.path.startsWith(`${path}/`));
	for (const change of inventory.changes) {
		if (under(change, allowed)) owned.push(change);
		else if (under(change, ignoredAllowed)) ignored.push(change);
		// Finder/Spotlight metadata is discarded rather than exported or refused, but only outside ownership.
		else if (platformMetadata(change.path)) ignored.push(change);
		else violations.push(change);
	}
	const errors = [...allowedOwnership.errors, ...ignoredOwnership.errors, ...inventory.errors];
	return Object.freeze({ changes: inventory.changes, owned: Object.freeze(owned), ignored: Object.freeze(ignored), violations: Object.freeze(violations), errors: Object.freeze(errors) });
}

/** The distinct export failure for an audit that could not establish every path's state. */
export function agentFsAuditErrorMessage(errors: readonly AgentFsAuditError[]): string {
	return `AgentFS audit error (${errors.length} total): ${errors.map((error) => `${error.path} [${error.kind}] ${error.detail}`).join("; ")}`;
}

/** Applies only audited owned changes from the AgentFS delta to the host workspace. */
export function exportOwnedAgentFsChanges(agentFsExecutable: string, dbPath: string, baseDir: string, audit: AgentFsAudit): void {
	if (audit.errors?.length) throw new Error(agentFsAuditErrorMessage(audit.errors));
	if (audit.violations.length) throw new Error(`AgentFS contains unowned changes: ${audit.violations.map((change) => change.path).join(", ")}`);
	const directories = audit.owned.filter((change) => change.kind === "directory").sort((left, right) => left.path.length - right.path.length);
	const files = audit.owned.filter((change) => change.kind === "file");
	const deletes = audit.owned.filter((change) => change.kind === "delete").sort((left, right) => right.path.length - left.path.length);
	for (const change of directories) mkdirSync(resolve(baseDir, change.path), { recursive: true, mode: change.mode });
	for (const change of files) {
		const target = resolve(baseDir, change.path);
		mkdirSync(dirname(target), { recursive: true });
		const result = spawnSync(agentFsExecutable, ["fs", dbPath, "cat", `/${change.path}`], { encoding: null, shell: false, maxBuffer: Infinity });
		if (result.error || result.status !== 0) throw new Error(`failed to export AgentFS path ${change.path}`);
		writeFileSync(target, result.stdout, { mode: change.mode });
		if (change.mode !== undefined) chmodSync(target, change.mode);
	}
	for (const change of deletes) rmSync(resolve(baseDir, change.path), { recursive: true, force: true });
}

export function expectedAgentFsDb(homeDir: string, sessionId: string): string {
	return resolve(homeDir, ".agentfs", "run", sessionId, "delta.db");
}

export function assertAgentFsCleaned(homeDir: string): void {
	if (existsSync(homeDir)) {
		const metadata = statSync(homeDir);
		if (!metadata.isDirectory()) throw new Error(`AgentFS HOME is not a directory: ${homeDir}`);
		throw new Error(`AgentFS HOME still exists: ${homeDir}`);
	}
}
