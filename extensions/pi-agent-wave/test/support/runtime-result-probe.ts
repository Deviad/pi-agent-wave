import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkerConfig, workerEnvironment } from "../../scripts/acpx-worker.ts";
import { acpxModelArgument } from "../../lib/acpx-select.ts";
import { runRuntimeProcess } from "../../lib/runtime-process.ts";
import { sanitizeAcpxNdjson, parseAcpxNdjson } from "../../lib/acpx-events.ts";

const resultPath = process.argv[2];
const configPath = process.env.PI_ACPX_CONFIG;
if (!resultPath || !configPath) throw new Error("probe requires result and production worker config paths");
const config = parseWorkerConfig(JSON.parse(readFileSync(configPath, "utf8")));
const env = workerEnvironment(config);
const expectedSource = readFileSync("probe-source.txt", "utf8").trim();
const common = ["--cwd", process.cwd(), "--format", "json", "--json-strict", "--timeout", "120", "--ttl", "1", "--model", acpxModelArgument(config.selectedModel, config.agent), "--no-terminal", "--non-interactive-permissions", "fail"];
// One model turn answers the text prompt. Reading a source file is a tool call followed by the
// answer, which Claude counts as two turns: with --max-turns 1 it fails with "Reached maximum
// number of turns (1)" before answering. The cap is a session/new option, so a per-prompt value
// never reaches a session that is already alive (2026-09-12 evidence, two runs); every invocation
// therefore carries the same cap of two, and the text prompt still completes in one turn.
const maxTurns = (_index: number): string[] => ["--max-turns", "2"];
const result: { checksPassed: boolean; sessionClosed: boolean; probes: unknown[] } = { checksPassed: false, sessionClosed: false, probes: [] };
let passed = true;
try {
	const ensured = spawnSync(config.acpxExecutable, [...common, ...maxTurns(0), config.agent, "sessions", "ensure", "--name", config.sessionName], { env, encoding: "utf8", timeout: 30_000 });
	if (ensured.error || ensured.status !== 0) throw new Error("probe ensure failed");
	const envelope: unknown = JSON.parse(ensured.stdout.trim().split("\n").at(-1) ?? "null");
	if (!envelope || typeof envelope !== "object" || !("acpxSessionId" in envelope) || typeof envelope.acpxSessionId !== "string") throw new Error("unrecognized ensured session identity");
	for (const [index, prompt] of ["Reply with exactly PROBE_TEXT_OK. Do not use any tool.", "Read probe-source.txt using an ACP filesystem tool. Reply with exactly its text. Do not use a terminal."].entries()) {
		const outputDir = join(dirname(resultPath), `capture-${index}`);
		const output = await runRuntimeProcess({ executable: config.acpxExecutable, args: [...common, ...maxTurns(index), index === 0 ? "--deny-all" : "--approve-reads", config.agent, "--session", config.sessionName, prompt], cwd: process.cwd(), env, outputDir, identity: { attemptKey: `${config.sessionName}:${index}`, sessionId: envelope.acpxSessionId, requestId: null }, timeoutMs: 125_000 });
		const answer = readFileSync(join(outputDir, "public-answer.txt"), "utf8").trim();
		const raw = readFileSync(join(outputDir, "worker.stdout.ndjson"), "utf8");
		const events = parseAcpxNdjson(raw);
		const sourceToolObserved = events.some((event) => event.kind === "progress" && (event.updateType === "tool_call" || event.updateType === "tool_call_update"));
		const expected = index === 0 ? "PROBE_TEXT_OK" : expectedSource;
		const ok = output.outcome.kind === "exited" && output.capture.captureStatus === "complete" && answer === expected && (index === 0 || sourceToolObserved);
		passed &&= ok;
		result.probes.push({ index, passed: ok, outcome: output.outcome.kind, capture: output.capture, ensuredSessionMatched: output.capture.sessionId === envelope.acpxSessionId, sourceToolObserved, expectedAnswerMatched: answer === expected, protocol: sanitizeAcpxNdjson(raw) });
	}
} finally {
	const closed = spawnSync(config.acpxExecutable, [...common, ...maxTurns(0), config.agent, "sessions", "close", config.sessionName], { env, encoding: "utf8", timeout: 30_000 });
	result.sessionClosed = closed.status === 0 && closed.stdout.trim().split("\n").some((line) => {
		try { const value: unknown = JSON.parse(line); return value !== null && typeof value === "object" && "action" in value && value.action === "session_closed"; }
		catch { return false; }
	});
	result.checksPassed = passed && result.probes.length === 2 && result.sessionClosed;
	writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
}
process.exitCode = result.checksPassed ? 0 : 1;
