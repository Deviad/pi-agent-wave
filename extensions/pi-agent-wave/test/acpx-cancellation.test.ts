import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkerConfig, runAcpxWorker } from "../scripts/acpx-worker.ts";
import { cancelAttempt } from "../scripts/acpx-cancel.ts";

const FAKE_ACPX = join(dirname(fileURLToPath(import.meta.url)), "support", "fake-acpx.mjs");
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config() {
	const directory = mkdtempSync(join(tmpdir(), "acpx-close-"));
	directories.push(directory);
	const prompt = join(directory, "prompt.md");
	writeFileSync(prompt, "unused\n");
	return parseWorkerConfig({ schemaVersion: 1, acpxExecutable: FAKE_ACPX, agent: "codex", selectedModel: "openai-codex/gpt-5.6-sol", sessionName: "cancel-session", workspaceRelative: ".", node: "implement", reportPath: join(directory, "report.json"), acpxHome: directory, mode: "close", promptFile: prompt, resultPath: join(directory, "result.json"), stdoutPath: join(directory, "stdout"), stderrPath: join(directory, "stderr"), timeoutSeconds: 5, hostReadOnly: false, discardAllChanges: false, noTerminal: false });
}

describe("structured ACPX cancellation and close", () => {
	test("shared focus cancellation waits for cancelled terminal, close, and no-session", () => {
		const directory = mkdtempSync(join(tmpdir(), "acpx-focus-cancel-"));
		directories.push(directory);
		const result = cancelAttempt({ schemaVersion: 1, acpxExecutable: FAKE_ACPX, agent: "codex", sessionName: "focus-session", recordId: "focus-session", attemptKey: "run:operation:reviewer:0:0:openai-codex/gpt-5.6-sol:codex", cwd: process.cwd(), acpxHome: directory, timeoutSeconds: 5 });
		assert.deepEqual(result, { action: "cancel_attempt", sessionName: "focus-session", recordId: "focus-session", attemptKey: "run:operation:reviewer:0:0:openai-codex/gpt-5.6-sol:codex", cancelled: true, structuredCancelled: true, closed: true, noSession: true });
	});

	test("worker configuration exposes no independent cancel mode", () => {
		const worker = config();
		const parsed = parseWorkerConfig({ ...worker, mode: "cancel" });
		assert.equal(parsed.mode, "prompt");
	});

	test("close verifies session_closed and no-session", async () => {
		const worker = config();
		assert.equal(await runAcpxWorker(worker), 0);
		const result = JSON.parse(readFileSync(worker.resultPath, "utf8"));
		assert.equal(result.closed, true);
		assert.equal(result.noSession, true);
	});
});
