import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DEFAULT_IGNORED_PATHS, auditAgentFsChanges, agentFsAuditErrorMessage } from "./agentfs-sandbox.ts";
import { RuntimeContentStore } from "./runtime-content.ts";
import { canonical, parseRuntimeContent, type RuntimeContent } from "./runtime-results.ts";

export interface RuntimeStagingManifest {
	readonly version: 1;
	readonly attemptKey: string;
	readonly workspace: string;
	readonly baseRevision: string;
	readonly snapshotDigest: string;
	readonly ownedPaths: readonly string[];
	readonly changes: readonly { readonly path: string; readonly after: RuntimeContent | null; readonly mode: number }[];
	readonly readOnly: boolean;
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("invalid staging manifest text"); return value; }

export function parseRuntimeStagingManifest(value: unknown): RuntimeStagingManifest {
	if (!object(value) || value.version !== 1 || typeof value.readOnly !== "boolean" || !Array.isArray(value.ownedPaths) || !Array.isArray(value.changes)) throw new Error("invalid staging manifest");
	if (typeof value.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)) throw new Error("invalid staging snapshot digest");
	const changes = value.changes.map((change: unknown) => {
		if (!object(change) || typeof change.mode !== "number" || !Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777) throw new Error("invalid staging file mode");
		return { path: text(change.path), after: change.after === null ? null : parseRuntimeContent(change.after), mode: change.mode };
	});
	if (value.readOnly && changes.length) throw new Error("read-only staging cannot contain changes");
	return { version: 1, attemptKey: text(value.attemptKey), workspace: text(value.workspace), baseRevision: text(value.baseRevision), snapshotDigest: value.snapshotDigest, ownedPaths: value.ownedPaths.map(text), changes, readOnly: value.readOnly };
}

export interface RuntimeStagingInput {
	readonly agentFsExecutable: string;
	readonly snapshotPath: string;
	readonly baseDir: string;
	readonly baseRevision: string;
	readonly attemptKey: string;
	readonly ownedPaths: readonly string[];
	readonly readOnly: boolean;
}

function snapshotDigest(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || existsSync(`${path}-wal`)) throw new Error("AgentFS staging requires a self-contained regular SQLite snapshot");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024);
		for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) return hash.digest("hex"); hash.update(buffer.subarray(0, size)); }
	} finally { closeSync(fd); }
}

/** Reads an audited, closed AgentFS snapshot into private content storage; never exports host files. */
export function stageRuntimeAgentFs(input: RuntimeStagingInput, content: RuntimeContentStore): { manifest: RuntimeContent; files: readonly RuntimeContent[]; changes: readonly { readonly path: string; readonly after: RuntimeContent | null; readonly mode: number }[] } {
	if (!input.attemptKey.trim() || !input.baseRevision.trim()) throw new Error("staging requires attempt and base identity");
	const workspace = realpathSync(input.baseDir);
	const before = snapshotDigest(input.snapshotPath);
	const scratch = mkdtempSync(join(tmpdir(), "pi-wave-staging-"));
	try {
		const workingSnapshot = join(scratch, "snapshot.db");
		copyFileSync(input.snapshotPath, workingSnapshot);
		// Owned paths may arrive through a symlinked prefix (macOS /var -> /private/var); the manifest records them relative to the real workspace.
		const ownedPaths = input.ownedPaths.map((path) => { const absolute = resolve(workspace, path); try { return realpathSync(absolute); } catch { return absolute; } });
		const audit = auditAgentFsChanges(workingSnapshot, workspace, ownedPaths, { ignoredPaths: DEFAULT_IGNORED_PATHS.map((path) => resolve(workspace, path)), agentFsExecutable: input.agentFsExecutable });
		const errors = input.readOnly ? audit.errors.filter((error) => error.kind !== "audit_error") : audit.errors;
		if (errors.length) throw new Error(agentFsAuditErrorMessage(errors));
		if (!input.readOnly && audit.violations.length) throw new Error(`AgentFS contains unowned changes: ${audit.violations.map((item) => item.path).join(", ")}`);
		const files: RuntimeContent[] = [];
		const changes = (input.readOnly ? [] : audit.owned).map((change) => {
			if (change.kind === "directory") throw new Error("directory staging requires directory integration support");
			let after: RuntimeContent | null = null;
			if (change.kind === "file") {
				const result = spawnSync(input.agentFsExecutable, ["fs", workingSnapshot, "cat", `/${change.path}`], { shell: false, encoding: null, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
				if (result.error || result.status !== 0) throw new Error(`AgentFS staging read failed for ${change.path}: ${result.error?.message ?? result.status}`);
				after = content.retain(result.stdout); files.push(after);
			}
			return { path: change.path, after, mode: change.mode ?? 0o644 };
		});
		if (snapshotDigest(input.snapshotPath) !== before) throw new Error("AgentFS snapshot changed during staging");
		const manifest = content.retain(Buffer.from(canonical({
			version: 1, attemptKey: input.attemptKey, workspace, baseRevision: input.baseRevision, snapshotDigest: before,
			ownedPaths: ownedPaths.map((path) => relative(workspace, path)), changes, readOnly: input.readOnly,
		})));
		return { manifest, files, changes };
	} finally { rmSync(scratch, { recursive: true, force: true }); }
}
