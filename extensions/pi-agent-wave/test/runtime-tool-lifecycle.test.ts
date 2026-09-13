import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

async function harness(dir: string, calls: string[][]): Promise<{ tool: Record<string, any> }> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: ["openai-codex/gpt-5.6-sol"], thinking: "off", session: true } }, roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])) }));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?runtime-tool=${Date.now()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand() {}, on() {}, registerTool(definition: Record<string, any>) { tool = definition; },
		exec: async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			if (!args.some((arg) => arg.endsWith("policy-resolver.mjs"))) throw new Error(`unexpected execution: ${command} ${args.join(" ")}`);
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return { tool };
}

test("an enabled adapter lets a runtime-v1 run initialize, settle from durable evidence and advance only on an explicit decision", async () => {
	const dir = mkdtempSync(join(tmpdir(), "runtime-tool-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	const calls: string[][] = [];
	try {
		const { tool } = await harness(dir, calls);
		const ctx = {} as ExtensionContext;
		const init = parsed(await tool.execute("init", { op: "init", story: "runtime", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, ctx));
		assert.equal(init.error, undefined, JSON.stringify(init));
		const runId: string = init.state.runId;
		const operation = init.next.operations[0];
		const forbidden = parsed(await tool.execute("record", { op: "record", runId, operationId: operation.id, status: "completed", verdict: "READY" }, undefined, () => {}, ctx));
		assert.match(String(forbidden.error), /op=record accepts only status=cancelled/);

		// Register the worker attempt the way dispatch does, with its private run directory on disk, but no live worker.
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		const privateRunDir = join(dir, "private-run"); const attemptDir = join(privateRunDir, "acpx", "worker-1"); mkdirSync(attemptDir, { recursive: true });
		const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const agentId = store.registerAgent({ runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, policyDigest: store.policy(runId).digest, selectedModel: "openai-codex/gpt-5.6-sol", modelAttempt: 0, currentTask: operation.task });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
		const answer = store.retainRuntimeContent(Buffer.from("Finding with sources"));
		store.close();
		writeFileSync(join(privateRunDir, "runtime-settlement-worker-1.json"), JSON.stringify({ schemaVersion: 1, resultContract: "runtime-v1", attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "acp-created", requestId: "3", sessionOrigin: "created", captureStatus: "complete", manifest: null }, answer, stagedFiles: 0, diagnostics: [] }), { mode: 0o600 });

		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.equal(collected.error, undefined, JSON.stringify(collected));
		assert.equal(collected.attempt.processState, "exited");
		assert.equal(collected.attempt.acceptance, "pending");
		assert.equal(collected.candidate, "research");
		assert.equal(collected.operation.status, "running");
		assert.deepEqual(parsed(await tool.execute("collect", { op: "collect", runId, operationId: operation.id }, undefined, () => {}, ctx)).attempt, collected.attempt);
		const status = (await tool.execute("status", { op: "status", runId }, undefined, () => {}, ctx)) as { content: { text: string }[] };
		assert.match(status.content[0].text, /acceptance=pending.*capture=complete.*session=created/);
		const undecided = parsed(await tool.execute("decide", { op: "decide", runId, operationId: operation.id, decision: "accepted" }, undefined, () => {}, ctx));
		assert.match(String(undecided.error), /reason/);
		const decided = parsed(await tool.execute("decide", { op: "decide", runId, operationId: operation.id, decision: "accepted", reason: "independent review confirmed source support", payload: { slices: [{ id: "s1", name: "s1", task: "Search", ownedPaths: [] }] } }, undefined, () => {}, ctx));
		assert.equal(decided.error, undefined, JSON.stringify(decided));
		assert.equal(decided.attempt.acceptance, "accepted");
		assert.equal(decided.operation.status, "completed");
		assert.notEqual(decided.state.currentNode, operation.node);
		assert.ok(decided.next.operations.length >= 1);
		assert.ok(calls.every((call) => call.some((arg) => arg.endsWith("policy-resolver.mjs"))), "only policy resolution may execute");
	} finally { process.env = originalEnv; }
});

test("a transient runtime failure is replaced through op=retry and only the next frozen identity can register", async () => {
	const dir = mkdtempSync(join(tmpdir(), "runtime-tool-retry-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	const calls: string[][] = [];
	try {
		const { tool } = await harness(dir, calls);
		const ctx = {} as ExtensionContext;
		const init = parsed(await tool.execute("init", { op: "init", story: "runtime-retry", graph: "research", task: "Investigate", modelPolicy: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "fixture" } }, undefined, () => {}, ctx));
		assert.equal(init.error, undefined, JSON.stringify(init));
		const runId: string = init.state.runId;
		const operation = init.next.operations[0];
		const unknownRefusal = parsed(await tool.execute("retry", { op: "retry", runId, operationId: "op_does-not-exist" }, undefined, () => {}, ctx));
		assert.match(String(unknownRefusal.error), /unknown operation/);

		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		const privateRunDir = join(dir, "private-run"); const attemptDir = join(privateRunDir, "acpx", "worker-1"); mkdirSync(attemptDir, { recursive: true });
		const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const agentId = store.registerAgent({ runId, name: "worker-1", node: operation.node, role: "thinker", transport: "headless", acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, policyDigest: store.policy(runId).digest, selectedModel: "openai-codex/gpt-5.6-sol", modelAttempt: 0, currentTask: operation.task });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
		store.close();
		const early = parsed(await tool.execute("retry", { op: "retry", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.match(String(early.error), /still running/);
		writeFileSync(join(privateRunDir, "runtime-settlement-worker-1.json"), JSON.stringify({ schemaVersion: 1, resultContract: "runtime-v1", attemptKey: identity.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "ACPX worker failed while prompting" }, answer: null, stagedFiles: 0, diagnostics: [] }), { mode: 0o600 });
		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.equal(collected.error, undefined, JSON.stringify(collected));
		assert.equal(collected.attempt.processState, "failed");
		assert.equal(collected.operation.status, "running");
		const decideRefused = parsed(await tool.execute("decide", { op: "decide", runId, operationId: operation.id, decision: "accepted", reason: "no candidate" }, undefined, () => {}, ctx));
		assert.match(String(decideRefused.error), /settled candidate/);

		const retried = parsed(await tool.execute("retry", { op: "retry", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.equal(retried.error, undefined, JSON.stringify(retried));
		assert.deepEqual([retried.exhausted, retried.classification, retried.retry.attempt, retried.retry.modelAttempt, retried.operation.status, retried.state.status], [false, "worker-runtime-failure", 1, 0, "pending", "active"]);
		assert.ok(retried.previousAttempt.supersededAt);
		assert.equal(retried.next.operations[0].transient_attempts, 1);
		assert.equal(retried.next.operations[0].runtimeAttempt, undefined);
		const again = parsed(await tool.execute("retry", { op: "retry", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.match(String(again.error), /launch failure text/);
		const collectGone = parsed(await tool.execute("collect", { op: "collect", runId, operationId: operation.id }, undefined, () => {}, ctx));
		assert.match(String(collectGone.error), /no registered runtime attempt/);

		const fence = new GraphStore({ dbPath: join(dir, "graph.db") });
		assert.throws(() => fence.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: fence.policy(runId).digest }), /conflicts with operation/);
		const next = createHeadlessAcpxAttemptIdentity({ ...identity, transientAttempt: 1 });
		const replacement = fence.beginRuntimeAttempt({ identity: next, sessionId: next.sessionName, requestId: null, policyDigest: fence.policy(runId).digest });
		assert.equal(replacement.attemptKey, next.attemptKey);
		assert.equal(fence.runtimeAttempt(identity.attemptKey).processState, "failed");
		fence.close();
		assert.ok(calls.every((call) => call.some((arg) => arg.endsWith("policy-resolver.mjs"))), "only policy resolution may execute");
	} finally { process.env = originalEnv; }
});
