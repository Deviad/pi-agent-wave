import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "../sqlite.ts";
import { parseJsonc } from "./jsonc.mjs";
import { canonical } from "./runtime-results.ts";
import { realpathExistingPrefix } from "./agentfs-sandbox.ts";

export interface PreparationCommand { readonly executable: string; readonly args: readonly string[] }
export interface WorkspaceRecipe {
	readonly workspace: string;
	readonly install: readonly PreparationCommand[];
	readonly baseline: readonly PreparationCommand[];
	readonly readiness: PreparationCommand;
	readonly dependencyInputs: readonly string[];
	readonly scriptInputs: readonly string[];
	readonly writePaths: readonly string[];
	readonly timeoutMs: number;
}
export interface PreparationResult {
	readonly status: "ready" | "unconfigured";
	readonly workspace: string;
	readonly reused: boolean;
	readonly reason: string;
	readonly receiptPath?: string;
}
export interface PreparationGuard {
	readonly result: PreparationResult;
	/** Reserve the launcher window before init; an abandoned window must be reconciled, never assumed safe. */
	beginLaunch(): void;
	/** Preserve the reservation when a start call might have launched a worker, even before registration. */
	retainLaunch(): void;
	failedLaunch(): void;
	release(): void;
}
interface PreparationInput {
	readonly workspace: string;
	readonly agentDir: string;
	readonly dbPath: string;
	readonly runId: string;
	readonly operationId: string;
	readonly signal?: AbortSignal;
	readonly progress?: (phase: string, detail: Record<string, unknown>) => void;
}
interface LaunchReference { readonly dbPath: string; readonly operationId: string; readonly ownerPid: number }
interface Receipt { readonly identity: string; readonly installed: boolean; readonly ready: boolean; readonly installEvidence: readonly string[]; readonly baselineEvidence: readonly string[] }
const FILE_LIMIT = 10 * 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const REGISTRY = "workspace-preparation.jsonc";

