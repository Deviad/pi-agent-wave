import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parsed(result: any): any {
	return JSON.parse(result.content[0].text);
}

describe("operational search tool contract", () => {
	test("exposes structured operations commands and automatically ledgers completion", { timeout: 5_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "operational-tool-"));
		dirs.push(dir);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousLedger = process.env.DELEGATE_GRAPH_LEDGER_BASE;
		const previousGraphDb = process.env.DELEGATE_GRAPH_DB;
		const previousIdentity = [process.env.HERDR_ENV, process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID];
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: ["fixture/local"], thinking: "off", session: false } }, roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])) }));
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1" } } }));
		process.env.DELEGATE_GRAPH_LEDGER_BASE = join(dir, "output");
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "test-workspace";
		process.env.HERDR_TAB_ID = "test-tab";
		try {
			const { default: extension } = await import(`../index.ts?operational=${Date.now()}`);
			let tool: any;
			const fakePi = {
				registerCommand() {},
				registerTool(definition: any) { tool = definition; },
				exec: async (command: string, args: string[]) => {
					const result = spawnSync(command, args, { encoding: "utf8" });
					return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
				},
			} as unknown as ExtensionAPI;
			extension(fakePi);
			const schema = JSON.stringify(tool.parameters);
			assert.match(schema, /operations/);
			assert.match(schema, /commands/);
			const runRoot = join(dir, "run");
			mkdirSync(runRoot);
			const init = parsed(await tool.execute("init", { op: "init", story: "operational-tool", graph: "operations", task: "Run exact source", modelPolicy: { kind: "model", model: "fixture/local", reason: "test lock" }, commands: [{ id: "linkedin", name: "LinkedIn", command: { executable: "node", args: ["search.mjs"], cwd: dir }, ownedPaths: [runRoot] }] }, undefined, undefined, {} as ExtensionContext));
			const next = parsed(await tool.execute("next", { op: "next", runId: init.state.runId }, undefined, undefined, {} as ExtensionContext));
			const operation = next.operations[0];
			const acpxPayload = { acpx: { agent: "pi", recordId: "record-fixture", sessionId: "session-fixture", state: "alive", attemptKey: "attempt-fixture", agentFsSessionId: "agentfs-fixture", agentFsDbPath: join(dir, "agentfs", "delta.db"), herdrPaneId: "pane-1", acpxCancelScript: join(dir, "cancel.sh") } };
			assert.deepEqual(JSON.parse(operation.command_json), { executable: "node", args: ["search.mjs"], cwd: dir });
			const running = parsed(await tool.execute("running", { op: "record", runId: init.state.runId, operationId: operation.id, status: "running", agentName: "searcher-1", transport: "herdr", herdrAgent: "searcher-1", tabId: "tab-1", policyDigest: next.policy.digest, modelPolicy: next.policy.input, selectedModel: operation.route.chain[0], modelAttempt: 0, payload: acpxPayload }, undefined, undefined, {} as ExtensionContext));
			assert.equal(running.error, undefined, running.error);
			const checkpointPath = join(runRoot, "checkpoint.json");
			const resultsPath = join(runRoot, "results.json");
			writeFileSync(checkpointPath, "{}", { mode: 0o600 });
			writeFileSync(resultsPath, "[]", { mode: 0o600 });
			const reportPath = join(dir, "report.json");
			writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: [{ statement: "source completed", evidence: [{ kind: "command", source: "node search.mjs", detail: "exit 0" }], verification: "verified" }], execution: { argv: ["node", "search.mjs"], exitCode: 0, source: "linkedin", runId: "linkedin-1", checkpointPath, checkpointStatus: "completed", resultsPath, candidateCount: 0, sourceStatus: "completed" } }), { mode: 0o600 });
			const cleanupEvidencePath = join(dir, "cleanup.json");
			writeFileSync(cleanupEvidencePath, JSON.stringify({ schemaVersion: 1, tabAbsent: true, paneAbsent: true, agentAbsent: true, attemptDirectoryAbsent: true, ownedProcessesAbsent: true, sessionClosed: true }), { mode: 0o600 });
			const settlementEvidencePath = join(dir, "settlement.json");
			writeFileSync(settlementEvidencePath, JSON.stringify({ schemaVersion: 1, runId: init.state.runId, operationId: operation.id, agentName: "searcher-1", herdrAgent: "searcher-1", tabId: "tab-1", acpAgent: "pi", acpxRecordId: "record-fixture", acpxSessionId: "session-fixture", acpxState: "alive", acpxAttemptKey: "attempt-fixture", agentFsSessionId: "agentfs-fixture", agentFsDbPath: join(dir, "agentfs", "delta.db"), herdrPaneId: "pane-1", acpxCancelScript: join(dir, "cancel.sh"), processExitCode: 0, terminalKind: "completed", herdrVisible: true, identityMatches: true, reportPath, reportSha256: createHash("sha256").update(readFileSync(reportPath)).digest("hex"), agentFsExported: true, agentFsViolationCount: 0, sessionClosed: true, providerLinksVerified: true, ledgerValid: true, cleanupVerified: true, cleanupEvidencePath }), { mode: 0o600 });
			const settled = parsed(await tool.execute("record", { op: "record", runId: init.state.runId, operationId: operation.id, status: "completed", verdict: "DONE", reportPath, payload: { acpxSettlementEvidencePath: settlementEvidencePath } }, undefined, undefined, {} as ExtensionContext));
			assert.equal(settled.error, undefined, settled.error);
			assert.ok(settled.ledgerPath);
			const ledgerFiles = readdirSync(join(dir, "output", "operational-tool", "delegate-ledger"));
			assert.equal(ledgerFiles.length, 1);
			assert.equal(JSON.parse(readFileSync(settled.ledgerPath, "utf8")).operationId, operation.id);

			const blockedInit = parsed(await tool.execute("blocked-init", { op: "init", story: "operational-blocked", graph: "operations", task: "Run blocked source", modelPolicy: { kind: "model", model: "fixture/local", reason: "test lock" }, commands: [{ id: "linkedin", name: "LinkedIn", command: { executable: "node", args: ["search.mjs"], cwd: dir }, ownedPaths: [join(dir, "blocked-run")] }] }, undefined, undefined, {} as ExtensionContext));
			const blockedNext = parsed(await tool.execute("blocked-next", { op: "next", runId: blockedInit.state.runId }, undefined, undefined, {} as ExtensionContext));
			const blockedOperation = blockedNext.operations[0];
			await tool.execute("blocked-running", { op: "record", runId: blockedInit.state.runId, operationId: blockedOperation.id, status: "running", agentName: "searcher-blocked", transport: "herdr", herdrAgent: "searcher-blocked", tabId: "tab-blocked", policyDigest: blockedNext.policy.digest, modelPolicy: blockedNext.policy.input, selectedModel: blockedOperation.route.chain[0], modelAttempt: 0, payload: acpxPayload }, undefined, undefined, {} as ExtensionContext);
			const blockedReport = join(dir, "blocked-report.json");
			writeFileSync(blockedReport, JSON.stringify({ schemaVersion: 1, verdict: "BLOCKED", claims: [{ statement: "source blocked", evidence: [{ kind: "output", source: "linkedin", detail: "security check" }], verification: "verified" }], execution: { argv: ["node", "search.mjs"], exitCode: 4, source: "linkedin", runId: "linkedin-blocked", checkpointPath: join(dir, "blocked-run", "checkpoint.json"), checkpointStatus: "blocked", resultsPath: join(dir, "blocked-run", "results.json"), candidateCount: 0, sourceStatus: "blocked", blocker: "linkedin security check" } }), { mode: 0o600 });
			const blocked = parsed(await tool.execute("blocked", { op: "record", runId: blockedInit.state.runId, operationId: blockedOperation.id, status: "blocked", verdict: "BLOCKED", reportPath: blockedReport }, undefined, undefined, {} as ExtensionContext));
			assert.equal(blocked.error, undefined, blocked.error);
			assert.equal(JSON.parse(readFileSync(blocked.ledgerPath, "utf8")).outcome, "blocked");

			const failedInit = parsed(await tool.execute("failed-init", { op: "init", story: "operational-failed", graph: "operations", task: "Run missing report source", modelPolicy: { kind: "model", model: "fixture/local", reason: "test lock" }, commands: [{ id: "indeed", name: "Indeed", command: { executable: "node", args: ["search.mjs"], cwd: dir }, ownedPaths: [join(dir, "failed-run")] }] }, undefined, undefined, {} as ExtensionContext));
			const failedNext = parsed(await tool.execute("failed-next", { op: "next", runId: failedInit.state.runId }, undefined, undefined, {} as ExtensionContext));
			const failedOperation = failedNext.operations[0];
			await tool.execute("failed-running", { op: "record", runId: failedInit.state.runId, operationId: failedOperation.id, status: "running", agentName: "searcher-failed", transport: "herdr", herdrAgent: "searcher-failed", tabId: "tab-failed", policyDigest: failedNext.policy.digest, modelPolicy: failedNext.policy.input, selectedModel: failedOperation.route.chain[0], modelAttempt: 0, payload: acpxPayload }, undefined, undefined, {} as ExtensionContext);
			const failed = parsed(await tool.execute("failed", { op: "record", runId: failedInit.state.runId, operationId: failedOperation.id, status: "failed", error: "delegate report rejected after repair" }, undefined, undefined, {} as ExtensionContext));
			assert.equal(failed.error, undefined, failed.error);
			assert.equal(JSON.parse(readFileSync(failed.ledgerPath, "utf8")).outcome, "failed");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousLedger === undefined) delete process.env.DELEGATE_GRAPH_LEDGER_BASE; else process.env.DELEGATE_GRAPH_LEDGER_BASE = previousLedger;
			if (previousGraphDb === undefined) delete process.env.DELEGATE_GRAPH_DB; else process.env.DELEGATE_GRAPH_DB = previousGraphDb;
			[process.env.HERDR_ENV, process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID] = previousIdentity;
		}
	});
});
