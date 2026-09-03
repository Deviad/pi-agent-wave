import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { auditAgentFsChanges, buildAgentFsInvocation, expectedAgentFsDb } from "../lib/agentfs-sandbox.ts";
import { productionSourceDigest } from "../scripts/production-audit.ts";

const DRIVER = join(process.cwd(), "extensions/pi-agent-wave/test/support/acpx-lifecycle-driver.mjs");
const TOKEN_FILE = process.env.PI_CLAUDE_OAUTH_TOKEN_FILE;
const RUN_REAL = process.env.RUN_REAL_ACPX_MATRIX === "1" && !!TOKEN_FILE && existsSync(TOKEN_FILE);
const EVIDENCE_DIR = process.env.MATRIX_EVIDENCE_DIR;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function linkIfPresent(source: string, destination: string): void {
	if (existsSync(source)) symlinkSync(source, destination);
}

// Mirrors delegate_core.worker_pi_settings: supervisor defaults only, zero packages (US-004).
function workerPiSettings(realHome: string): Record<string, unknown> {
	const settings: Record<string, unknown> = { packages: [] };
	const source = join(realHome, ".pi", "agent", "settings.json");
	if (!existsSync(source)) return settings;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(source, "utf8"));
	} catch {
		return settings;
	}
	if (typeof parsed !== "object" || parsed === null) return settings;
	for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel", "compaction", "retry"]) {
		if (key in parsed) settings[key] = (parsed as Record<string, unknown>)[key];
	}
	return settings;
}

function runAgent(agent: "pi" | "codex" | "claude", model: string): void {
	const tokenBefore = TOKEN_FILE ? readFileSync(TOKEN_FILE) : null;
	const root = mkdtempSync(join(tmpdir(), `real-acpx-${agent}-`));
	roots.push(root);
	const agentFsHome = join(root, "agentfs-home");
	const acpxHome = join(root, "acpx-home");
	const piDir = join(root, "pi-agent");
	const codexHome = join(root, "codex");
	const claudeConfig = join(root, "claude");
	for (const path of [agentFsHome, acpxHome, piDir, codexHome, claudeConfig]) mkdirSync(path, { mode: 0o700 });
	const realHome = process.env.HOME ?? "";
	for (const name of ["auth.json", "models.json", "models-store.json", "model-routing.jsonc"]) linkIfPresent(join(realHome, ".pi", "agent", name), join(piDir, name));
	// Execution-only worker settings: the supervisor's packages list must never load in a worker (US-004).
	writeFileSync(join(piDir, "settings.json"), `${JSON.stringify(workerPiSettings(realHome), null, 2)}\n`, { mode: 0o600 });
	for (const name of ["auth.json", "config.toml"]) linkIfPresent(join(realHome, ".codex", name), join(codexHome, name));
	for (const name of [".credentials.json", "settings.json"]) linkIfPresent(join(realHome, ".claude", name), join(claudeConfig, name));
	const tokenLink = join(root, "claude-setup-token");
	if (TOKEN_FILE) symlinkSync(TOKEN_FILE, tokenLink);
	const session = `matrix-${agent}-${process.pid}`;
	const resultPath = join(root, `${agent}-result.json`);
	const invocation = buildAgentFsInvocation({ sessionId: session, baseDir: process.cwd(), homeDir: agentFsHome, privateDir: root, command: process.execPath, args: [DRIVER] }, {
		...process.env,
		MATRIX_AGENT: agent,
		MATRIX_MODEL: model,
		MATRIX_SESSION: session,
		MATRIX_RESULT: resultPath,
		MATRIX_ACPX_HOME: acpxHome,
		MATRIX_PI_DIR: piDir,
		MATRIX_CODEX_HOME: codexHome,
		MATRIX_CLAUDE_CONFIG_DIR: claudeConfig,
		MATRIX_CLAUDE_TOKEN_FILE: tokenLink,
	});
	const run = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 300_000 });
	const resultDiagnostic = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "result file missing";
	assert.equal(run.status, 0, `${agent}: ${run.stderr}\n${run.stdout}\n${resultDiagnostic}`);
	const resultBytes = readFileSync(resultPath);
	const result = JSON.parse(resultBytes.toString("utf8"));
	assert.deepEqual({ ensured: result.ensured, queued: result.queued, cancelled: result.cancelled, reconnected: result.reconnected, closed: result.closed }, { ensured: true, queued: true, cancelled: true, reconnected: true, closed: true });
	const audit = auditAgentFsChanges(expectedAgentFsDb(agentFsHome, session), process.cwd(), []);
	assert.equal(audit.violations.length, 0);
	assert.equal(audit.owned.length, 0);
	if (TOKEN_FILE && tokenBefore) assert.equal(Buffer.compare(tokenBefore, readFileSync(TOKEN_FILE)), 0);
	if (EVIDENCE_DIR) {
		mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
		const sanitizedArgs = invocation.args.map((value) => value.replaceAll(root, "<temporary>").replaceAll(process.cwd(), "<repository>"));
		const evidence = {
			schemaVersion: 1,
			agent,
			runtimes: { acpx: "0.13.2", agentfs: "0.6.4" },
			invocation: { executable: invocation.executable, args: sanitizedArgs, cwd: "<repository>", exitCode: run.status },
			lifecycle: { ensured: result.ensured, queued: result.queued, cancelled: result.cancelled, reconnected: result.reconnected, closed: result.closed },
			resultSha256: createHash("sha256").update(resultBytes).digest("hex"),
			agentFs: { changes: audit.changes.length, owned: audit.owned.length, violations: audit.violations.length, dbSha256: createHash("sha256").update(readFileSync(expectedAgentFsDb(agentFsHome, session))).digest("hex") },
			credentialBoundary: { tokenFileUsed: agent === "claude", tokenMode: agent === "claude" && TOKEN_FILE ? (statSync(TOKEN_FILE).mode & 0o777).toString(8) : null, tokenUnchanged: agent === "claude" ? tokenBefore !== null && Buffer.compare(tokenBefore, readFileSync(TOKEN_FILE!)) === 0 : true, valuePersisted: false },
			productionSourceSha256: productionSourceDigest(process.cwd()),
			productionReport: `agent-output/production-acpx-worker-backend/real-matrix-${agent}-report.json`,
		};
		const output = join(EVIDENCE_DIR, `${agent}.json`);
		writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		chmodSync(output, 0o600);
	}
}

describe("real ACPX AgentFS lifecycle matrix", () => {
	test("Pi cancel and reconnect", { skip: !RUN_REAL, timeout: 300_000 }, () => runAgent("pi", "anthropic/claude-fable-5"));
	test("Codex cancel and reconnect", { skip: !RUN_REAL, timeout: 300_000 }, () => runAgent("codex", "gpt-5.6-sol"));
	test("Claude cancel and reconnect", { skip: !RUN_REAL, timeout: 300_000 }, () => runAgent("claude", "claude-opus-5"));
});