export class WorkspacePreparationError extends Error {
	readonly phase: string;
	readonly diagnosticsPath: string | null;
	constructor(phase: string, reason: string, diagnosticsPath: string | null = null) {
		super(`workspace preparation ${phase}: ${reason}; remedy: inspect the retained diagnostics, correct the workspace/recipe and retry dispatch (renew approval if commands changed)`);
		this.phase = phase; this.diagnosticsPath = diagnosticsPath;
	}
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function covered(path: string, paths: readonly string[]): boolean { return paths.some((entry) => path === entry || path.startsWith(`${entry}/`)); }
function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`); }
function privateDirectory(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error(`preparation state requires a private operator-owned directory: ${path}`);
}
function fileBytes(path: string, privateFile = false): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > FILE_LIMIT) throw new Error(`preparation input must be a regular single-link file below 10 MiB: ${path}`);
		if (privateFile && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error(`preparation authority requires a private operator-owned file: ${path}`);
		const bytes = Buffer.alloc(stat.size + 1);
		let count = 0;
		while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
		const after = fstatSync(fd);
		if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error(`preparation input changed while reading: ${path}`);
		return bytes.subarray(0, count);
	} finally { closeSync(fd); }
}
function readState(path: string): unknown {
	try { return JSON.parse(fileBytes(path, true).toString("utf8")); }
	catch (error) { if (missing(error)) return null; throw error; }
}
function writeState(path: string, value: unknown): void {
	privateDirectory(dirname(path));
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
	try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function paths(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be a path array`);
	return value.map((path: unknown) => {
		if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`${field} contains an invalid relative path`);
		return path;
	});
}
function command(raw: unknown): PreparationCommand {
	if (!object(raw) || typeof raw.executable !== "string" || !isAbsolute(raw.executable) || raw.executable.includes("\0") || !Array.isArray(raw.args) || !raw.args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))) throw new Error("preparation command requires an absolute executable and string-array args");
	return { executable: raw.executable, args: raw.args };
}
function recipeFor(agentDir: string, workspace: string): WorkspaceRecipe | null {
	const registry = join(agentDir, REGISTRY);
	if (!existsSync(registry)) return null;
	if (inside(workspace, realpathSync(registry))) throw new Error("repository data cannot be a workspace preparation authority registry");
	const raw: unknown = parseJsonc(fileBytes(registry, true).toString("utf8"), registry);
	if (!object(raw) || !Array.isArray(raw.workspaces)) throw new Error("preparation registry requires a workspaces array");
	const matches = raw.workspaces.filter((entry: unknown) => object(entry) && typeof entry.workspace === "string" && isAbsolute(entry.workspace) && realpathExistingPrefix(entry.workspace) === workspace);
	if (matches.length > 1) throw new Error("preparation registry repeats canonical workspace");
	const entry: unknown = matches[0];
	if (entry === undefined) return null;
	if (!object(entry) || !Array.isArray(entry.install) || !Array.isArray(entry.baseline) || typeof entry.timeoutMs !== "number" || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 3_600_000) throw new Error("preparation recipe requires install/baseline arrays and timeoutMs from 1 to 3600000");
	const recipe = { workspace, install: entry.install.map(command), baseline: entry.baseline.map(command), readiness: command(entry.readiness), dependencyInputs: paths(entry.dependencyInputs, "dependencyInputs"), scriptInputs: paths(entry.scriptInputs, "scriptInputs"), writePaths: paths(entry.writePaths, "writePaths"), timeoutMs: entry.timeoutMs };
	for (const path of [...recipe.dependencyInputs, ...recipe.scriptInputs, ...recipe.writePaths]) {
		if (!inside(workspace, realpathExistingPrefix(join(workspace, path)))) throw new Error(`preparation path escapes workspace: ${path}`);
	}
	if (recipe.scriptInputs.some((path) => covered(path, recipe.writePaths))) throw new Error("approved scripts cannot be writable dependency state");
	if (recipe.dependencyInputs.some((path) => covered(path, recipe.writePaths))) throw new Error("dependency freshness inputs cannot be writable dependency state");
	for (const cmd of [...recipe.install, ...recipe.baseline, recipe.readiness]) {
		for (const arg of [cmd.executable, ...cmd.args]) {
			if (arg !== cmd.executable && !/\.(?:[cm]?js|ts|py|sh|rb|pl|ps1)$/i.test(arg)) continue;
			const script = realpathExistingPrefix(resolve(workspace, arg));
			if (inside(workspace, script) && !recipe.scriptInputs.includes(relative(workspace, script))) throw new Error(`repository command script ${arg} must be declared in scriptInputs (including transitive script/config inputs)`);
		}
	}
	return recipe;
}
function inputIdentity(workspace: string, inputPaths: readonly string[]): string {
	return digest(inputPaths.map((path) => {
		try { return [path, createHash("sha256").update(fileBytes(join(workspace, path))).digest("hex")]; }
		catch (error) { if (missing(error)) return [path, null]; throw error; }
	}));
}
function approvalIdentity(recipe: WorkspaceRecipe): string {
	let scripts: unknown = null;
	const packagePath = join(recipe.workspace, "package.json");
	if (existsSync(packagePath)) {
		const pkg: unknown = JSON.parse(fileBytes(packagePath).toString("utf8"));
		if (!object(pkg)) throw new Error("workspace package.json must be an object");
		scripts = pkg.scripts ?? null;
	}
	for (const path of recipe.scriptInputs) if (!existsSync(join(recipe.workspace, path))) throw new Error(`approved script input is missing: ${path}`);
	return digest({ recipe, scripts, scriptBytes: inputIdentity(recipe.workspace, recipe.scriptInputs) });
}
function approvalPath(agentDir: string, workspace: string): string { return join(agentDir, "workspace-preparation-approvals", `${digest(workspace)}.json`); }

