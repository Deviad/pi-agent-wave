import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { Database } from "../sqlite.ts";
import { closeRunTabs, type ExecResult } from "../herdr.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

/**
 * A Herdr whose `tab list` answers in the real CLI's shape, captured 2026-10-03:
 *   {"id":"cli:tab:list","result":{"tabs":[{"label":"run_a6a3…-op_1d4e…: implementer [auto] @ deepseek-v4.1-flash","tab_id":"w1:tC","workspace_id":"w1",…}],"type":"tab_list"}}
 * The suite never drives the operator's live Herdr; a live throwaway run proves the real CLI.
 */
function fakeHerdr(tabs: { tab_id: string; label: string }[]) {
	const calls: string[][] = [];
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		assert.equal(command, "herdr");
		calls.push(args);
		if (args[0] === "tab" && args[1] === "list") return { exitCode: 0, stdout: JSON.stringify({ id: "cli:tab:list", result: { tabs: tabs.map((tab) => ({ ...tab, workspace_id: "w1", agent_status: "unknown" })), type: "tab_list" } }), stderr: "" };
		if (args[0] === "tab" && args[1] === "close") {
			const index = tabs.findIndex((tab) => tab.tab_id === args[2]);
			if (index < 0) return { exitCode: 1, stdout: "", stderr: "tab not found" };
			tabs.splice(index, 1);
			return { exitCode: 0, stdout: "{}", stderr: "" };
		}
		return { exitCode: 1, stdout: "", stderr: `unmodelled ${args.join(" ")}` };
	};
	return { calls, exec, tabs };
}

const RUN = "run_11111111-2222-3333-4444-555555555555";

describe("closing a run's worker tabs", () => {
	test("closes every recorded tab that still carries this run's label, and nothing else", async () => {
		const herdr = fakeHerdr([
			{ tab_id: "w1:t1", label: "1" },
			{ tab_id: "w1:tB", label: `${RUN}-op_a: implementer [auto] @ m` },
			{ tab_id: "w1:tC", label: `${RUN}-op_b: reviewer [auto] @ m` },
			{ tab_id: "w1:tD", label: "run_99999999-0000-0000-0000-000000000000-op_z: implementer [auto] @ m" },
		]);
		const report = await closeRunTabs(RUN, [
			{ name: "a", transport: "herdr", tab_id: "w1:tB" },
			{ name: "b", transport: "herdr", tab_id: "w1:tC" },
			{ name: "gone", transport: "herdr", tab_id: "w1:tX" },
			{ name: "reused", transport: "herdr", tab_id: "w1:tD" },
			{ name: "headless", transport: "headless", tab_id: null },
		], herdr.exec);
		assert.deepEqual(report.map((item) => [item.agentName, item.outcome]), [["a", "closed"], ["b", "closed"], ["gone", "absent"], ["reused", "not-owned"]]);
		assert.deepEqual(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2]), ["w1:tB", "w1:tC"], "the closer is invoked for every recorded tab of this run");
		assert.deepEqual(herdr.tabs.map((tab) => tab.tab_id), ["w1:t1", "w1:tD"], "a tab the run did not create, or whose id Herdr reused, is untouched");
	});

	test("a run with no Herdr workers never calls Herdr, and an unreadable tab list closes nothing", async () => {
		const herdr = fakeHerdr([]);
		assert.deepEqual(await closeRunTabs(RUN, [{ name: "h", transport: "headless", tab_id: null }], herdr.exec), []);
		assert.deepEqual(herdr.calls, []);
		const report = await closeRunTabs(RUN, [{ name: "a", transport: "herdr", tab_id: "w1:tB" }], async () => ({ exitCode: 1, stdout: "", stderr: "herdr: socket unavailable" }));
		assert.deepEqual(report.map((item) => item.outcome), ["failed"]);
		assert.match(String(report[0].detail), /tab list unavailable: herdr: socket unavailable/);
	});
});

