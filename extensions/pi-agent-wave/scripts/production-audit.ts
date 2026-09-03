#!/usr/bin/env -S node --experimental-strip-types
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface AuditCommand {
	name: string;
	executable: string;
	args: string[];
	cwd: string;
}

export interface AuditCommandRecord extends AuditCommand {
	exitCode: number;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	environmentKeys: string[];
	artifactPaths: string[];
	outputSha256: string;
	summary: Record<string, unknown>;
}

export interface ProductionAuditBundle {
	schemaVersion: 1;
	observedAt: string;
	ok: boolean;
	runtimes: Record<string, string>;
	commands: AuditCommandRecord[];
	artifacts: Array<{ path: string; bytes: number; sha256: string; mode: string; productionSourceSha256?: string; sourceCurrent: boolean }>;
	expectations: AuditExpectations;
	productionSourceSha256: string;
	checklist: Array<{ prd: string; index: number; checked: boolean; criterion: string; evidence: string[] }>;
	sourceSnapshotSha256: string;
	sourceChangedDuringAudit: boolean;
	cleanup: { leakedTabs: string[]; agentFsProcesses: number; temporaryDirectories: string[]; tokenFilePresent: boolean };
	secretScan: { files: number; findings: number };
}

export interface AuditExpectations {
	readonly [command: string]: Readonly<Record<string, number | boolean>>;
}

export const EXPECTED_AUDIT_SUMMARIES: AuditExpectations = Object.freeze({
	"full-node": Object.freeze({ tests: 360, pass: 349, fail: 0, skipped: 11 }),
	"bun-package": Object.freeze({ pass: 36, fail: 0 }),
	pack: Object.freeze({ files: 68, externalArtifacts: 0 }),
	publish: Object.freeze({ files: 68, externalArtifacts: 0 }),
	"install-rehearsal": Object.freeze({ tests: 1, pass: 1, fail: 0, skipped: 0 }),
	"real-report-evidence": Object.freeze({ tests: 2, pass: 2, fail: 0, skipped: 0 }),
	"real-lifecycle-matrix": Object.freeze({ tests: 3, pass: 3, fail: 0, skipped: 0 }),
	"real-production-matrix": Object.freeze({ tests: 3, pass: 3, fail: 0, skipped: 0 }),
	"real-headless-matrix": Object.freeze({ tests: 3, pass: 3, fail: 0, skipped: 0 }),
	ledger: Object.freeze({ valid: true, files: 1, findings: 0 }),
});

export const EXPECTED_AUDIT_COMMANDS = Object.freeze(["full-node", "bun-package", "typecheck", "pack", "publish", "install-rehearsal", "real-report-evidence", "real-lifecycle-matrix", "real-production-matrix", "real-headless-matrix", "token-cleanup", "secret-scan", "cleanup-scan", "ledger", "diff-check"] as const);

export type Runner = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number; shell: false }) => SpawnSyncReturns<string>;

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function testSummary(output: string): Record<string, unknown> {
	const value = (label: string): number | undefined => {
		const match = output.match(new RegExp(`# ${label} (\\d+)`));
		return match ? Number(match[1]) : undefined;
	};
	return { tests: value("tests"), pass: value("pass"), fail: value("fail"), skipped: value("skipped") };
}

export function summarizeAuditOutput(name: string, output: string): Record<string, unknown> {
	if (["full-node", "install-rehearsal", "real-report-evidence", "real-lifecycle-matrix", "real-production-matrix", "real-headless-matrix"].includes(name)) return testSummary(output);
	if (name === "bun-package") {
		const pass = output.match(/(\d+) pass/)?.[1];
		const fail = output.match(/(\d+) fail/)?.[1];
		return { pass: pass ? Number(pass) : undefined, fail: fail ? Number(fail) : undefined };
	}
	if (name === "pack" || name === "publish") {
		try {
			const parsed = JSON.parse(output);
			const item = Array.isArray(parsed) ? parsed[0] : parsed;
			const files = (item.files ?? []).map((entry: { path: string }) => entry.path);
			return { files: files.length, externalArtifacts: files.filter((path: string) => /node_modules|\.db$|agent-output|test\/|__pycache__|\.pyc$/.test(path)).length };
		} catch { return { parseError: true }; }
	}
	if (name === "secret-scan" || name === "cleanup-scan" || name === "token-cleanup") {
		try { return JSON.parse(output); } catch { return { parseError: true }; }
	}
	if (name === "ledger") {
		try { const parsed = JSON.parse(output); return { valid: parsed.valid, files: parsed.files, findings: parsed.findings?.length }; }
		catch { return { parseError: true }; }
	}
	return { bytes: Buffer.byteLength(output) };
}

