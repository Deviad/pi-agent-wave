import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "../sqlite.ts";
import { GraphStore } from "../store.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): { root: string; dbPath: string; store: GraphStore } {
	const root = mkdtempSync(join(tmpdir(), "story-ledger-"));
	directories.push(root);
	const dbPath = join(root, "graph.db");
	return { root, dbPath, store: new GraphStore({ dbPath, now: () => new Date("2026-09-20T12:00:00.000Z") }) };
}

function entry(store: GraphStore, story: string, topic: string, extra: Partial<Parameters<GraphStore["recordLedgerEntry"]>[0]> = {}) {
	return store.recordLedgerEntry({ story, topic, runId: `run-${topic}`, tier: "coding", model: "alibaba/deepseek-v4.1-flash", outcome: "accepted", task: "Do the thing", ...extra });
}

describe("story ledger", () => {
	test("numbers entries per story, so the sequence replaces the file lock", () => {
		const { dbPath, store } = fixture();
		try {
			assert.equal(entry(store, "story-a", "first").sequence, 1);
			assert.equal(entry(store, "story-a", "second").sequence, 2);
			assert.equal(entry(store, "story-b", "other").sequence, 1, "a second story numbers from one");
			// A second connection computes the same next number, which is what the old `.sequence-lock` guarded.
			const other = new GraphStore({ dbPath });
			try {
				assert.equal(entry(other, "story-a", "third").sequence, 3);
			} finally { other.close(); }
			assert.deepEqual(store.storyLedger("story-a").map((row) => row.sequence), [1, 2, 3]);
			assert.deepEqual(store.storyLedger("story-b").map((row) => row.sequence), [1]);
		} finally { store.close(); }
	});

	test("stores claims with their evidence state and aggregates as recorded", () => {
		const { store } = fixture();
		try {
			const recorded = entry(store, "story-a", "reviewed", {
				outcome: "blocked",
				claims: [
					{ claim: "the gate passes", evidence: "agent-output/gate.log", status: "verified" },
					{ claim: "the route was exhausted", evidence: "recall", status: "unverified-recall" },
				],
				aggregates: [{ name: "criteria met", numerator: 9, denominator: 10, percentage: 90 }],
			});
			const [read] = store.storyLedger("story-a");
			assert.deepEqual(read.claims, [
				{ position: 1, claim: "the gate passes", evidence: "agent-output/gate.log", status: "verified" },
				{ position: 2, claim: "the route was exhausted", evidence: "recall", status: "unverified-recall" },
			]);
			assert.deepEqual(read.aggregates, [{ position: 1, name: "criteria met", numerator: 9, denominator: 10, percentage: 90 }]);
			assert.equal(read.outcome, "blocked");
			assert.equal(read.id, recorded.id);
		} finally { store.close(); }
	});

	test("recomputes the aggregate rather than trusting the recorded percentage", () => {
		const { store } = fixture();
		try {
			entry(store, "consistent", "nine-of-ten", { aggregates: [{ name: "criteria met", numerator: 9, denominator: 10, percentage: 90 }] });
			assert.equal(store.auditStoryLedger("consistent").valid, true, "9/10 is 90%");
			assert.deepEqual(store.auditStoryLedger("consistent").findings, []);

			// The exact defect the supervisor rules forbid: a total that disagrees with its own components.
			entry(store, "mismatched", "nine-of-ten", { aggregates: [{ name: "criteria met", numerator: 9, denominator: 10, percentage: 100 }] });
			const audit = store.auditStoryLedger("mismatched");
			assert.equal(audit.valid, false);
			assert.deepEqual(audit.findings.map((finding) => finding.code), ["AGGREGATE_MISMATCH"]);
			assert.match(audit.findings[0].message, /recorded 100, computed 90/);

			entry(store, "zero", "none", { aggregates: [{ name: "criteria met", numerator: 0, denominator: 0, percentage: 0 }] });
			assert.deepEqual(store.auditStoryLedger("zero").findings.map((finding) => finding.code), ["AGGREGATE_INVALID"]);

			assert.deepEqual(store.auditStoryLedger("absent").findings.map((finding) => finding.code), ["LEDGER_EMPTY"]);
		} finally { store.close(); }
	});

	test("reports a sequence gap instead of assuming contiguity", () => {
		const { dbPath, store } = fixture();
		try {
			entry(store, "story-a", "first");
			entry(store, "story-a", "second");
		} finally { store.close(); }
		const db = new Database(dbPath);
		// A gap can only arrive by tampering today; the audit must still refuse to assume it cannot.
		db.query("UPDATE ledger_entries SET sequence=7 WHERE topic='second'").run();
		db.close();
		const reopened = new GraphStore({ dbPath });
		try {
			assert.deepEqual(reopened.auditStoryLedger("story-a").findings.map((finding) => finding.code), ["SEQUENCE_GAP"]);
		} finally { reopened.close(); }
	});

	test("pruning a run keeps the story's record, because the entry outlives its run", () => {
		const { dbPath, store } = fixture();
		try {
			const db = new Database(dbPath);
			db.query("INSERT INTO runs(id,story,graph_name,task,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
				.run("run_pruned", "story-a", "build", "Old task", "cancelled", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
			db.close();
			entry(store, "story-a", "kept", { runId: "run_pruned" });

			assert.equal(store.prune(1), 1, "the settled run is pruned");
			assert.equal(new Database(dbPath, { readonly: true }).query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs").get()?.count, 0);
			const [kept] = store.storyLedger("story-a");
			assert.equal(kept.sequence, 1, "the record survives the run it describes");
			assert.equal(kept.runId, "run_pruned", "the run id is kept as a value, not a foreign key");
			assert.equal(store.auditStoryLedger("story-a").valid, true);
		} finally { store.close(); }
	});

	test("pruning reclaims the run's evidence, diagnostics and transient directory", () => {
		const { root, dbPath, store } = fixture();
		try {
			const db = new Database(dbPath);
			db.query("INSERT INTO runs(id,story,graph_name,task,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
				.run("run_reclaimed", "story-a", "build", "Old task", "cancelled", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
			// A run directory is three levels above its operation's cancel launcher, which is how prune
			// resolves it exactly instead of guessing at /tmp names.
			const runDirectory = join(root, "delegate-graph-herdr-run-reclaimed-op-1.abc");
			const attempt = join(runDirectory, "acpx", "dg_reclaimed_thinker_0001");
			mkdirSync(attempt, { recursive: true, mode: 0o700 });
			writeFileSync(join(attempt, "cancel-acpx.sh"), "#!/bin/sh\n", { mode: 0o700 });
			db.query("INSERT INTO agents(id,run_id,name,node,role,transport,status,current_task,created_at,last_activity_at,acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,herdr_pane_id,acpx_cancel_script) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
				.run("agent_reclaimed", "run_reclaimed", "dg_reclaimed_thinker_0001", "thinker_plan", "thinker", "headless", "running", "task", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", "pi", "record-1", "session-1", "settled", "run:op:thinker_plan:0:0:model:pi", "agentfs-1", join(attempt, "delta.db"), null, join(attempt, "cancel-acpx.sh"));
			db.close();
			const evidence = store.retainRunEvidence("run_reclaimed", "runtime-settlement-worker.json", "{}\n");
			const diagnostics = store.retainRunDiagnostic("run_reclaimed", "failure-op-1.json", { schemaVersion: 1 });
			for (const path of [evidence, diagnostics, join(attempt, "cancel-acpx.sh"), runDirectory]) assert.equal(existsSync(path), true, `${path} must exist before pruning`);

			assert.equal(store.prune(1), 1);
			assert.equal(existsSync(dirname(evidence)), false, "retained evidence for the pruned run is reclaimed");
			assert.equal(existsSync(diagnostics), false, "never-dispatched diagnostics are reclaimed with the run");
			assert.equal(existsSync(runDirectory), false, "the transient run directory is reclaimed with the run");
		} finally { store.close(); }
	});

	test("pruning leaves another run's evidence alone", () => {
		const { root, dbPath, store } = fixture();
		try {
			const db = new Database(dbPath);
			db.query("INSERT INTO runs(id,story,graph_name,task,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
				.run("run_old", "story-a", "build", "Old", "cancelled", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
			db.close();
			const kept = store.retainRunEvidence("run_live", "runtime-settlement-worker.json", "{}\n");
			assert.equal(store.prune(1), 1);
			assert.equal(existsSync(kept), true, "evidence for a run prune did not delete must survive");
		} finally { store.close(); }
	});

	test("refuses an entry that is missing identity or carries an unknown outcome", () => {
		const { store } = fixture();
		try {
			assert.throws(() => entry(store, "  ", "topic"), /requires a story/);
			assert.throws(() => entry(store, "story-a", " "), /requires a topic/);
			assert.throws(() => entry(store, "story-a", "topic", { outcome: "done" as never }), /unsupported ledger outcome/);
			assert.throws(
				() => entry(store, "story-a", "topic", { claims: [{ claim: "c", evidence: "e", status: "probably" as never }] }),
				/unsupported ledger claim status/,
			);
		} finally { store.close(); }
	});

	test("two writers racing on one store take contiguous sequences, never the same one", () => {
		const { root, dbPath, store } = fixture();
		store.close();
		// Real concurrency, not two turns taken in order: both processes are told the same start time and
		// run at once, so if the sequence were read outside the inserting transaction they could collide.
		const driver = join(root, "writer.mjs");
		writeFileSync(driver, `
import { GraphStore } from ${JSON.stringify(join(import.meta.dirname, "..", "store.ts"))};
const [dbPath, label, startAt] = process.argv.slice(2);
const store = new GraphStore({ dbPath });
const sequences = [];
while (Date.now() < Number(startAt)) { /* both writers start on the same tick */ }
for (let index = 0; index < 25; index += 1) {
	for (;;) {
		try { sequences.push(store.recordLedgerEntry({ story: "race", topic: label + "-" + index, runId: "r", tier: "coding", model: "m", outcome: "accepted", task: "t" }).sequence); break; }
		catch (error) { if (!/SQLITE_BUSY|database is locked|UNIQUE/i.test(String(error))) throw error; }
	}
}
store.close();
process.stdout.write(JSON.stringify(sequences));
`);
		const startAt = Date.now() + 300;
		const writers = ["a", "b"].map((label) => spawn(process.execPath, ["--experimental-strip-types", driver, dbPath, label, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] }));
		const outputs = writers.map((writer) => { let text = ""; writer.stdout.on("data", (chunk) => { text += String(chunk); }); return () => text; });
		const errors = writers.map((writer) => { let text = ""; writer.stderr.on("data", (chunk) => { text += String(chunk); }); return () => text; });
		const codes = writers.map((writer) => new Promise<number>((resolve) => writer.on("close", resolve)));
		return Promise.all(codes).then((exits) => {
			assert.deepEqual(exits, [0, 0], `${errors[0]()}\n${errors[1]()}`);
			const taken = [...JSON.parse(outputs[0]()), ...JSON.parse(outputs[1]())].sort((a, b) => a - b);
			assert.equal(taken.length, 50);
			assert.deepEqual(taken, Array.from({ length: 50 }, (_, index) => index + 1), "the 50 entries take 1..50 with no gap and no duplicate");
			const reopened = new GraphStore({ dbPath });
			try { assert.deepEqual(reopened.auditStoryLedger("race").findings, [], "the audit sees a contiguous sequence"); }
			finally { reopened.close(); }
		});
	});

	test("the command surface writes through the store and audits from it, creating no ledger file", () => {
		const { root, dbPath, store } = fixture();
		store.close();
		const cli = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "..", "scripts", "story-ledger.mjs"), ...args], { encoding: "utf8", env: { ...process.env, DELEGATE_GRAPH_DB: dbPath } });

		const written = cli(["write", "cli-story", "first-topic", "--run", "run_1", "--tier", "coding", "--model", "alibaba/deepseek-v4.1-flash", "--outcome", "accepted", "--task", "Do the thing", "--claim", "the bundle exists::failure-op-1.json read back at mode 600::verified", "--aggregate", "criteria met::9::10::90"]);
		assert.equal(written.status, 0, written.stderr);
		const recorded = JSON.parse(written.stdout.trim().split("\n").at(-1)!);
		assert.equal(recorded.action, "ledger_entry_recorded");
		assert.equal(recorded.store, dbPath, "the command names the store it wrote to");
		assert.deepEqual([recorded.story, recorded.sequence, recorded.claims, recorded.aggregates], ["cli-story", 1, 1, 1]);

		// The rows are in the store, and no file ledger was produced anywhere near it.
		const reopened = new GraphStore({ dbPath });
		try {
			const [entryRow] = reopened.storyLedger("cli-story");
			assert.equal(entryRow.topic, "first-topic");
			assert.deepEqual(entryRow.claims, [{ position: 1, claim: "the bundle exists", evidence: "failure-op-1.json read back at mode 600", status: "verified" }]);
			assert.deepEqual(entryRow.aggregates, [{ position: 1, name: "criteria met", numerator: 9, denominator: 10, percentage: 90 }]);
		} finally { reopened.close(); }
		assert.equal(existsSync(join(root, "delegate-ledger")), false, "no file ledger directory is created");
		assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".json")), [], "no ledger JSON file is written beside the store");

		assert.equal(cli(["audit", "cli-story"]).status, 0, "a consistent story audits clean through the command");

		// The defect the audit exists for, reached through the command rather than the store API.
		assert.equal(cli(["write", "cli-bad", "rounded", "--run", "run_2", "--tier", "coding", "--model", "m", "--outcome", "accepted", "--task", "t", "--aggregate", "criteria met::9::10::100"]).status, 0);
		const audited = cli(["audit", "cli-bad"]);
		assert.equal(audited.status, 2, "a mismatched aggregate exits non-zero");
		const report = JSON.parse(audited.stdout);
		assert.equal(report.valid, false);
		assert.deepEqual(report.findings.map((finding: { code: string }) => finding.code), ["AGGREGATE_MISMATCH"]);
		assert.match(report.findings[0].message, /recorded 100, computed 90/);
	});
});
