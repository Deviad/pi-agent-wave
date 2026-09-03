import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildPromptArgv, parseWorkerConfig } from "../scripts/acpx-worker.ts";

describe("production evidence-only review gate", () => {
	test("places --no-terminal before the ACP agent command", () => {
		const directory = mkdtempSync(join(tmpdir(), "review-gate-"));
		try {
			const prompt = join(directory, "prompt.md");
			writeFileSync(prompt, "Inspect durable evidence.\n");
			const config = parseWorkerConfig({ schemaVersion: 1, acpxExecutable: "/usr/bin/false", agent: "codex", selectedModel: "openai-codex/gpt-5.6-sol", sessionName: "review", workspaceRelative: ".", node: "review", reportPath: join(directory, "report.json"), acpxHome: directory, mode: "prompt", promptFile: prompt, resultPath: join(directory, "result.json"), stdoutPath: join(directory, "stdout"), stderrPath: join(directory, "stderr"), timeoutSeconds: 5, hostReadOnly: true, discardAllChanges: true, noTerminal: true });
			const args = buildPromptArgv(config);
			assert.ok(args.includes("--no-terminal"));
			assert.ok(args.indexOf("--no-terminal") < args.indexOf("codex"));
			assert.equal(args.includes("--no-fs"), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("threads the no-terminal flag through the shared production lifecycle", () => {
		for (const name of ["headless_delegate.py", "herdr_delegate.py"]) {
			const script = join(process.cwd(), "extensions/pi-agent-wave/scripts", name);
			const help = spawnSync("python3", [script, "start", "--help"], { encoding: "utf8" });
			assert.equal(help.status, 0, help.stderr);
			assert.match(help.stdout, /--no-terminal/);
		}
		const source = readFileSync(join(process.cwd(), "extensions/pi-agent-wave/scripts/delegate_core.py"), "utf8");
		assert.match(source, /"noTerminal": args\.no_terminal/);
		assert.match(source, /Terminal capability is disabled/);
	});
});
