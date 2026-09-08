/** Settlement for an operation whose worker was never registered. */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Database } from "../sqlite.ts";
import { classifyFailure, selectModelFallback } from "../retry.ts";

const dirs: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	process.env = { ...originalEnv };
});

function parsed(result: unknown): Record<string, any> {
	return JSON.parse((result as { content: { text: string }[] }).content[0].text);
}

const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

async function toolIn(dir: string): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(
		join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"),
		JSON.stringify({
			default_tier: "tools",
			tiers: { tools: { models: ["openai-codex/gpt-5.6-sol", "alibaba/glm-5.2-fallback"], thinking: "off", session: true } },
			roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
		}),
	);
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?unlaunched=${Date.now()}`);
	let tool: Record<string, any>;
	const fakePi = {
		registerCommand() {},
		registerTool(definition: Record<string, any>) {
			tool = definition;
		},
		exec: async (command: string, args: string[]) => {
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	extension(fakePi);
	return tool;
}

/** Initialises a run and returns its first operation, which has no registered worker because nothing was dispatched. */
async function unlaunched(dir: string): Promise<{ tool: Record<string, any>; runId: string; operationId: string; dbPath: string }> {
	const tool = await toolIn(dir);
	const init = parsed(await tool.execute("init", { op: "init", story: "unlaunched-settlement", graph: "research", task: "Read the settlement code" }, undefined, () => {}, {} as ExtensionContext));
	assert.equal(init.error, undefined, `init failed: ${JSON.stringify(init)}`);
	const operation = init.next.operations[0];
	assert.ok(operation, `init returned no operations: ${JSON.stringify(init)}`);
	assert.equal(operation.agent_id ?? null, null, "the fixture operation must have no registered worker");
	return { tool, runId: init.state.runId, operationId: operation.id, dbPath: join(dir, "graph.db") };
}

function operationRow(dbPath: string, operationId: string): Record<string, any> {
	const db = new Database(dbPath);
	try {
		return db.query<Record<string, any>, [string]>("SELECT status, finished_at, classifier_reason, last_error, model_attempt, transient_attempts FROM operations WHERE id=?").get(operationId) as Record<string, any>;
	} finally {
		db.close();
	}
}

function runStatus(dbPath: string, runId: string): string {
	const db = new Database(dbPath);
	try {
		return (db.query<{ status: string }, [string]>("SELECT status FROM state WHERE run_id=?").get(runId) as { status: string }).status;
	} finally {
		db.close();
	}
}

describe("settlement for an operation whose worker never started", () => {
	test("collect settles a never-dispatched operation and retains a diagnostic", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-collect-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(collected.error, undefined, `collect must settle an unlaunched operation, got ${JSON.stringify(collected)}`);
		const row = operationRow(dbPath, operationId);
		assert.equal(row.status, "failed", "the operation must leave the active set");
		assert.ok(row.finished_at, "the settled operation must carry finished_at");
		assert.match(String(row.last_error), /never started/, "the recorded error must name the actual cause");
		const retained = String(row.last_error).match(/retained diagnostics: (.+)$/)?.[1];
		assert.ok(retained && existsSync(retained), `the settlement must name a retained diagnostic file: ${JSON.stringify(row)}`);
		assert.match(readFileSync(retained, "utf8"), /never started/i, "the diagnostic must say the authorized command never started");
		assert.notEqual(runStatus(dbPath, runId), "active", "the run must become decidable");
	});

	test("a repeated collect is a no-op instead of an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-repeat-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const first = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(first.error, undefined, String(first));
		const settled = operationRow(dbPath, operationId);
		const second = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(second.error, undefined, `a second collect must be a no-op, got ${JSON.stringify(second)}`);
		assert.deepEqual(operationRow(dbPath, operationId), settled, "a no-op must not rewrite the settled row");
	});

	test("cancel abandons a never-dispatched operation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-cancel-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const cancelled = parsed(await tool.execute("cancel", { op: "cancel", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(cancelled.error, undefined, `cancel must settle an unlaunched operation, got ${JSON.stringify(cancelled)}`);
		const row = operationRow(dbPath, operationId);
		assert.equal(row.status, "cancelled");
		assert.ok(row.finished_at);
		assert.equal(runStatus(dbPath, runId), "cancelled", "the run must leave the active set");
		const again = parsed(await tool.execute("cancel", { op: "cancel", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(again.error, undefined, `a repeated cancel must be a no-op, got ${JSON.stringify(again)}`);
	});

	test("the settlement needs no presentation adapter", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-herdr-"));
		dirs.push(dir);
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "workspace";
		process.env.HERDR_TAB_ID = "tab";
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(collected.error, undefined, `collect must settle with a presentation adapter present, got ${JSON.stringify(collected)}`);
		assert.equal(operationRow(dbPath, operationId).status, "failed");
	});

	test("a settled run stays decidable for the operator", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-resolve-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const collected = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(collected.error, undefined, String(collected));
		const retry = parsed(await tool.execute("retry", { op: "resolve", runId, operationId, decision: "retry" }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(retry.error, undefined, `a settled operation must be reopenable: ${JSON.stringify(retry)}`);
		const reopened = operationRow(dbPath, operationId);
		assert.equal(reopened.status, "pending", "an operator-approved retry returns the operation to the dispatchable set");
		assert.equal(reopened.finished_at, null);
		assert.equal(runStatus(dbPath, runId), "active");
	});

	test("a settled run can be abandoned outright", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-abort-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext);
		const abort = parsed(await tool.execute("abort", { op: "resolve", runId, operationId, decision: "abort" }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(abort.error, undefined, `a settled operation must be aborable: ${JSON.stringify(abort)}`);
		assert.equal(runStatus(dbPath, runId), "cancelled", "abort ends the run");
		assert.equal(operationRow(dbPath, operationId).status, "cancelled");
	});

	test("a run the caller got wrong is refused without writing anywhere", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-badrun-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		// Two failures of the same kind: an unknown id, and one that walks out of the failures
		// directory. Both must stay refusals, because the second one used to write a real file.
		const escapeTarget = resolve(dirname(dir), `escape-${process.pid}-${Date.now()}`);
		const escaping = `../../escape-${process.pid}-${Date.now()}`;
		assert.ok(escaping.includes(".."), "the fixture must actually attempt to escape");
		for (const bad of ["run_does-not-exist", escaping]) {
			const refused = parsed(await tool.execute("collect", { op: "collect", runId: bad, operationId }, undefined, () => {}, {} as ExtensionContext));
			assert.match(String(refused.error), /unknown run/, `a wrong run id must be refused: ${JSON.stringify(refused)}`);
		}
		assert.equal(existsSync(escapeTarget), false, `a refusing call must not create ${escapeTarget}`);
		assert.equal(existsSync(join(dirname(dbPath), "failures", "run_does-not-exist")), false, "a refusal must not leave a failures directory behind");
		assert.equal(operationRow(dbPath, operationId).status, "pending", "a refused collect leaves the operation untouched");
		const good = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(good.error, undefined, `refusals must not break the real path: ${JSON.stringify(good)}`);
	});

	test("an operation cannot be settled under a foreign run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-foreign-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		const other = parsed(await tool.execute("init", { op: "init", story: "other-story", graph: "research", task: "Provide a second run to point at" }, undefined, () => {}, {} as ExtensionContext));
		assert.equal(other.error, undefined, `the second run must initialise: ${JSON.stringify(other)}`);
		const foreign = parsed(await tool.execute("cancel", { op: "cancel", runId: other.state.runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.match(String(foreign.error), /does not belong to run/, `cross-run settlement must be refused: ${JSON.stringify(foreign)}`);
		assert.equal(existsSync(join(dirname(dbPath), "failures", other.state.runId)), false, "a refused cross-run call must not write into the other run");
		assert.equal(operationRow(dbPath, operationId).status, "pending");
		assert.equal(runStatus(dbPath, runId), "active", "a foreign run must not end the run the operation belongs to");
	});

	test("a run that already left active is refused without writing anywhere", async () => {
		const dir = mkdtempSync(join(tmpdir(), "unlaunched-parked-"));
		dirs.push(dir);
		const { tool, runId, operationId, dbPath } = await unlaunched(dir);
		// Seeded fixture state: a parked run whose operation is still pending. Collect must refuse
		// and write nothing, because a diagnostic nobody can record is just litter.
		const db = new Database(dbPath);
		try {
			db.query("UPDATE runs SET status=? WHERE id=?").run("awaiting_user", runId);
		} finally {
			db.close();
		}
		const parked = parsed(await tool.execute("collect", { op: "collect", runId, operationId }, undefined, () => {}, {} as ExtensionContext));
		assert.match(String(parked.error), /is awaiting_user; resolve it/, `a parked run must be refused, got ${JSON.stringify(parked)}`);
		assert.equal(existsSync(join(dirname(dbPath), "failures", runId)), false, "a refusal must not write a diagnostic");
		assert.equal(operationRow(dbPath, operationId).status, "pending");
	});

	test("a command that never started is not a transient failure", () => {
		const reason = "no worker was registered for operation op_unlaunched: the authorized command never started";
		assert.equal(classifyFailure(reason).kind, "permanent", JSON.stringify(classifyFailure(reason)));
		assert.equal(selectModelFallback(["openai-codex/gpt-5.6-sol", "alibaba/glm-5.2-fallback"], 0, reason).advance, false, "an unlaunched command must not advance the frozen chain");
		for (const transient of ["HTTP 429 Too Many Requests", "HTTP 503 Service Unavailable", "quota exceeded", "ETIMEDOUT", "connection reset by peer", "timed out after 60s"]) {
			assert.equal(classifyFailure(transient).kind, "transient", `${transient} must stay transient`);
		}
	});
});
