import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { supervisorContract } from "../contract.ts";

/**
 * The supervisor contract and tool guidance must describe the runtime-v1 loop the tool actually accepts
 * (2026-09-13 session: the contract still asked for op=record status=completed, so the model tried op=resolve
 * defer and op=decide defer, then op=decide accepted without slices, and both runs stayed at thinker_plan).
 */

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];
const MODEL = "openai-codex/gpt-5.6-sol";

async function harness(dir: string): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({ default_tier: "tools", tiers: { tools: { models: [MODEL], thinking: "off", session: true } }, roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])) }));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?supervisor-contract=${Date.now()}-${Math.random()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand() {}, on() {}, sendUserMessage() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		exec: async (command: string, args: string[]) => {
			if (!args.some((arg) => arg.endsWith("policy-resolver.mjs"))) throw new Error(`unexpected execution: ${command} ${args.join(" ")}`);
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
	} as unknown as ExtensionAPI);
	return tool;
}

/** Registers and settles a thinker worker the way dispatch plus the worker would, without a launch. */
function settledThinker(store: GraphStore, dir: string, runId: string, operationId: string, answerText: string): string {
	const operation = store.getOperation(operationId);
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: "thinker", modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel: MODEL, agent: "codex" });
	const attemptDir = join(dir, "private-run", "acpx", "thinker-1"); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
	const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const agentId = store.registerAgent({ runId, name: "thinker-1", node: operation.node, role: "thinker", transport: "headless", selectedModel: MODEL, modelAttempt: operation.model_attempt, acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
	const answer = store.retainRuntimeContent(Buffer.from(answerText));
	store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: identity.sessionName, requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	return identity.attemptKey;
}

test("the supervisor contract describes the runtime-v1 loop the tool accepts", () => {
	const text = supervisorContract("run_x", "build", "Add a sentence");
	assert.match(text, /^Delegate Graph run run_x started for: Add a sentence\n/, "the opening line is what the fake supervisor and the operator recognise");
	for (const needle of ["op=next", "op=dispatch", "op=collect", "op=decide", "accepted or rejected", "payload.slices", "op=integrate", "op=retry", "op=resolve", "awaiting_user", "op=cancel"]) assert.ok(text.includes(needle), `contract names ${needle}`);
	assert.equal(text.includes("status=completed"), false, "no completed record exists on runtime-v1");
	assert.equal(text.includes("reportPath"), false);
	assert.equal(text.includes("acpxSettlementEvidencePath"), false);
	assert.match(text, /op=record is refused on runtime-v1 runs; cancellation is op=cancel/);
	assert.match(text, /op=resolve[^.]*refused while the run is active/);
});

test("op=decide refuses recovery choices with a message that names op=resolve", async () => {
	const dir = mkdtempSync(join(tmpdir(), "supervisor-decide-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const tool = await harness(dir);
		const init = parsed(await tool.execute("init", { op: "init", story: "decide-guard", graph: "build", task: "Tell me the time", modelPolicy: { kind: "model", model: MODEL, reason: "fixture" } }, undefined, () => {}, {} as ExtensionContext));
		const runId: string = init.state.runId; const operationId: string = init.next.operations[0].id;
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		settledThinker(store, dir, runId, operationId, "Sunday, September 13, 2026.\n");
		for (const decision of ["defer", "retry", "abort", "escalate"]) {
			const result = parsed(await tool.execute("decide", { op: "decide", runId, operationId, decision, reason: "guess" }, undefined, () => {}, {} as ExtensionContext));
			assert.match(String(result.error), new RegExp(`op=decide takes accepted or rejected with a reason; ${decision} is an op=resolve choice for a parked run`));
		}
		const resolve = parsed(await tool.execute("resolve", { op: "resolve", runId, operationId, decision: "defer", reason: "guess" }, undefined, () => {}, {} as ExtensionContext));
		assert.match(String(resolve.error), /run is not awaiting a recovery decision/, "resolve on an active run stays refused");
		assert.equal(store.getOperation(operationId).status, "running", "a refused decision changes nothing");
		store.close();
	} finally { process.env = originalEnv; }
});

test("collect hands the supervisor the retained answer and a decide template, and decide with slices advances a thinker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "supervisor-thinker-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const tool = await harness(dir);
		const init = parsed(await tool.execute("init", { op: "init", story: "thinker-flow", graph: "build", task: "Add a README sentence", modelPolicy: { kind: "model", model: MODEL, reason: "fixture" } }, undefined, () => {}, {} as ExtensionContext));
		const runId: string = init.state.runId; const operationId: string = init.next.operations[0].id;
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const answerText = "Plan: one slice edits README.md to add the sentence.\n\nVERDICT: PASS\n";
		settledThinker(store, dir, runId, operationId, answerText);

		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(collected.error, undefined, JSON.stringify(collected));
		assert.equal(collected.settled, true);
		assert.equal(collected.answer, answerText, "the retained answer travels in the collect result");
		assert.deepEqual([collected.answerBytes, collected.answerTruncated], [Buffer.byteLength(answerText), false]);
		assert.equal(collected.verdict, "PASS", "the final VERDICT line is parsed even where the node does not use it");
		assert.deepEqual([collected.decide.op, collected.decide.runId, collected.decide.operationId, collected.decide.decision], ["decide", runId, operationId, "accepted | rejected"]);
		assert.equal("verdict" in collected.decide, false, "thinker_plan carries no verdict field");
		assert.deepEqual(Object.keys(collected.decide.payload.slices[0]), ["id", "name", "task", "ownedPaths"], "the build thinker template names slice fields including ownedPaths");
		assert.match(String(collected.note), /Derive payload\.slices from the retained answer/);

		const withoutSlices = parsed(await tool.execute("decide", { op: "decide", runId, operationId, decision: "accepted", reason: "answer is fine" }, undefined, () => {}, {} as ExtensionContext));
		assert.match(String(withoutSlices.error), /thinker result must include at least one slice/);
		assert.equal(store.getOperation(operationId).status, "running");

		const decided = parsed(await tool.execute("decide", { op: "decide", runId, operationId, decision: "accepted", reason: "the plan names one bounded edit", payload: { slices: [{ id: "readme", name: "README sentence", task: "Add the sentence to README.md", ownedPaths: ["README.md"] }] } }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(decided.error, undefined, JSON.stringify(decided));
		assert.equal(decided.state.currentNode, "implement", "an accepted thinker advances the build graph to implement");
		assert.equal(decided.state.status, "active");
		assert.equal(decided.next.operations.length, 1);
		assert.equal(decided.next.operations[0].node, "implement");
		assert.equal(decided.next.operations[0].task, "Add the sentence to README.md");
		assert.equal(store.getOperation(operationId).status, "completed");
		store.close();
	} finally { process.env = originalEnv; }
});

test("a thinker without a retained candidate is pointed at op=retry, not op=decide", async () => {
	const dir = mkdtempSync(join(tmpdir(), "supervisor-failed-")); dirs.push(dir);
	const originalEnv = { ...process.env };
	try {
		const tool = await harness(dir);
		const init = parsed(await tool.execute("init", { op: "init", story: "failed-flow", graph: "build", task: "Add a README sentence", modelPolicy: { kind: "model", model: MODEL, reason: "fixture" } }, undefined, () => {}, {} as ExtensionContext));
		const runId: string = init.state.runId; const operationId: string = init.next.operations[0].id;
		const store = new GraphStore({ dbPath: join(dir, "graph.db") });
		const operation = store.getOperation(operationId);
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "codex" });
		const attemptDir = join(dir, "private-run", "acpx", "thinker-1"); mkdirSync(join(attemptDir, "runtime-output"), { recursive: true });
		const cancelScript = join(attemptDir, "cancel-acpx.sh"); writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		const agentId = store.registerAgent({ runId, name: "thinker-1", node: operation.node, role: "thinker", transport: "headless", selectedModel: MODEL, modelAttempt: 0, acpAgent: "codex", acpxRecordId: identity.sessionName, acpxSessionId: identity.sessionName, acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: identity.agentFsSession, agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript, currentTask: operation.task });
		store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(runId).digest, agentId });
		store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "failed", exitCode: 1, error: "worker crashed" } });
		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(collected.error, undefined, JSON.stringify(collected));
		assert.equal(collected.answer, null);
		assert.match(String(collected.note), /op=retry/);
		store.close();
	} finally { process.env = originalEnv; }
});
