import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReport, validateReport } from "../scripts/report-audit.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claims() {
	return [{ statement: "The source command completed", evidence: [{ kind: "command", source: "node search.mjs", detail: "exit 0" }], verification: "verified" }];
}

function execution(root: string) {
	return {
		argv: ["node", "/opt/search.mjs", "--source", "linkedin"],
		exitCode: 0,
		source: "linkedin",
		runId: "linkedin-ie-1",
		checkpointPath: join(root, "checkpoint.json"),
		checkpointStatus: "completed",
		resultsPath: join(root, "results.json"),
		candidateCount: 3,
		sourceStatus: "completed",
	};
}

describe("operational search report", () => {
	test("accepts typed execution proof and rejects preparatory-only DONE", () => {
		const root = "/tmp/run";
		assert.equal(validateReport({ schemaVersion: 1, verdict: "DONE", claims: claims(), execution: execution(root) }, "source_search").valid, true);
		const rejected = validateReport({ schemaVersion: 1, verdict: "DONE", claims: claims() }, "source_search");
		assert.equal(rejected.valid, false);
		assert.equal(rejected.errors.some((error) => error.code === "EXECUTION_REQUIRED"), true);
		assert.equal(validateReport({ schemaVersion: 1, verdict: "DONE", claims: claims() }, "search").valid, true);
	});

	test("requires resumability for budget exhaustion and blocker evidence", () => {
		const root = "/tmp/run";
		const budget = { ...execution(root), exitCode: 3, checkpointStatus: "budget-exhausted", sourceStatus: "budget-exhausted", candidateCount: 0 };
		assert.equal(validateReport({ schemaVersion: 1, verdict: "BLOCKED", claims: claims(), execution: budget }, "source_search").valid, false);
		assert.equal(validateReport({ schemaVersion: 1, verdict: "BLOCKED", claims: claims(), execution: { ...budget, blocker: "linkedin budget exhausted", resumeArgv: ["node", "/opt/search.mjs", "--resume", "linkedin-ie-1"] } }, "source_search").valid, true);
		assert.equal(validateReport({ schemaVersion: 1, verdict: "DONE", claims: claims(), execution: { ...execution(root), exitCode: 5, sourceStatus: "preflight-failed" } }, "source_search").valid, false);
	});

	test("accepts a completed zero-candidate checkpoint without a results artifact", async () => {
		const privateRoot = mkdtempSync(join(tmpdir(), "operational-empty-report-"));
		dirs.push(privateRoot);
		const ownedRoot = join(privateRoot, "run");
		mkdirSync(ownedRoot);
		writeFileSync(join(ownedRoot, "checkpoint.json"), JSON.stringify({ jobsSaved: 0 }), { mode: 0o600 });
		const report = join(privateRoot, "report.json");
		const empty = execution(ownedRoot);
		delete (empty as Partial<typeof empty>).resultsPath;
		empty.candidateCount = 0;
		writeFileSync(report, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: claims(), execution: empty }), { mode: 0o600 });
		assert.equal((await auditReport(report, { node: "source_search", privateRoot, ownedRoots: [ownedRoot] })).valid, true);
	});

	test("requires completed artifacts to exist under declared writable roots", async () => {
		const privateRoot = mkdtempSync(join(tmpdir(), "operational-report-"));
		dirs.push(privateRoot);
		const ownedRoot = join(privateRoot, "run");
		mkdirSync(ownedRoot);
		writeFileSync(join(ownedRoot, "checkpoint.json"), "{}", { mode: 0o600 });
		writeFileSync(join(ownedRoot, "results.json"), "[]", { mode: 0o600 });
		const report = join(privateRoot, "report.json");
		writeFileSync(report, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: claims(), execution: execution(ownedRoot) }), { mode: 0o600 });
		assert.equal((await auditReport(report, { node: "source_search", privateRoot, ownedRoots: [ownedRoot] })).valid, true);
		const outside = join(privateRoot, "outside.json");
		writeFileSync(outside, "{}", { mode: 0o600 });
		writeFileSync(report, JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: claims(), execution: { ...execution(ownedRoot), resultsPath: outside } }), { mode: 0o600 });
		const rejected = await auditReport(report, { node: "source_search", privateRoot, ownedRoots: [ownedRoot] });
		assert.equal(rejected.valid, false);
		assert.equal(rejected.errors.some((error) => error.code === "EXECUTION_PATH_OWNERSHIP"), true);
	});
});
