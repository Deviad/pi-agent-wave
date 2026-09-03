import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateReport } from "../scripts/report-audit.ts";

const home = process.env.HOME ?? "";
const script = join(home, ".pi", "agent", "skills", "job-hunter", "scripts", "jh-search.mjs");
const canonicalHome = process.env.JOBHUNTER_HOME ?? join(home, ".job-hunter");
const canonicalDb = join(canonicalHome, "jobhunter.sqlite");
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("real job-hunter operational search", () => {
	test("installed wrapper exposes the isolated database and resumable bounded contract", () => {
		const result = spawnSync("node", [script, "--help"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		for (const text of ["--db <path>", "--budget-minutes <n>", "--resume <run-id>", "--json", "3 budget-exhausted", "4 blocked", "5 preflight-failed"]) assert.match(result.stdout, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	test("runs a bounded real LinkedIn slice without changing the canonical database", { skip: process.env.PI_RUN_LIVE_JOB_HUNTER !== "1", timeout: 150_000 }, () => {
		assert.equal(existsSync(canonicalDb), true, "canonical job-hunter database is required for the before/after safety proof");
		const isolated = mkdtempSync(join(tmpdir(), "job-hunter-live-"));
		dirs.push(isolated);
		const isolatedDb = join(isolated, "jobhunter.sqlite");
		copyFileSync(canonicalDb, isolatedDb);
		const beforeHash = hash(canonicalDb);
		const beforeRuns = new Set(readdirSync(join(canonicalHome, "runs")));
		const argv = [script, "--source", "linkedin", "--country", "IE", "--role", "AI Architect", "--max-queries", "1", "--budget-minutes", "1", "--db", isolatedDb, "--json"];
		const replayRunId = process.env.PI_LIVE_JOB_HUNTER_RUN_ID;
		const result = replayRunId
			? { status: JSON.parse(readFileSync(join(canonicalHome, "runs", replayRunId, "checkpoint.json"), "utf8")).status === "ok" ? 0 : 3, stdout: "", stderr: "" }
			: spawnSync("node", argv, { encoding: "utf8", timeout: 140_000 });
		assert.equal([0, 3, 4, 5].includes(result.status ?? -1), true, `unexpected exit ${result.status}: ${result.stderr.slice(-1000)}`);
		assert.equal(hash(canonicalDb), beforeHash, "canonical database changed during isolated rehearsal");
		const created = replayRunId ? [replayRunId] : readdirSync(join(canonicalHome, "runs")).filter((name) => !beforeRuns.has(name));
		assert.equal(created.length, 1, `expected one run directory, found ${created.join(",")}`);
		const runRoot = join(canonicalHome, "runs", created[0]!);
		const checkpointPath = join(runRoot, "checkpoint.json");
		assert.equal(existsSync(checkpointPath), true);
		const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
		assert.equal(checkpoint.runId, created[0]);
		assert.equal(["ok", "budget-exhausted", "blocked", "preflight-failed"].includes(checkpoint.status), true, checkpoint.status);
		const resultsPath = join(runRoot, "results.json");
		if (result.status === 0) assert.equal(existsSync(isolatedDb), true);
		if (result.status === 3) assert.match(result.stderr + result.stdout, new RegExp(`--resume ${created[0]}`));
		const blocked = result.status !== 0;
		const sourceStatus = result.status === 0 ? "completed" : result.status === 3 ? "budget-exhausted" : result.status === 4 ? "blocked" : "preflight-failed";
		const report = validateReport({ schemaVersion: 1, verdict: blocked ? "BLOCKED" : "DONE", claims: [{ statement: "bounded LinkedIn source execution", evidence: [{ kind: "command", source: "node jh-search.mjs", detail: `exit ${result.status}` }], verification: "verified" }], execution: { argv: ["node", ...argv], exitCode: result.status, source: "linkedin", runId: created[0], checkpointPath, checkpointStatus: checkpoint.status, ...(existsSync(resultsPath) ? { resultsPath } : {}), candidateCount: existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")).length : 0, sourceStatus, ...(blocked ? { blocker: `linkedin ${sourceStatus}` } : {}), ...(result.status === 3 ? { resumeArgv: ["node", script, "--source", "linkedin", "--country", "IE", "--resume", created[0]] } : {}) } }, "source_search");
		assert.equal(report.valid, true, JSON.stringify(report.errors));
	});
});
