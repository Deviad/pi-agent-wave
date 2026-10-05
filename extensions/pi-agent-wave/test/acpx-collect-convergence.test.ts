import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { retainedDiagnosticFromOutcome } from "../index.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";


const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

async function toolIn(dir: string, models: string[] = ["openai-codex/gpt-5.6-sol", "alibaba/glm-5.2-fallback"], invocations?: { command: string; args: string[] }[]): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models, thinking: "off", session: true } },
		roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
	}));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?collect-convergence=${Date.now()}`);
	let tool: Record<string, any>;
	const fakePi = {
		registerCommand() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		on() {},
		exec: async (command: string, args: string[]) => {
			invocations?.push({ command, args: [...args] });
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	extension(fakePi);
	return { get tool() { return tool; } };
}

/** Registers the planning operation as running on a headless worker whose launcher directory is already on disk. */
async function startDeadAttempt(dir: string, options: { cancelExit: number; state: "alive" | "no-session" }, invocations?: { command: string; args: string[] }[]): Promise<{ tool: Record<string, any>; runId: string; operationId: string; privateRunDir: string; diagnosticsPath: string }> {
	const { tool } = await toolIn(dir, undefined, invocations);
	const init = parsed(await tool.execute("init", { op: "init", story: "dead-attempt", graph: "build", task: "Plan the wave" }, undefined, () => {}, {} as ExtensionContext));
	if (init.error) throw new Error(`init failed: ${init.error}`);
	const operation = init.next.operations[0];
	const privateRunDir = join(dir, "run-private");
	const attemptDir = join(privateRunDir, "acpx", "dg-dead-thinker");
	mkdirSync(attemptDir, { recursive: true });
	const diagnosticsPath = join(privateRunDir, `failure-${operation.id}.json`);
	writeFileSync(diagnosticsPath, `${JSON.stringify({ schemaVersion: 1, terminalKind: "failed", processExitCode: 1 })}\n`, { mode: 0o600 });
	const cancelScript = join(attemptDir, "cancel-acpx.sh");
	writeFileSync(cancelScript, `#!/bin/sh\nprintf 'worker session already gone\\n' >&2\nexit ${options.cancelExit}\n`, { mode: 0o700 });
	chmodSync(cancelScript, 0o700);
	// Register the attempt the way dispatch does, bound to a launcher directory whose worker is already gone.
	const selectedModel: string = operation.route.chain[0];
	const identity = createHeadlessAcpxAttemptIdentity({ runId: init.state.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel, agent: selectAcpAgent(selectedModel) });
	const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
	try {
		const agentId = store.registerAgent({ runId: init.state.runId, name: "dg-dead-thinker", node: "thinker_plan", role: "thinker", transport: "headless", policyDigest: init.next.policy.digest, selectedModel, modelAttempt: 0, currentTask: operation.task, acpAgent: identity.agent, acpxRecordId: "dg-dead-session", acpxSessionId: "dg-dead-session", acpxState: options.state, acpxAttemptKey: identity.attemptKey, agentFsSessionId: "dg-dead-session", agentFsDbPath: join(attemptDir, "delta.db"), acpxCancelScript: cancelScript });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-dead-session", requestId: null, policyDigest: init.next.policy.digest, agentId });
	} finally { store.close(); }
	return { tool, runId: init.state.runId, operationId: operation.id, privateRunDir, diagnosticsPath };
}

describe("provider preflight at dispatch", () => {
	for (const graph of ["build", "operations"] as const) {
	test(`forwards ${graph} access mode and records an unauthenticated route block`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "preflight-block-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const { tool } = await toolIn(dir, ["nosuchproviderxyz/dead-route", "alibaba/live-route"], invocations);
			const commands = graph === "operations" ? [{ id: "access", name: "access", command: { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir }, ownedPaths: [join(dir, "result.txt")] }] : undefined;
			const init = parsed(await tool.execute("init", { op: "init", story: "preflight-block", graph, task: "Plan the wave", commands }, undefined, () => {}, { cwd: dir } as ExtensionContext));
			assert.equal(init.error, undefined, `init must succeed, got ${JSON.stringify(init)}`);
			const operation = init.next.operations[0];
			const blocked = parsed(await tool.execute("dispatch", { op: "dispatch", runId: init.state.runId, operationId: operation.id, transport: "headless" }, undefined, () => {}, { cwd: dir } as ExtensionContext));
			assert.equal(blocked.error, undefined, `dispatch must converge on a named block, got ${JSON.stringify(blocked)}`);
			assert.equal(blocked.dispatched, false);
			assert.equal(blocked.blocked, "preflight");
			assert.match(String(blocked.reason), /worker preflight:.*nosuchproviderxyz/);
			assert.equal(blocked.operation.retry_reason, "worker-credential-preflight");
			assert.equal(blocked.operation.model_attempt, 0, "the first block spends one same-model attempt before the chain advances");
			const start = invocations.find((call) => call.args.includes("--owned-paths-json"));
			assert.ok(start, "the actual private launcher invocation must be observed");
			const modeIndex = start.args.indexOf("--access-mode");
			assert.deepEqual(start.args.slice(modeIndex, modeIndex + 2), ["--access-mode", graph === "build" ? "read-only" : "owned-write"]);
			// `init` creates the run directory before the launch, and no collect will ever run for a blocked
			// dispatch, so the block must remove the directory it created rather than leave it to accumulate.
			const runDir = start.args[start.args.indexOf("start") + 1];
			assert.ok(String(runDir).includes("delegate-graph-herdr-"), `expected a run directory, got ${runDir}`);
			assert.equal(existsSync(String(runDir)), false, "a blocked dispatch must leave no run directory behind");
		} finally {
			Object.assign(process.env, saved);
		}
	});
	}
});