describe("tab cleanup through the tool", () => {
	test("collecting an orphan closes its tab with cleanup evidence; ending the run sweeps the rest", async () => {
		const root = mkdtempSync(join(tmpdir(), "tab-cleanup-tool-"));
		dirs.push(root);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			process.env.DELEGATE_GRAPH_DB = join(root, "graph.db");
			mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
			const model = "nosuchproviderxyz/dead-route";
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			const policy = { input: { kind: "model" as const, model, reason: "test" }, routes: ["thinker", "implementer", "reviewer", "tester", "auditor"].map((role) => ({ role, tier: "exact", chain: [model], thinking: "off", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null })) };
			const run = store.initRun("tabs", "build", "Plan the change", policy as never, undefined, "runtime-v1");
			const runId = run.runId;
			const operation = store.next(runId).operations[0];
			// The same-model budget is already spent (one-model chain), so the orphan's transient retry parks
			// the run by exhaustion and `resolve abort` is reachable.
			const seed = new Database(process.env.DELEGATE_GRAPH_DB);
			try { seed.query("UPDATE operations SET transient_attempts=3 WHERE id=?").run(operation.id); } finally { seed.close(); }
			const cancelScript = join(root, "run-private", "acpx", "dg-tab-worker", "cancel-acpx.sh");
			mkdirSync(join(root, "run-private", "acpx", "dg-tab-worker"), { recursive: true });
			writeFileSync(cancelScript, "#!/bin/sh\nexit 1\n");
			chmodSync(cancelScript, 0o700);
			const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 3, selectedModel: model, agent: selectAcpAgent(model) });
			const agentId = store.registerAgent({ runId, name: "dg-tab-worker", node: "thinker_plan", role: "thinker", transport: "herdr", herdrAgent: "dg-tab-worker", tabId: "w1:tB", herdrPaneId: "w1:pB", policyDigest: store.policy(runId).digest, selectedModel: model, modelAttempt: 0, currentTask: operation.task, acpAgent: identity.agent, acpxRecordId: "s", acpxSessionId: "s", acpxState: "alive", acpxAttemptKey: identity.attemptKey, agentFsSessionId: "s", agentFsDbPath: join(root, "delta.db"), acpxCancelScript: cancelScript });
			store.beginRuntimeAttempt({ identity, sessionId: "s", requestId: null, policyDigest: store.policy(runId).digest, agentId });
			// An earlier, already-settled worker of the same run whose tab is still open.
			store.registerAgent({ runId, name: "dg-old-worker", node: "thinker_plan", role: "thinker", transport: "herdr", herdrAgent: "dg-old-worker", tabId: "w1:tC", herdrPaneId: "w1:pC", policyDigest: store.policy(runId).digest, selectedModel: model, modelAttempt: 0, currentTask: operation.task });
			store.close();
			rmSync(join(root, "run-private"), { recursive: true });

			const herdr = fakeHerdr([{ tab_id: "w1:t1", label: "1" }, { tab_id: "w1:tB", label: `${runId}-${operation.id}: thinker [exact] @ dead-route` }, { tab_id: "w1:tC", label: `${runId}-${operation.id}: thinker [exact] @ dead-route` }]);
			const { default: extension } = await import(`../index.ts?tab-cleanup=${Date.now()}`);
			let tool: Record<string, any> = {};
			extension({
				registerCommand() {}, on() {}, sendUserMessage() {},
				registerTool(definition: Record<string, any>) { tool = definition; },
				exec: async (command: string, args: string[]) => {
					if (command === "herdr") { const result = await herdr.exec(command, args); return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, killed: false }; }
					const result = spawnSync(command, args, { encoding: "utf8" });
					return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
				},
			} as unknown as ExtensionAPI);
			const call = async (params: Record<string, unknown>) => parsed(await tool.execute("call", { runId, ...params }, undefined, () => {}, {} as ExtensionContext));

			const collected = await call({ op: "collect", operationId: operation.id });
			assert.equal(collected.error, undefined, JSON.stringify(collected));
			assert.deepEqual(collected.tabCleanup.map((item: Record<string, unknown>) => [item.tabId, item.outcome]), [["w1:tB", "closed"]]);
			assert.ok(existsSync(String(collected.cleanupEvidencePath)), "the reap's cleanup evidence is retained");
			assert.equal(JSON.parse(readFileSync(String(collected.cleanupEvidencePath), "utf8")).tabs[0].outcome, "closed");

			assert.equal((await call({ op: "retry", operationId: operation.id })).state.status, "awaiting_user");
			const aborted = await call({ op: "resolve", operationId: operation.id, decision: "abort" });
			assert.equal(aborted.state.status, "cancelled");
			assert.deepEqual(aborted.tabCleanup.map((item: Record<string, unknown>) => [item.tabId, item.outcome]), [["w1:tB", "absent"], ["w1:tC", "closed"]]);
			assert.ok(existsSync(String(aborted.tabCleanupEvidencePath)));
			assert.deepEqual(herdr.tabs.map((tab) => tab.tab_id), ["w1:t1"], "no tab of the ended run remains, and the operator's own tab is untouched");
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});
});
