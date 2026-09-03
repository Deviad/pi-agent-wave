import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: any): any { return JSON.parse(result.content[0].text); }

describe("Air ACP control surface", () => {
	test("controls headless delegation, progress, status, cancellation, and settlement without Herdr", { timeout: 20_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "air-acp-control-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_WORKSPACE_ID;
		delete process.env.HERDR_TAB_ID;
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: ["openai-codex/gpt-5.6-sol"], thinking: "off", session: true } }, roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])) }));
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
		try {
			const { default: extension } = await import(`../index.ts?air=${Date.now()}`);
			let tool: any;
			const fakePi = {
				registerCommand() {},
				registerTool(definition: any) { tool = definition; },
				exec: async (command: string, args: string[]) => {
					const result = spawnSync(command, args, { encoding: "utf8" });
					return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
				},
				sendUserMessage() {},
			} as unknown as ExtensionAPI;
			extension(fakePi);
			const schema = JSON.stringify(tool.parameters);
			assert.match(schema, /headless/);
			assert.match(schema, /cancel/);
			assert.match(schema, /resolve/);
			const updates: any[] = [];
			const onUpdate = (result: any) => updates.push(result.details);
			const context = {} as ExtensionContext;
			const init = parsed(await tool.execute("init", { op: "init", story: "air-headless", graph: "build", task: "Harmless fixture", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "Air fixture" } }, undefined, onUpdate, context));
			const operation = init.next.operations[0];
			const cancelScript = join(dir, "cancel.sh");
			const session = "headless-session";
			const attemptKey = "run:operation:thinker:0:0:model:codex";
			writeFileSync(cancelScript, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ action: "cancel_attempt", sessionName: session, recordId: session, attemptKey, cancelled: true, structuredCancelled: true, closed: true, noSession: true })}'\n`, { mode: 0o700 });
			chmodSync(cancelScript, 0o700);
			const payload = { acpx: { agent: "codex", recordId: session, sessionId: session, state: "alive", attemptKey, agentFsSessionId: session, agentFsDbPath: join(dir, "delta.db"), acpxCancelScript: cancelScript } };
			const running = parsed(await tool.execute("running", { op: "record", runId: init.state.runId, operationId: operation.id, status: "running", agentName: "headless-thinker", transport: "headless", policyDigest: init.next.policy.digest, modelPolicy: init.next.policy.input, selectedModel: operation.route.chain[0], modelAttempt: 0, payload }, undefined, onUpdate, context));
			assert.equal(running.error, undefined, running.error);
			const status = await tool.execute("status", { op: "status", runId: init.state.runId }, undefined, onUpdate, context);
			assert.match(status.content[0].text, /headless-thinker.*headless/);
			const cancelled = parsed(await tool.execute("cancel", { op: "cancel", runId: init.state.runId, operationId: operation.id }, undefined, onUpdate, context));
			assert.equal(cancelled.operation.status, "cancelled");

			const completeInit = parsed(await tool.execute("complete-init", { op: "init", story: "air-complete", graph: "build", task: "Complete fixture", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "Air fixture" } }, undefined, onUpdate, context));
			const completeOperation = completeInit.next.operations[0];
			const completeSession = "complete-session";
			const completeAttempt = "run:complete:thinker:0:0:model:codex";
			const completeCancel = join(dir, "complete-cancel.sh");
			writeFileSync(completeCancel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			chmodSync(completeCancel, 0o700);
			await tool.execute("complete-running", { op: "record", runId: completeInit.state.runId, operationId: completeOperation.id, status: "running", agentName: "complete-thinker", transport: "headless", policyDigest: completeInit.next.policy.digest, modelPolicy: completeInit.next.policy.input, selectedModel: completeOperation.route.chain[0], modelAttempt: 0, payload: { acpx: { agent: "codex", recordId: completeSession, sessionId: completeSession, state: "alive", attemptKey: completeAttempt, agentFsSessionId: completeSession, agentFsDbPath: join(dir, "complete.db"), acpxCancelScript: completeCancel } } }, undefined, onUpdate, context);
			const reportPath = join(dir, "report.json");
			writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, verdict: "READY", claims: [{ statement: "Air fixture completed", evidence: [{ kind: "command", source: "fixture", detail: "exit 0" }], verification: "verified" }] }), { mode: 0o600 });
			const cleanupEvidencePath = join(dir, "cleanup.json");
			writeFileSync(cleanupEvidencePath, JSON.stringify({ schemaVersion: 1, tabAbsent: true, paneAbsent: true, agentAbsent: true, attemptDirectoryAbsent: true, ownedProcessesAbsent: true, sessionClosed: true }), { mode: 0o600 });
			const settlementPath = join(dir, "settlement.json");
			writeFileSync(settlementPath, JSON.stringify({ schemaVersion: 1, transport: "headless", runId: completeInit.state.runId, operationId: completeOperation.id, agentName: "complete-thinker", acpAgent: "codex", acpxRecordId: completeSession, acpxSessionId: completeSession, acpxState: "idle", acpxAttemptKey: completeAttempt, agentFsSessionId: completeSession, agentFsDbPath: join(dir, "complete.db"), acpxCancelScript: completeCancel, processExitCode: 0, terminalKind: "completed", presentationVerified: true, identityMatches: true, reportPath, reportSha256: createHash("sha256").update(readFileSync(reportPath)).digest("hex"), agentFsExported: true, agentFsViolationCount: 0, sessionClosed: true, providerLinksVerified: true, ledgerValid: true, cleanupVerified: true, cleanupEvidencePath }), { mode: 0o600 });
			const completed = parsed(await tool.execute("complete", { op: "record", runId: completeInit.state.runId, operationId: completeOperation.id, status: "completed", verdict: "READY", reportPath, payload: { acpxSettlementEvidencePath: settlementPath, slices: [{ id: "air", name: "Air", task: "Complete fixture", ownedPaths: ["extensions/pi-agent-wave/**"] }] } }, undefined, onUpdate, context));
			assert.equal(completed.error, undefined, completed.error);
			assert.equal(completed.operation.status, "completed");
			assert.ok(updates.some((event) => event.kind === "run_created"));
			assert.ok(updates.some((event) => event.kind === "operation_started"));
			assert.ok(updates.some((event) => event.kind === "cancelled"));
			assert.ok(updates.some((event) => event.kind === "completed"));
			assert.doesNotMatch(JSON.stringify(updates), /Bearer |accessToken|refreshToken|sk-/);
		} finally {
			if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
			if (saved.db === undefined) delete process.env.DELEGATE_GRAPH_DB; else process.env.DELEGATE_GRAPH_DB = saved.db;
			if (saved.herdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = saved.herdrEnv;
			if (saved.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = saved.workspace;
			if (saved.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = saved.tab;
		}
	});
});
