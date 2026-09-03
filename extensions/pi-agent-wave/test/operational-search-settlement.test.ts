import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLedgerEntry } from "../scripts/ledger.ts";
import { GraphStore } from "../store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "operational-settlement-"));
	dirs.push(dir);
	return { dir, store: new GraphStore({ dbPath: join(dir, "graph.db"), random: () => 0 }) };
}

describe("operational search settlement", () => {
	test("settles the superseded agent before returning a retry", () => {
		const { store } = fixture();
		const state = store.initRun("retry", "operations", "Run", undefined, [{ id: "one", name: "One", command: { executable: "node", args: ["search.mjs"], cwd: "/tmp" }, ownedPaths: ["/tmp/one.json"] }]);
		const operation = store.next(state.runId).operations[0]!;
		const agentId = store.registerAgent({ runId: state.runId, name: "searcher-1", node: "source_search", role: "searcher", transport: "herdr", herdrAgent: "agent-1", tabId: "tab-1", herdrPaneId: "pane-1", currentTask: operation.task });
		store.record({ runId: state.runId, operationId: operation.id, status: "running", agentId, transport: "herdr" });
		const result = store.record({ runId: state.runId, operationId: operation.id, status: "failed", agentId, error: "provider unavailable: HTTP 429" });
		assert.ok(result.retry);
		assert.equal(store.agents(state.runId)[0]?.status, "failed");
		store.close();
	});

	test("writes one idempotent ledger entry per operation", async () => {
		const { dir } = fixture();
		const report = join(dir, "report.json");
		writeFileSync(report, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: [{ statement: "completed", evidence: [{ kind: "command", source: "node search.mjs", detail: "exit 0" }], verification: "verified" }] }), { mode: 0o600 });
		const options = { story: "story", topic: "linkedin", operationId: "op-1", runId: "run-1", tier: "tools", model: "provider/model", outcome: "accepted" as const, task: "Search", reportPath: report, base: join(dir, "output") };
		const first = await writeLedgerEntry(options);
		const second = await writeLedgerEntry(options);
		assert.equal(second, first);
		assert.equal(readdirSync(join(dir, "output", "story", "delegate-ledger")).filter((name) => name.endsWith(".json")).length, 1);
		assert.equal(JSON.parse(readFileSync(first, "utf8")).operationId, "op-1");
	});

	test("records a failed missing report with diagnostics when explicitly authorized", async () => {
		const { dir } = fixture();
		const path = await writeLedgerEntry({ story: "story", topic: "linkedin", operationId: "op-2", runId: "run-1", tier: "tools", model: "provider/model", outcome: "failed", task: "Search", reportPath: join(dir, "missing.json"), base: join(dir, "output"), allowInvalidReport: true, rejectionDiagnostics: [{ code: "REPORT_UNAVAILABLE", path: "$", message: "worker exited without report" }] });
		const entry = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(entry.outcome, "failed");
		assert.equal(entry.rejectedCandidate.diagnostics[0].code, "REPORT_UNAVAILABLE");
		const recoveredReport = join(dir, "recovered-report.json");
		writeFileSync(recoveredReport, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: [{ statement: "recovered completion", evidence: [{ kind: "command", source: "node search.mjs", detail: "exit 0" }], verification: "verified" }] }), { mode: 0o600 });
		const recoveredPath = await writeLedgerEntry({ story: "story", topic: "linkedin", operationId: "op-2", runId: "run-1", tier: "tools", model: "provider/model", outcome: "accepted", task: "Search", reportPath: recoveredReport, base: join(dir, "output") });
		assert.equal(recoveredPath, path);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).outcome, "accepted");
		assert.equal(readdirSync(join(dir, "output", "story", "delegate-ledger")).filter((name) => name.endsWith(".json")).length, 1);
	});
});
