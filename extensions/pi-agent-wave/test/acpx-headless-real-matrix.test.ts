import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { productionSourceDigest } from "../scripts/production-audit.ts";

const ROOT = process.cwd();
const DELEGATE = join(ROOT, "extensions/pi-agent-wave/scripts/delegate.ts");
const TOKEN_FILE = process.env.PI_CLAUDE_OAUTH_TOKEN_FILE;
const EVIDENCE_DIR = process.env.MATRIX_EVIDENCE_DIR;
const RUN_REAL = process.env.RUN_REAL_ACPX_HEADLESS_MATRIX === "1" && !!TOKEN_FILE && existsSync(TOKEN_FILE) && !!EVIDENCE_DIR;
const runDirectories: string[] = [];
afterEach(() => {
	for (const directory of runDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv, timeout = 300_000) {
	return spawnSync(process.execPath, ["--experimental-strip-types", DELEGATE, "--transport", "headless", "--", ...args], { cwd: ROOT, env, encoding: "utf8", timeout, shell: false });
}

function sanitize(value: unknown, runDir: string): unknown {
	if (Array.isArray(value)) return value.map((item) => sanitize(item, runDir));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, runDir)]));
	if (typeof value !== "string") return value;
	return value.replaceAll(runDir, "<temporary>").replaceAll(ROOT, "<repository>").replaceAll(process.env.HOME ?? "", "<home>").replaceAll(TOKEN_FILE ?? "", "<setup-token-file>");
}

function runAgent(agent: "pi" | "codex" | "claude", model: string): void {
	const env = { ...process.env, PI_CLAUDE_OAUTH_TOKEN_FILE: TOKEN_FILE };
	delete env.HERDR_ENV;
	delete env.HERDR_WORKSPACE_ID;
	delete env.HERDR_TAB_ID;
	const init = run(["init", `final-headless-${agent}`], env);
	assert.equal(init.status, 0, init.stderr);
	const runDir = init.stdout.trim();
	runDirectories.push(runDir);
	const taskFile = join(runDir, "task.md");
	const reportPath = join(runDir, "report.json");
	writeFileSync(taskFile, `Perform one harmless report-only production matrix turn for ${agent}. Do not modify repository files. Write the required schemaVersion 1 report with verdict PASS and one verified execution claim. Do not include credentials or provider responses.\n`, { mode: 0o600 });
	const started = run(["start", runDir, "auditor", "--policy", "auto", "--policy-digest", "72cf06816600122ea63a982f598604b09e5be1de196acc5665bd9739da915e59", "--model", model, "--reason", `final headless ${agent} matrix`, "--thinking", "low", "--session", "true", "--node", "audit", "--run-id", `final-headless-${agent}`, "--operation-id", `final-headless-${agent}-1`, "--owned-paths-json", "[]", "--model-attempt", "0", "--transient-attempt", "0", "--report", reportPath, "--task-file", taskFile], env);
	assert.equal(started.status, 0, started.stderr);
	const start = JSON.parse(started.stdout);
	assert.equal(start.transport, "headless");
	assert.equal(start.tab, null);
	assert.equal(start.pane, null);
	const waited = run(["wait", runDir, start.agent], env, 600_000);
	assert.equal(waited.status, 0, waited.stderr);
	const wait = JSON.parse(waited.stdout);
	assert.equal(wait.valid, true);
	assert.equal(wait.verdict, "PASS");
	assert.equal(wait.agentFsExport.violations.length, 0);
	assert.ok(wait.settlementEvidencePath);
	assert.ok(wait.cleanupEvidencePath);
	const reportBytes = readFileSync(reportPath);
	const settlementBytes = readFileSync(wait.settlementEvidencePath);
	const settlement = JSON.parse(settlementBytes.toString("utf8"));
	assert.equal(settlement.identityMatches, true);
	assert.equal(settlement.presentationVerified, true);
	assert.equal(settlement.transport, "headless");
	const cleanupBytes = readFileSync(wait.cleanupEvidencePath);
	const evidence = {
		schemaVersion: 1,
		productionSourceSha256: productionSourceDigest(ROOT),
		agent,
		start: sanitize(start, runDir),
		wait: sanitize(wait, runDir),
		settlement: sanitize(JSON.parse(settlementBytes.toString("utf8")), runDir),
		cleanup: sanitize(JSON.parse(cleanupBytes.toString("utf8")), runDir),
		hashes: { report: createHash("sha256").update(reportBytes).digest("hex"), settlement: createHash("sha256").update(settlementBytes).digest("hex"), cleanup: createHash("sha256").update(cleanupBytes).digest("hex") },
		tokenBoundary: { tokenFileUsed: agent === "claude", tokenMode: agent === "claude" && TOKEN_FILE ? (statSync(TOKEN_FILE).mode & 0o777).toString(8) : null, tokenPersisted: false },
		herdrResourcesAbsent: start.tab === null && start.pane === null && start["attempt-identity"].presentation.kind === "headless",
		herdrEnvironmentAbsent: env.HERDR_ENV === undefined && env.HERDR_WORKSPACE_ID === undefined && env.HERDR_TAB_ID === undefined,
	};
	const text = `${JSON.stringify(evidence, null, 2)}\n`;
	assert.doesNotMatch(text, /\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/);
	mkdirSync(EVIDENCE_DIR!, { recursive: true, mode: 0o700 });
	const output = join(EVIDENCE_DIR!, `${agent}-headless.json`);
	writeFileSync(output, text, { mode: 0o600 });
	chmodSync(output, 0o600);
	const cleaned = run(["cleanup", runDir], env);
	assert.equal(cleaned.status, 0, cleaned.stderr);
	rmSync(runDir, { recursive: true, force: true });
	runDirectories.splice(runDirectories.indexOf(runDir), 1);
}

describe("real production ACPX AgentFS headless matrix", () => {
	test("Pi production path", { skip: !RUN_REAL, timeout: 600_000 }, () => runAgent("pi", "anthropic/claude-fable-5"));
	test("Codex production path", { skip: !RUN_REAL, timeout: 600_000 }, () => runAgent("codex", "openai-codex/gpt-5.6-sol"));
	test("Claude production path", { skip: !RUN_REAL, timeout: 600_000 }, () => runAgent("claude", "claude-code/claude-opus-5"));
});