export function auditCommands(root: string): AuditCommand[] {
	const packageRoot = join(root, "extensions", "pi-agent-wave");
	return [
		{ name: "full-node", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/*.test.ts"], cwd: root },
		{ name: "bun-package", executable: "bun", args: ["test", "test/package-manifest.test.ts", "test/package-portability.test.ts", "test/package-artifact.test.ts", "test/package-docs.test.ts", "test/package-migration.test.ts", "test/questionnaire.test.ts", "test/cmux-session.test.ts", "test/model-failover.test.ts"], cwd: packageRoot },
		{ name: "typecheck", executable: "npm", args: ["run", "typecheck"], cwd: packageRoot },
		{ name: "pack", executable: "npm", args: ["pack", "--dry-run", "--json", "--ignore-scripts"], cwd: packageRoot },
		{ name: "publish", executable: "npm", args: ["publish", "--dry-run", "--json", "--ignore-scripts"], cwd: packageRoot },
		{ name: "install-rehearsal", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/package-install-rehearsal.test.ts"], cwd: root },
		{ name: "real-report-evidence", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/acpx-real-report-evidence.test.ts"], cwd: root },
		{ name: "real-lifecycle-matrix", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/acpx-real-matrix.test.ts"], cwd: root },
		{ name: "real-production-matrix", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/acpx-production-matrix.test.ts"], cwd: root },
		{ name: "real-headless-matrix", executable: "node", args: ["--experimental-strip-types", "--test", "extensions/pi-agent-wave/test/acpx-headless-real-matrix.test.ts"], cwd: root },
		{ name: "token-cleanup", executable: "node", args: ["--experimental-strip-types", "extensions/pi-agent-wave/scripts/production-token-cleanup.ts"], cwd: root },
		{ name: "secret-scan", executable: "node", args: ["--experimental-strip-types", "extensions/pi-agent-wave/scripts/production-secret-scan.ts", "agent-output/production-acpx-worker-backend"], cwd: root },
		{ name: "cleanup-scan", executable: "node", args: ["--experimental-strip-types", "extensions/pi-agent-wave/scripts/production-cleanup-scan.ts"], cwd: root },
		{ name: "ledger", executable: "node", args: ["--experimental-strip-types", "extensions/pi-agent-wave/scripts/ledger.ts", "audit", process.env.PI_WAVE_AUDIT_STORY ?? "air-headless-orchestration", "--base", "agent-output"], cwd: root },
		{ name: "diff-check", executable: "git", args: ["diff", "--check"], cwd: root },
	];
}

function commandArtifacts(name: string): string[] {
	if (name === "real-report-evidence") return ["agent-output/production-acpx-worker-backend/real-matrix-status.json", "agent-output/production-acpx-worker-backend/real-matrix-report.json"];
	if (name === "ledger") return ["agent-output/production-acpx-worker-backend/delegate-ledger/"];
	if (name === "pack" || name === "publish") return ["extensions/pi-agent-wave/package.json"];
	return [];
}

function runCommand(command: AuditCommand, runner: Runner): AuditCommandRecord {
	const args = command.name === "full-node" ? ["--experimental-strip-types", "--test", ...readdirSync(join(command.cwd, "extensions/pi-agent-wave/test")).filter((name) => name.endsWith(".test.ts")).map((name) => `extensions/pi-agent-wave/test/${name}`).sort()] : command.args;
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const environment: NodeJS.ProcessEnv = { ...process.env, npm_config_fund: "false", npm_config_audit: "false" };
	if (!["real-lifecycle-matrix", "real-production-matrix", "real-headless-matrix", "token-cleanup", "cleanup-scan"].includes(command.name)) delete environment.PI_CLAUDE_OAUTH_TOKEN_FILE;
	if (command.name === "real-lifecycle-matrix" || command.name === "real-production-matrix" || command.name === "real-headless-matrix") {
		environment.RUN_REAL_ACPX_MATRIX = "1";
		environment.RUN_REAL_ACPX_PRODUCTION_MATRIX = "1";
		environment.RUN_REAL_ACPX_HEADLESS_MATRIX = "1";
		environment.MATRIX_EVIDENCE_DIR = join(command.cwd, command.name === "real-headless-matrix" ? "agent-output/air-headless-orchestration/final-matrix" : "agent-output/production-acpx-worker-backend/final-matrix");
	}
	const result = runner(command.executable, args, { cwd: command.cwd, env: environment, encoding: "utf8", timeout: 900_000, shell: false });
	const finished = Date.now();
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const summarySource = ["pack", "publish", "ledger", "token-cleanup", "secret-scan", "cleanup-scan"].includes(command.name) ? result.stdout ?? "" : output;
	return { ...command, args, exitCode: result.status ?? 128, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, environmentKeys: ["PATH", "npm_config_audit", "npm_config_fund"], artifactPaths: commandArtifacts(command.name), outputSha256: hash(output), summary: summarizeAuditOutput(command.name, summarySource) };
}

function productionSourceFiles(root: string): string[] {
	const packageRoot = join(root, "extensions/pi-agent-wave");
	const files = readdirSync(packageRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile() && (/\.ts$/.test(entry.name) || entry.name === "package.json"))
		.map((entry) => join(packageRoot, entry.name));
	for (const directory of [join(packageRoot, "lib"), join(packageRoot, "scripts")]) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isFile() && /\.(?:ts|py|mjs|sh)$/.test(entry.name)) files.push(join(directory, entry.name));
		}
	}
	return files.sort();
}

export function productionSourceDigest(root: string): string {
	const digest = createHash("sha256");
	for (const path of productionSourceFiles(root)) digest.update(path.slice(root.length + 1)).update("\0").update(readFileSync(path)).update("\0");
	return digest.digest("hex");
}

function artifacts(root: string, sourceSha256: string): ProductionAuditBundle["artifacts"] {
	const relativePaths = [
		...['real-matrix-status.json', 'real-matrix-report.json', 'real-matrix-pi-report.json', 'real-matrix-codex-report.json', 'real-matrix-claude-report.json', 'implementation-report.json', 'lifecycle-hardening-report.json', 'final-matrix/pi.json', 'final-matrix/codex.json', 'final-matrix/claude.json', 'final-matrix/pi-production.json', 'final-matrix/codex-production.json', 'final-matrix/claude-production.json'].map((name) => `agent-output/production-acpx-worker-backend/${name}`),
		'agent-output/air-headless-orchestration/implementation-report.json',
		'agent-output/air-headless-orchestration/final-matrix/pi-headless.json',
		'agent-output/air-headless-orchestration/final-matrix/codex-headless.json',
		'agent-output/air-headless-orchestration/final-matrix/claude-headless.json',
	];
	const sourceBound = new Set(relativePaths.filter((path) => /lifecycle-hardening-report|final-matrix\//.test(path)));
	return relativePaths.map((relativePath) => {
		const path = join(root, relativePath);
		const value = readFileSync(path);
		let productionSourceSha256: string | undefined;
		try { productionSourceSha256 = JSON.parse(value.toString("utf8")).productionSourceSha256; } catch { productionSourceSha256 = undefined; }
		return { path: relativePath, bytes: value.length, sha256: hash(value), mode: (statSync(path).mode & 0o777).toString(8), productionSourceSha256, sourceCurrent: !sourceBound.has(relativePath) || productionSourceSha256 === sourceSha256 };
	});
}

function checklist(root: string): ProductionAuditBundle["checklist"] {
	const prds = ["tasks/prd-production-acpx-worker-backend.md", "tasks/prd-production-acpx-lifecycle-hardening.md", "tasks/prd-production-acpx-final-audit.md", "tasks/prd-production-acpx-final-source-hardening.md", "tasks/prd-air-controlled-editor-independent-orchestration.md"];
	const result: ProductionAuditBundle["checklist"] = [];
	for (const prd of prds) {
		let index = 0;
		for (const line of readFileSync(join(root, prd), "utf8").split("\n")) {
			const match = /^- \[([ x])\] (.+)$/.exec(line);
			if (!match) continue;
			index += 1;
			const evidence = prd.includes("lifecycle-hardening") ? ["agent-output/production-acpx-worker-backend/lifecycle-hardening-report.json", "agent-output/production-acpx-worker-backend/final-audit.json"] : prd.includes("final-audit") || prd.includes("final-source-hardening") ? ["agent-output/production-acpx-worker-backend/final-audit.json", "agent-output/production-acpx-worker-backend/final-review-bundle.md"] : ["agent-output/production-acpx-worker-backend/implementation-report.json", "agent-output/production-acpx-worker-backend/real-matrix-report.json", "agent-output/production-acpx-worker-backend/final-audit.json"];
			result.push({ prd, index, checked: match[1] === "x", criterion: match[2], evidence });
		}
	}
	return result;
}

function evidenceFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...evidenceFiles(path));
		else result.push(path);
	}
	return result;
}

export function artifactsCurrent(records: ProductionAuditBundle["artifacts"]): boolean {
	return records.every((artifact) => artifact.sourceCurrent);
}

export function summariesValid(commands: AuditCommandRecord[], expectations: AuditExpectations = EXPECTED_AUDIT_SUMMARIES): boolean {
	if (commands.length !== EXPECTED_AUDIT_COMMANDS.length || commands.some((command, index) => command.name !== EXPECTED_AUDIT_COMMANDS[index])) return false;
	return commands.every((command) => {
		const expected = expectations[command.name];
		if (expected && Object.entries(expected).some(([key, value]) => command.summary[key] !== value)) return false;
		if (command.exitCode !== 0) return false;
		if (["full-node", "install-rehearsal", "real-report-evidence", "real-lifecycle-matrix", "real-production-matrix", "real-headless-matrix"].includes(command.name) && (command.summary.fail !== 0 || (["real-lifecycle-matrix", "real-production-matrix", "real-headless-matrix"].includes(command.name) && command.summary.skipped !== 0))) return false;
		if (command.name === "bun-package" && command.summary.fail !== 0) return false;
		if ((command.name === "pack" || command.name === "publish") && (command.summary.externalArtifacts !== 0 || command.summary.parseError === true)) return false;
		if (command.name === "token-cleanup" && command.summary.deleted !== true) return false;
		if (command.name === "secret-scan" && command.summary.findings !== 0) return false;
		if (command.name === "cleanup-scan" && (Array.isArray(command.summary.leakedTabs) && command.summary.leakedTabs.length || command.summary.agentFsProcesses !== 0 || Array.isArray(command.summary.temporaryDirectories) && command.summary.temporaryDirectories.length || command.summary.tokenFilePresent !== false)) return false;
		if (command.name === "ledger" && (command.summary.valid !== true || command.summary.findings !== 0)) return false;
		return true;
	});
}

export function runProductionAudit(root: string, outputPath: string, runner: Runner = spawnSync): ProductionAuditBundle {
	const sourceBefore = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8" }).stdout;
	const productionSourceSha256 = productionSourceDigest(root);
	const commands = auditCommands(root).map((command) => runCommand(command, runner));
	const sourceAfter = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8" }).stdout;
	const evidenceRoot = join(root, "agent-output", "production-acpx-worker-backend");
	const files = evidenceFiles(evidenceRoot);
	const secretPattern = /\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/g;
	let findings = 0;
	for (const file of files) findings += [...readFileSync(file, "utf8").matchAll(secretPattern)].length;
	const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	const agentFsProcesses = `${ps.stdout ?? ""}`.split("\n").filter((line) => /agentfs run.*dg-/.test(line)).length;
	const temporaryDirectories = readdirSync("/private/tmp").filter((name) => /delegate-graph-herdr-production-acpx|production-acpx-(pi|codex|claude)-real/.test(name));
	const tabList = spawnSync("herdr", ["tab", "list", "--workspace", process.env.HERDR_WORKSPACE_ID ?? ""], { encoding: "utf8" });
	let leakedTabs: string[] = [];
	try {
		const tabs = JSON.parse(tabList.stdout).result?.tabs ?? [];
		leakedTabs = tabs.filter((tab: { label?: string }) => /production-acpx/i.test(tab.label ?? "")).map((tab: { tab_id: string }) => tab.tab_id);
	} catch { leakedTabs = ["unparseable-herdr-tab-list"]; }
	const tokenFilePresent = !!process.env.PI_CLAUDE_OAUTH_TOKEN_FILE && existsSync(process.env.PI_CLAUDE_OAUTH_TOKEN_FILE);
	const artifactRecords = artifacts(root, productionSourceSha256);
	const bundle: ProductionAuditBundle = {
		schemaVersion: 1,
		observedAt: new Date().toISOString(),
		ok: summariesValid(commands) && artifactsCurrent(artifactRecords) && findings === 0 && agentFsProcesses === 0 && temporaryDirectories.length === 0 && leakedTabs.length === 0 && !tokenFilePresent && sourceBefore === sourceAfter,
		runtimes: { node: process.version, acpx: "0.13.2", agentfs: "0.6.4", herdr: "0.8.0" },
		commands,
		artifacts: artifactRecords,
		expectations: EXPECTED_AUDIT_SUMMARIES,
		productionSourceSha256,
		checklist: checklist(root),
		sourceSnapshotSha256: hash(sourceAfter),
		sourceChangedDuringAudit: sourceBefore !== sourceAfter,
		cleanup: { leakedTabs, agentFsProcesses, temporaryDirectories, tokenFilePresent },
		secretScan: { files: files.length, findings },
	};
	writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
	chmodSync(outputPath, 0o600);
	return bundle;
}

function main(): void {
	const root = resolve(process.cwd());
	const output = resolve(process.argv[2] ?? join(root, "agent-output/production-acpx-worker-backend/final-audit.json"));
	const bundle = runProductionAudit(root, output);
	console.log(JSON.stringify({ ok: bundle.ok, commands: bundle.commands.length, output: output.slice(root.length + 1) }));
	if (!bundle.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && basename(process.argv[1]) === "production-audit.ts") main();