/** The operator explicitly accepts host access and completeness of the declared executable script inputs. */
export function approveWorkspaceRecipe(agentDir: string, workspace: string, hostAccess: boolean): string {
	if (!hostAccess) throw new Error("approval requires --host-access: commands have arbitrary host access; declare every repository script and transitive script/config input");
	const root = realpathSync(workspace);
	const recipe = recipeFor(agentDir, root);
	if (!recipe) throw new Error(`automatic workspace preparation is not configured for ${root}`);
	const path = approvalPath(agentDir, root);
	if (inside(root, realpathExistingPrefix(path))) throw new Error("repository data cannot grant preparation approval");
	writeState(path, { version: 1, workspace: root, identity: approvalIdentity(recipe), hostAccess: true });
	return path;
}
export function revokeWorkspaceRecipe(agentDir: string, workspace: string): void {
	const path = approvalPath(agentDir, realpathSync(workspace));
	if (existsSync(path)) unlinkSync(path);
}
export function workspaceRecipeStatus(agentDir: string, workspace: string): { configured: boolean; approved: boolean; workspace: string } {
	const root = realpathSync(workspace), recipe = recipeFor(agentDir, root);
	const approval = recipe ? readState(approvalPath(agentDir, root)) : null;
	return { configured: recipe !== null, approved: !!recipe && object(approval) && approval.hostAccess === true && approval.workspace === root && approval.identity === approvalIdentity(recipe), workspace: root };
}
function assertApproval(agentDir: string, recipe: WorkspaceRecipe, identity: string): void {
	const path = approvalPath(agentDir, recipe.workspace);
	if (inside(recipe.workspace, realpathExistingPrefix(path))) throw new Error("repository data cannot grant preparation approval");
	const current = recipeFor(agentDir, recipe.workspace);
	const approval = readState(path);
	if (!current || approvalIdentity(current) !== identity || !object(approval) || approval.hostAccess !== true || approval.workspace !== recipe.workspace || approval.identity !== identity) throw new WorkspacePreparationError("approval", "missing, revoked or changed approval; approve the current recipe with the operator CLI and --host-access");
}
function git(workspace: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}
function sourceSnapshot(recipe: WorkspaceRecipe): Map<string, string> {
	const files = git(recipe.workspace, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...recipe.writePaths.map((path) => `:(exclude,literal)${path}`)]);
	const ignored = git(recipe.workspace, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ".", ...recipe.writePaths.map((path) => `:(exclude,literal)${path}`)]);
	const tracked = new Set(git(recipe.workspace, ["ls-files", "-z", "--cached"]).split("\0").filter(Boolean));
	for (const path of tracked) if (covered(path, recipe.writePaths)) throw new Error(`preparation writePaths covers tracked source: ${path}`);
	const result = new Map<string, string>();
	for (const path of new Set((files + ignored).split("\0").filter(Boolean))) {
		if (covered(path, recipe.writePaths)) continue;
		const target = join(recipe.workspace, path);
		const stat = lstatSync(target, { throwIfNoEntry: false });
		if (!stat) { result.set(path, "absent"); continue; }
		if (stat.isSymbolicLink()) result.set(path, digest({ link: readlinkSync(target) }));
		else if (stat.isFile()) result.set(path, digest({ mode: stat.mode & 0o777, content: createHash("sha256").update(fileBytes(target)).digest("hex") }));
		else throw new Error(`preparation cannot audit non-file source: ${path}`);
	}
	result.set(".git/HEAD revision", git(recipe.workspace, ["rev-parse", "--verify", "HEAD"]).trim());
	result.set(".git/index", git(recipe.workspace, ["ls-files", "--stage", "-z"]));
	return result;
}
function sourceChanges(before: Map<string, string>, after: Map<string, string>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}
function lockDirectory(stateDir: string): () => void {
	const lock = join(stateDir, "lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			writeState(join(lock, "owner.json"), { pid: process.pid });
			return () => rmSync(lock, { recursive: true });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			const reclaim = join(stateDir, "reclaim");
			try { mkdirSync(reclaim, { mode: 0o700 }); }
			catch { throw new WorkspacePreparationError("lock", "workspace busy or reclamation unconfirmed; retry, or reconcile the reclamation lock manually"); }
			try {
				const owner = readState(join(lock, "owner.json"));
				if (owner === null && !existsSync(lock)) continue;
				if (!object(owner) || typeof owner.pid !== "number" || alive(owner.pid)) throw new WorkspacePreparationError("lock", `workspace busy or lock ownership unconfirmed at ${lock}; retry when preparation/dispatch finishes, reconcile an unconfirmed lock manually`);
				const stale = `${lock}.stale-${randomUUID()}`;
				try { renameSync(lock, stale); rmSync(stale, { recursive: true }); } catch (cause) { if (!missing(cause)) throw cause; }
			} finally { rmSync(reclaim, { recursive: true }); }
		}
	}
	throw new WorkspacePreparationError("lock", "workspace busy; retry dispatch");
}
function references(path: string): LaunchReference[] {
	const raw = readState(path);
	if (raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("invalid preparation launch references");
	return raw.map((entry: unknown) => {
		if (!object(entry) || typeof entry.dbPath !== "string" || !isAbsolute(entry.dbPath) || typeof entry.operationId !== "string" || typeof entry.ownerPid !== "number") throw new Error("invalid preparation launch reference");
		return { dbPath: entry.dbPath, operationId: entry.operationId, ownerPid: entry.ownerPid };
	});
}
function workspaceWorkers(workspace: string, dbPath: string, launches: readonly LaunchReference[]): string[] {
	const live = new Set<string>();
	for (const path of new Set([dbPath, ...launches.map((entry) => entry.dbPath)])) {
		if (!existsSync(path)) {
			for (const entry of launches.filter((item) => item.dbPath === path)) live.add(`${entry.operationId} (graph database missing; reconcile launch)`);
			continue;
		}
		const db = new Database(path, { readonly: true });
		try {
			const rows = db.query<{ operation_id: string; outcome_json: string | null; workspace: string | null }>(`SELECT runtime_attempts.operation_id,runtime_attempts.outcome_json,COALESCE(runs.workspace_root,runs.dispatch_workspace_root) AS workspace FROM runtime_attempts JOIN runs ON runs.id=runtime_attempts.run_id`).all();
			for (const row of rows) if (row.outcome_json === null && (row.workspace && realpathExistingPrefix(row.workspace) === workspace || launches.some((entry) => entry.dbPath === path && entry.operationId === row.operation_id))) live.add(row.operation_id);
			for (const entry of launches.filter((item) => item.dbPath === path)) if (!rows.some((row) => row.operation_id === entry.operationId)) live.add(`${entry.operationId} (launch not registered; reconcile before refresh)`);
		} finally { db.close(); }
	}
	return [...live];
}

/** Shell-free, finite host commands, with bounded retained output and whole-process-group cancellation. */
async function runCommand(command: PreparationCommand, recipe: WorkspaceRecipe, phase: string, stateDir: string, signal?: AbortSignal): Promise<{ ok: boolean; reason: string; diagnosticsPath: string }> {
	const diagnosticsPath = join(stateDir, "diagnostics", `${randomUUID()}.json`);
	let tail = Buffer.alloc(0);
	const append = (bytes: Buffer) => { tail = Buffer.concat([tail, bytes.subarray(-OUTPUT_LIMIT)]).subarray(-OUTPUT_LIMIT); };
	const outcome = await new Promise<{ ok: boolean; reason: string }>((resolveResult) => {
		if (signal?.aborted) { resolveResult({ ok: false, reason: "cancelled before command" }); return; }
		const child = spawn(command.executable, command.args, { cwd: recipe.workspace, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		let reason: string | null = null;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const kill = (termination: NodeJS.Signals) => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, termination); else child.kill(termination); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
		};
		const stop = (why: string) => { reason ??= why; kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 1000); };
		const abort = () => stop("cancelled");
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop(`timeout after ${recipe.timeoutMs} ms`), recipe.timeoutMs);
		child.stdout.on("data", append); child.stderr.on("data", append);
		child.once("error", (error) => { reason = error.message; });
		child.once("close", (code, termination) => {
			clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener("abort", abort);
			if (reason) kill("SIGKILL");
			resolveResult({ ok: reason === null && code === 0, reason: reason ?? (termination ? `terminated by ${termination}` : `exited ${code}`) });
		});
		if (signal?.aborted) abort();
	});
	writeState(diagnosticsPath, { phase, command, ...outcome, output: tail.toString("utf8"), outputLimitBytes: OUTPUT_LIMIT });
	return { ...outcome, diagnosticsPath };
}