describe("terminated attempt convergence", () => {
	test("collect records a failed attempt instead of throwing forever", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collect-converge-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" });
			const collected = parsed(await started.tool.execute("collect", { op: "collect", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(collected.error, undefined, `collect must converge, got ${JSON.stringify(collected)}`);
			assert.equal(collected.settled, true);
			assert.equal(collected.attempt.processState, "failed");
			assert.equal(basename(String(collected.diagnosticsPath)), basename(started.diagnosticsPath), "the retained diagnostic bundle must be named to the supervisor");
			assert.ok(String(collected.diagnosticsPath).includes(join("evidence", started.runId)), "the settled bundle must name the durable copy, not the removed run directory");
			assert.equal(existsSync(String(collected.diagnosticsPath)), true, "the named bundle must still exist after the run directory is removed");
			assert.equal(existsSync(started.privateRunDir), false, "a settled operation leaves no run directory");
			assert.ok(String(collected.reason).length > 0, "the launcher reason must be reported");
			assert.match(String(collected.attempt.outcome.error), new RegExp(`retained worker diagnostics: ${String(collected.diagnosticsPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the settled outcome must name the retained bundle it points at, not a path that is about to be deleted");
			// The fact is settled; the operation stays on its failed attempt until the runtime replaces it.
			assert.equal(collected.operation.status, "running");
			const retried = parsed(await started.tool.execute("retry", { op: "retry", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(retried.error, undefined, `retry must classify the dead worker, got ${JSON.stringify(retried)}`);
			assert.notEqual(retried.operation.status, "running", "a dead worker must never stay dispatchable as running");
			const next = parsed(await started.tool.execute("next", { op: "next", runId: started.runId }, undefined, () => {}, {} as ExtensionContext));
			assert.ok(!next.operations.some((candidate: Record<string, unknown>) => candidate.id === started.operationId && candidate.status === "running"), "a dead worker must never stay dispatchable as running");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("cancelling an attempt whose worker is already dead still records the cancellation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cancel-dead-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "no-session" });
			const cancelled = parsed(await started.tool.execute("cancel", { op: "cancel", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(cancelled.error, undefined, `cancelling a dead attempt must converge, got ${JSON.stringify(cancelled)}`);
			assert.equal(cancelled.operation.status, "cancelled");
			assert.equal(cancelled.state.status, "cancelled");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("a live worker whose cancellation genuinely fails is refused without a state change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cancel-alive-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" });
			let refused: Record<string, any> | undefined;
			try {
				refused = parsed(await started.tool.execute("cancel", { op: "cancel", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			} catch (error) { refused = { error: String((error as Error).message) }; }
			assert.match(String(refused.error), /worker session already gone/, "a live worker with a failing cancel launcher must refuse");
			const after = parsed(await started.tool.execute("next", { op: "next", runId: started.runId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(after.operations.find((candidate: Record<string, unknown>) => candidate.id === started.operationId)?.status, "running", "a refused cancellation must leave the operation untouched for the supervisor to resolve");

		} finally {
			Object.assign(process.env, saved);
		}
	});

	/** The shape run_315dce09 (2026-09-20) was left in: the launcher's own timeout tore the attempt down with nobody collecting. */
	function tearDownOnDisk(started: { privateRunDir: string; diagnosticsPath: string }): void {
		writeFileSync(started.diagnosticsPath, `${JSON.stringify({ schemaVersion: 1, reason: "attempt aborted before cleanup", workerResult: {}, processExitCode: null })}\n`, { mode: 0o600 });
		rmSync(join(started.privateRunDir, "acpx", "dg-dead-thinker"), { recursive: true, force: true });
	}

	test("collect settles from retained teardown evidence without waiting", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collect-torn-down-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" }, invocations);
			tearDownOnDisk(started);
			assert.equal(existsSync(join(started.privateRunDir, "acpx", "dg-dead-thinker")), false);
			const collected = parsed(await started.tool.execute("collect", { op: "collect", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(collected.error, undefined, `collect must settle from the bundle, got ${JSON.stringify(collected)}`);
			assert.equal(collected.settled, true);
			assert.equal(collected.attempt.processState, "failed");
			assert.equal(collected.reason, "attempt aborted before cleanup", "the launcher's recorded reason is the settled reason");
			assert.equal(basename(String(collected.diagnosticsPath)), basename(started.diagnosticsPath));
			assert.equal(existsSync(started.privateRunDir), false, "a torn-down attempt's directory is removed once it settles");
			assert.equal(invocations.some((call) => call.args.some((arg) => arg.endsWith("delegate.ts"))), false, "no wait may be spawned for a torn-down attempt");
			const again = parsed(await started.tool.execute("collect", { op: "collect", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(again.error, undefined, `a repeated collect must be a no-op, got ${JSON.stringify(again)}`);
			assert.equal(again.attempt.processState, "failed");
			// A repeated collect settles nothing, so it learns no path of its own; it must still name the
			// bundle the first one retained rather than answer as though no diagnostic existed.
			assert.equal(again.diagnosticsPath, collected.diagnosticsPath, "a repeated collect names the same retained bundle");
			assert.equal(existsSync(String(again.diagnosticsPath)), true, "and that bundle still exists");
			assert.ok(String(again.diagnosticsPath).includes(join("evidence", started.runId)), "and it is the store's own copy");
			const retried = parsed(await started.tool.execute("retry", { op: "retry", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(retried.error, undefined, `retry must be accepted after settlement, got ${JSON.stringify(retried)}`);
			assert.notEqual(retried.operation.status, "running");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("a failure bundle beside a live attempt directory is not a teardown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "collect-bundle-live-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" }, invocations);
			// Bundle present (startDeadAttempt writes one) and the attempt directory still on disk: the existing wait path must run.
			const collected = parsed(await started.tool.execute("collect", { op: "collect", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(collected.error, undefined, JSON.stringify(collected));
			assert.equal(invocations.some((call) => call.args.some((arg) => arg.endsWith("delegate.ts"))), true, "a live attempt directory keeps the wait path");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("cancel converges on a torn-down attempt and closes the run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cancel-torn-down-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			const started = await startDeadAttempt(dir, { cancelExit: 1, state: "alive" });
			tearDownOnDisk(started);
			const cancelled = parsed(await started.tool.execute("cancel", { op: "cancel", runId: started.runId, operationId: started.operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(cancelled.error, undefined, `cancel must converge once the launcher is gone, got ${JSON.stringify(cancelled)}`);
			assert.equal(cancelled.operation.status, "cancelled");
			assert.equal(cancelled.state.status, "cancelled");
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("a worker's own output cannot steer the diagnostic path a repeated collect reports", () => {
		// The settled error is the worker's stderr followed by our own line. A worker that printed a
		// `retained worker diagnostics:` line of its own would otherwise be matched first and name any
		// file it liked. Worker output is data here, never an instruction about which path to report.
		const dir = mkdtempSync(join(tmpdir(), "collect-hostile-"));
		dirs.push(dir);
		const dbPath = join(dir, "graph.db");
		const store = new GraphStore({ dbPath });
		try {
			const real = store.retainRunEvidence("run_x", "failure-op-1.json", "{}\n");
			const outside = join(dir, "outside.json");
			writeFileSync(outside, "{}\n", { mode: 0o600 });
			const decoy = (text: string) => ({ attemptKey: "k", runId: "run_x", operationId: "op-1", agentId: null, processState: "failed", acceptance: "pending", supersededAt: null, candidate: null, outcome: { kind: "failed", exitCode: null, error: text } });

			// The honest shape: our line is last, and it points inside the store's evidence home.
			assert.equal(retainedDiagnosticFromOutcome(store, decoy(`worker wait failed\nretained worker diagnostics: ${real}`) as never), real);

			// A worker line that arrives first must lose to ours, and an existing file outside the
			// evidence home must never be reported even when it is the only candidate.
			assert.equal(retainedDiagnosticFromOutcome(store, decoy(`retained worker diagnostics: /etc/hosts\nretained worker diagnostics: ${real}`) as never), real, "our trailing line wins");
			assert.equal(retainedDiagnosticFromOutcome(store, decoy("retained worker diagnostics: /etc/hosts") as never), null, "a path outside the evidence home is refused");
			assert.equal(retainedDiagnosticFromOutcome(store, decoy(`retained worker diagnostics: ${outside}`) as never), null, "even an existing file outside the evidence home is refused");
			assert.equal(retainedDiagnosticFromOutcome(store, decoy(`retained worker diagnostics: ${join(real, "..", "..", "..", "etc", "hosts")}`) as never), null, "a traversal out of the evidence home is refused");
		} finally { store.close(); }
	});
});
