import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

export interface AgentFsAudit {
	readonly changes: readonly AgentFsChange[];
	readonly owned: readonly AgentFsChange[];
	readonly ignored: readonly AgentFsChange[];
	readonly violations: readonly AgentFsChange[];
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

function normalizeChangedPath(path: string): string {
	return path.replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

function platformMetadata(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("._") || part === ".DS_Store");
}

/** Reads AgentFS schema 0.4 directly for a machine-readable changed-path inventory. */
export function agentFsChanges(dbPath: string, baseDir?: string, agentFsExecutable = "agentfs"): AgentFsChange[] {
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
	for (const row of paths) {
		const path = normalizeChangedPath(row.path);
		if (!path || platformMetadata(path)) continue;
		const kind: AgentFsChangeKind = (row.mode & 0o170000) === 0o040000 ? "directory" : "file";
		if (baseDir && row.base_ino !== null) {
			const hostPath = resolve(baseDir, path);
			if (kind === "directory" && existsSync(hostPath) && statSync(hostPath).isDirectory()) continue;
			if (kind === "file" && existsSync(hostPath) && statSync(hostPath).isFile()) {
				const exported = spawnSync(agentFsExecutable, ["fs", dbPath, "cat", `/${path}`], { encoding: null, shell: false });
				if (!exported.error && exported.status === 0 && Buffer.compare(exported.stdout, readFileSync(hostPath)) === 0 && (row.mode & 0o777) === (statSync(hostPath).mode & 0o777)) continue;
			}
		}
		changes.push(Object.freeze({ path, kind, mode: row.mode & 0o777 }));
	}
	for (const row of whiteouts) {
		const path = normalizeChangedPath(row.path);
		if (path && !platformMetadata(path)) changes.push(Object.freeze({ path, kind: "delete" }));
	}
	return changes;
}

function ownedRelativePaths(baseDir: string, ownedPaths: readonly string[]): string[] {
	return ownedPaths.map((ownedPath) => {
		const absolute = resolve(ownedPath);
		const rel = relative(baseDir, absolute);
		if (!rel || rel === ".") return "";
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`owned path escapes base directory: ${ownedPath}`);
		return rel.split(sep).join("/");
	});
}

/** Rejects every non-metadata overlay change outside declared graph ownership. */
export function auditAgentFsChanges(dbPath: string, baseDir: string, ownedPaths: readonly string[], ignoredPaths: readonly string[] = []): AgentFsAudit {
	const root = resolve(baseDir);
	const allowed = ownedRelativePaths(root, ownedPaths);
	const ignoredAllowed = ownedRelativePaths(root, ignoredPaths);
	const changes = agentFsChanges(dbPath, root);
	const owned: AgentFsChange[] = [];
	const ignored: AgentFsChange[] = [];
	const violations: AgentFsChange[] = [];
	for (const change of changes) {
		const under = (paths: readonly string[]): boolean => paths.some((path) => path === "" || change.path === path || change.path.startsWith(`${path}/`));
		if (under(allowed)) owned.push(change);
		else if (under(ignoredAllowed)) ignored.push(change);
		else violations.push(change);
	}
	return Object.freeze({ changes: Object.freeze(changes), owned: Object.freeze(owned), ignored: Object.freeze(ignored), violations: Object.freeze(violations) });
}

/** Applies only audited owned changes from the AgentFS delta to the host workspace. */
export function exportOwnedAgentFsChanges(agentFsExecutable: string, dbPath: string, baseDir: string, audit: AgentFsAudit): void {
	if (audit.violations.length) throw new Error(`AgentFS contains unowned changes: ${audit.violations.map((change) => change.path).join(", ")}`);
	const directories = audit.owned.filter((change) => change.kind === "directory").sort((left, right) => left.path.length - right.path.length);
	const files = audit.owned.filter((change) => change.kind === "file");
	const deletes = audit.owned.filter((change) => change.kind === "delete").sort((left, right) => right.path.length - left.path.length);
	for (const change of directories) mkdirSync(resolve(baseDir, change.path), { recursive: true, mode: change.mode });
	for (const change of files) {
		const target = resolve(baseDir, change.path);
		mkdirSync(dirname(target), { recursive: true });
		const result = spawnSync(agentFsExecutable, ["fs", dbPath, "cat", `/${change.path}`], { encoding: null, shell: false });
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