/** Holds the shared workspace lock through worker registration, including for unconfigured repositories. */
export async function prepareWorkspace(input: PreparationInput): Promise<PreparationGuard> {
	const workspace = realpathSync(input.workspace);
	const recipe = recipeFor(input.agentDir, workspace);
	let gitDir: string;
	try {
		gitDir = realpathSync(git(workspace, ["rev-parse", "--absolute-git-dir"]).trim());
		if (realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]).trim()) !== workspace) throw new Error("preparation requires the Git workspace root");
	} catch (error) {
		if (recipe) throw new WorkspacePreparationError("workspace", error instanceof Error ? error.message : String(error));
		return { result: { status: "unconfigured", workspace, reused: false, reason: "automatic preparation is not configured" }, beginLaunch() {}, retainLaunch() {}, failedLaunch() {}, release() {} };
	}
	const stateDir = join(gitDir, "pi-agent-wave-preparation");
	privateDirectory(stateDir);
	const unlock = lockDirectory(stateDir);
	const launchPath = join(stateDir, "launches.json");
	const ownReference = { dbPath: resolve(input.dbPath), operationId: input.operationId, ownerPid: process.pid };
	let begun = false, retainedLaunch = false, released = false;
	const release = () => {
		if (released) return;
		try { if (begun && !retainedLaunch) writeState(launchPath, references(launchPath).filter((entry) => entry.dbPath !== ownReference.dbPath || entry.operationId !== ownReference.operationId)); }
		finally { released = true; unlock(); }
	};
	try {
		let result: PreparationResult = { status: "unconfigured", workspace, reused: false, reason: "automatic preparation is not configured" };
		if (recipe) {
			const approved = approvalIdentity(recipe);
			assertApproval(input.agentDir, recipe, approved);
			const source = sourceSnapshot(recipe);
			const identity = digest({ workspace, runId: input.runId, approved, inputs: inputIdentity(workspace, recipe.dependencyInputs) });
			const receiptPath = join(stateDir, "receipts", `${digest(input.runId)}.json`);
			const raw = readState(receiptPath);
			const evidenceValid = (value: unknown, commands: readonly PreparationCommand[], phase: string): value is string[] => Array.isArray(value) && value.length === commands.length && value.every((path: unknown, index) => {
				if (typeof path !== "string" || !/^diagnostics\/[a-f0-9-]+\.json$/.test(path)) return false;
				const retained = readState(join(stateDir, path));
				return object(retained) && retained.ok === true && retained.phase === phase && canonical(retained.command) === canonical(commands[index]);
			});
			const previous: Receipt | null = object(raw) && raw.identity === identity && typeof raw.installed === "boolean" && typeof raw.ready === "boolean" && evidenceValid(raw.installEvidence, recipe.install, "install") && (!raw.ready || evidenceValid(raw.baselineEvidence, recipe.baseline, "baseline")) && Array.isArray(raw.baselineEvidence) && raw.baselineEvidence.every((path: unknown) => typeof path === "string") ? { identity, installed: raw.installed, ready: raw.ready, installEvidence: raw.installEvidence, baselineEvidence: raw.baselineEvidence } : null;
			let installEvidence = previous?.installEvidence ?? [];
			const checkpoint = (installed: boolean, ready: boolean, baselineEvidence: readonly string[] = []) => writeState(receiptPath, { identity, installed, ready, installEvidence, baselineEvidence });
			const execute = async (cmd: PreparationCommand, phase: string) => {
				assertApproval(input.agentDir, recipe, approved);
				input.progress?.(phase, { workspace, runId: input.runId });
				const outcome = await runCommand(cmd, recipe, phase, stateDir, input.signal);
				const changed = sourceChanges(source, sourceSnapshot(recipe));
				if (changed.length) {
					checkpoint(false, false);
					throw new WorkspacePreparationError(phase, `unexpected source changes: ${changed.join(", ")}; changes preserved for inspection`, outcome.diagnosticsPath);
				}
				assertApproval(input.agentDir, recipe, approved);
				return outcome;
			};
			let ready = false;
			if (previous?.installed) {
				checkpoint(false, false);
				const readiness = await execute(recipe.readiness, "readiness");
				if (!readiness.ok && (input.signal?.aborted || /timeout|cancelled/.test(readiness.reason))) throw new WorkspacePreparationError("readiness", readiness.reason, readiness.diagnosticsPath);
				ready = readiness.ok;
			}
			if (!(previous?.ready && ready)) {
				const live = workspaceWorkers(workspace, ownReference.dbPath, references(launchPath));
				if (live.length) throw new WorkspacePreparationError("active-workers", `dependency refresh/baseline blocked while workspace workers are active: ${live.join(", ")}; collect/stop them, then retry dispatch`);
				if (!ready) {
					installEvidence = [];
					checkpoint(false, false);
					for (const cmd of recipe.install) {
						const installed = await execute(cmd, "install");
						if (!installed.ok) throw new WorkspacePreparationError("install", installed.reason, installed.diagnosticsPath);
						installEvidence = [...installEvidence, relative(stateDir, installed.diagnosticsPath)];
					}
					const readiness = await execute(recipe.readiness, "readiness");
					if (!readiness.ok) throw new WorkspacePreparationError("readiness", readiness.reason, readiness.diagnosticsPath);
				}
				checkpoint(true, false);
				const baselineEvidence: string[] = [];
				for (const cmd of recipe.baseline) {
					const baseline = await execute(cmd, "baseline");
					if (!baseline.ok) throw new WorkspacePreparationError("baseline", baseline.reason, baseline.diagnosticsPath);
					baselineEvidence.push(relative(stateDir, baseline.diagnosticsPath));
				}
				const readiness = await execute(recipe.readiness, "readiness");
				if (!readiness.ok) throw new WorkspacePreparationError("readiness", readiness.reason, readiness.diagnosticsPath);
				checkpoint(true, true, baselineEvidence);
			} else checkpoint(true, true, previous.baselineEvidence);
			result = { status: "ready", workspace, reused: previous?.ready === true && ready, reason: "approved dependencies and baseline are ready", receiptPath };
		}
		if (input.signal?.aborted) throw new WorkspacePreparationError("cancellation", "cancelled before worker launch");
		return {
			result,
			beginLaunch() {
				if (released) throw new Error("preparation lock already released");
				if (input.signal?.aborted) throw new WorkspacePreparationError("cancellation", "cancelled before worker launch");
				writeState(launchPath, [...references(launchPath).filter((entry) => entry.dbPath !== ownReference.dbPath || entry.operationId !== ownReference.operationId), ownReference]);
				begun = true;
			},
			retainLaunch() { retainedLaunch = true; },
			failedLaunch() { retainedLaunch = false; },
			release,
		};
	} catch (error) { release(); throw error; }
}
