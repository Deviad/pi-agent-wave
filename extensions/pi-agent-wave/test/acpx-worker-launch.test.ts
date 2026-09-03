import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnsureArgv, buildPromptArgv, parseWorkerConfig, runAcpxWorker } from "../scripts/acpx-worker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ACPX = join(HERE, "support", "fake-acpx.mjs");
const CLAUDE_TEST_TOKEN = `sk-ant-oat01-${"x".repeat(64)}`;
const directories: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
	process.env = { ...originalEnv };
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(agent: "pi" | "codex" | "claude" = "codex", readOnly = false) {
	const directory = mkdtempSync(join(tmpdir(), "acpx-worker-"));
	directories.push(directory);
	const promptFile = join(directory, "prompt.md");
	const claudeTokenFile = join(directory, "claude-setup-token");
	writeFileSync(promptFile, "Write the report.\n", { mode: 0o600 });
	if (agent === "claude") writeFileSync(claudeTokenFile, `${CLAUDE_TEST_TOKEN}\n`, { mode: 0o600 });
	return parseWorkerConfig({
		schemaVersion: 1,
		acpxExecutable: FAKE_ACPX,
		agent,
		selectedModel: agent === "codex" ? "openai-codex/gpt-5.6-sol" : agent === "claude" ? "claude-code/claude-opus-5" : "alibaba/qwen3.8-max",
		sessionName: "dg-implementer-0-0-fixture",
		workspaceRelative: ".",
		node: "audit",
		reportPath: join(directory, "report.json"),
		claudeTokenFile: agent === "claude" ? claudeTokenFile : undefined,
		acpxHome: directory,
		promptFile,
		resultPath: join(directory, "result.json"),
		stdoutPath: join(directory, "stdout.ndjson"),
		stderrPath: join(directory, "stderr.txt"),
		timeoutSeconds: 5,
		hostReadOnly: readOnly,
		discardAllChanges: readOnly,
		noTerminal: false,
	});
}

describe("production ACPX worker", () => {
	test("builds direct ensure and strict prompt argv", () => {
		const config = fixture();
		assert.deepEqual(buildEnsureArgv(config).slice(-5), ["codex", "sessions", "ensure", "--name", config.sessionName]);
		const prompt = buildPromptArgv(config);
		assert.ok(prompt.includes("--json-strict"));
		assert.ok(prompt.includes("--permission-policy"));
		assert.ok(prompt.includes("gpt-5.6-sol"));
		assert.deepEqual(prompt.slice(-5), ["codex", "--session", config.sessionName, "--file", config.promptFile]);
	});

	test("always projects Pi reports from structured terminal facts, never assistant content", async () => {
		const config = fixture("pi");
		process.env.FAKE_ACPX_ASSISTANT = JSON.stringify({ schemaVersion: 1, verdict: "FAIL", claims: [{ statement: "untrusted assistant claim" }] });
		assert.equal(await runAcpxWorker(config), 0);
		const report = JSON.parse(readFileSync(config.reportPath, "utf8"));
		assert.equal(report.verdict, "PASS");
		assert.match(report.claims[0].statement, /Supervisor projection/);
		assert.doesNotMatch(JSON.stringify(report), /untrusted assistant claim/);
		assert.equal(JSON.parse(readFileSync(config.resultPath, "utf8")).piReportProjected, true);
	});

	test("ignores Pi free text and projects only structured terminal facts", async () => {
		const config = fixture("pi");
		process.env.FAKE_ACPX_ASSISTANT = "PASS: done";
		assert.equal(await runAcpxWorker(config), 0);
		const report = JSON.parse(readFileSync(config.reportPath, "utf8"));
		assert.equal(report.verdict, "PASS");
		assert.match(report.claims[0].statement, /Supervisor projection/);
		assert.match(report.claims[0].statement, /no semantic task claim is inferred/);
		assert.doesNotMatch(JSON.stringify(report), /PASS: done/);
	});

	test("records explicit host-read-only discard semantics without restricting overlay tools", async () => {
		const config = fixture("codex", true);
		assert.equal(await runAcpxWorker(config), 0);
		const result = JSON.parse(readFileSync(config.resultPath, "utf8"));
		assert.equal(result.hostReadOnly, true);
		assert.equal(result.discardAllChanges, true);
		assert.deepEqual(JSON.parse(buildPromptArgv(config)[buildPromptArgv(config).indexOf("--permission-policy") + 1]).autoDeny, []);
	});

	test("injects an ephemeral Claude OAuth token only into the child environment", async () => {
		const config = fixture("claude");
		process.env.FAKE_EXPECT_CLAUDE_TOKEN = CLAUDE_TEST_TOKEN;
		assert.equal(await runAcpxWorker(config), 0);
		const persisted = `${readFileSync(config.resultPath, "utf8")}${readFileSync(config.stdoutPath, "utf8")}${readFileSync(config.stderrPath, "utf8")}${JSON.stringify(buildPromptArgv(config))}`;
		assert.equal(persisted.includes(CLAUDE_TEST_TOKEN), false);
	});

	test("removes terminal capability for evidence-only review", () => {
		const config = parseWorkerConfig({ ...fixture("codex", true), noTerminal: true });
		const args = buildPromptArgv(config);
		assert.ok(args.includes("--no-terminal"));
		assert.ok(args.indexOf("--no-terminal") < args.indexOf("codex"));
	});

	test("streams structured output and persists independent result signals", async () => {
		const config = fixture();
		assert.equal(await runAcpxWorker(config), 0);
		const result = JSON.parse(readFileSync(config.resultPath, "utf8"));
		assert.equal(result.processExitCode, 0);
		assert.equal(result.status, "idle");
		assert.equal(result.terminal.kind, "completed");
		assert.match(readFileSync(config.stdoutPath, "utf8"), /session\/prompt/);
		assert.equal(readFileSync(config.stderrPath, "utf8"), "fixture-stderr\n");
	});
});
