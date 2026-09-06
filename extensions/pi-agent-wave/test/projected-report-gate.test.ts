import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProjectedSemanticReport, projectedAttemptFailure } from "../lib/projected-report.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

/** Loads the extension against an isolated Pi home and returns its delegate_graph tool plus the recording executor. */
async function harness(dir: string, calls: string[][]): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models: ["openai-codex/gpt-5.6-sol", "alibaba/glm-5.2-fallback"], thinking: "off", session: true } },
		roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
	}));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?projected-gate=${Date.now()}`);
	let tool: Record<string, any>;
	const fakePi = {
		registerCommand() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		exec: async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	extension(fakePi);
	return { get tool() { return tool; } };
}

function projectedReport(node: string, verdict: string) {
	return {
		schemaVersion: 1,
		verdict,
		claims: [{
			statement: `Supervisor projection: Pi ACPX session dg-projection-test exited 0 with structured end_turn; no semantic task claim is inferred.`,
			evidence: [{ kind: "command", source: "/private/tmp/worker.stdout.ndjson", detail: "ACPX process exit 0 and structured terminal kind completed" }],
			verification: "verified",
		}],
	};
}

function authoredReport() {
	return {
		schemaVersion: 1,
		verdict: "READY",
		claims: [{
			statement: "The caller inventory was produced by grepping every installed entry point",
			evidence: [{ kind: "command", source: "grep -rn batch-fetch-jds skills", detail: "14 call sites recorded in caller-inventory.md" }],
			verification: "verified",
		}],
	};
}

function writeReport(dir: string, name: string, value: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

describe("projected report predicate", () => {
	test("flags projections only on semantic nodes and leaves authored reports alone", () => {
		assert.equal(isProjectedSemanticReport(projectedReport("thinker_plan", "READY"), "thinker_plan"), true);
		assert.equal(isProjectedSemanticReport(authoredReport(), "thinker_plan"), false);
		assert.equal(isProjectedSemanticReport(projectedReport("implement", "DONE"), "implement"), true);
		assert.equal(isProjectedSemanticReport(projectedReport("source_search", "DONE"), "source_search"), false, "source search proves execution, not semantics");
		assert.match(String(projectedAttemptFailure("review", projectedReport("review", "PASS")) ?? ""), /report-missing/);
		assert.equal(projectedAttemptFailure("audit", authoredReport()), null);
	});
});

describe("projected report gate", () => {
	test("rejects a supervisor projection as the verdict of a semantic planning operation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "projected-gate-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		const calls: string[][] = [];
		try {
			const { tool } = await harness(dir, calls);
			const init = parsed(await tool.execute("init", { op: "init", story: "projection-gate", graph: "build", task: "Plan the wave" }, undefined, () => {}, {} as ExtensionContext));
			const operation = init.next.operations[0];
			assert.equal(operation.node, "thinker_plan");
			const reportPath = writeReport(dir, "report-projected.json", projectedReport("thinker_plan", "READY"));

			const rejected = parsed(await tool.execute("completed", { op: "record", runId: init.state.runId, operationId: operation.id, status: "completed", reportPath, verdict: "READY" }, undefined, () => {}, {} as ExtensionContext));
			assert.match(String(rejected.error), /projected execution-only report cannot complete the semantic thinker_plan/);

			const next = parsed(await tool.execute("next", { op: "next", runId: init.state.runId }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(next.state.currentNode, "thinker_plan", "the graph must not advance past a projected plan");
			assert.equal(next.operations[0].id, operation.id);
		} finally {
			Object.assign(process.env, saved);
		}
	});

	test("still accepts a report the worker authored itself", async () => {
		const dir = mkdtempSync(join(tmpdir(), "projected-gate-ok-"));
		dirs.push(dir);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdrEnv: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		const calls: string[][] = [];
		try {
			const { tool } = await harness(dir, calls);
			const init = parsed(await tool.execute("init", { op: "init", story: "authored-report", graph: "build", task: "Plan the wave" }, undefined, () => {}, {} as ExtensionContext));
			const operation = init.next.operations[0];
			const reportPath = writeReport(dir, "report-authored.json", authoredReport());
			const accepted = parsed(await tool.execute("completed", { op: "record", runId: init.state.runId, operationId: operation.id, status: "completed", reportPath, verdict: "READY" }, undefined, () => {}, {} as ExtensionContext));
			assert.doesNotMatch(String(accepted.error ?? ""), /projected execution-only report/, "an authored report must not hit the projection gate");
		} finally {
			Object.assign(process.env, saved);
		}
	});
});
