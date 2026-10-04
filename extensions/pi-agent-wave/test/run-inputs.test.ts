import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { captureRunInputs, INPUT_FILE_LIMIT } from "../lib/run-inputs.ts";
import { GraphStore, CURRENT_SCHEMA_VERSION } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { materializeRuntimeEvidence } from "../index.ts";
import { renderStatus } from "../commands.ts";
import { Database } from "../sqlite.ts";

const roots: string[] = [];
afterEach(() => {
	const mounts = spawnSync("mount", [], { encoding: "utf8" }).stdout ?? "";
	for (const root of roots.splice(0)) {
		for (const line of mounts.split("\n")) {
			const point = line.split(" on ")[1]?.replace(/ \(.*$/, "");
			if (point?.startsWith(`${root}/`)) spawnSync("umount", ["-f", point]);
		}
		rmSync(root, { recursive: true, force: true });
	}
});
function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "run-inputs-")));
	roots.push(root);
	return root;
}

test("invalid inputs create no run or retained input content", () => {
	const root = scratch();
	const path = join(root, "source");
	writeFileSync(path, "source");
	symlinkSync(path, join(root, "link"));
	linkSync(path, join(root, "hardlink"));
	writeFileSync(join(root, "large"), ""); truncateSync(join(root, "large"), INPUT_FILE_LIMIT + 1);
	writeFileSync(join(root, "unreadable"), "private"); chmodSync(join(root, "unreadable"), 0);
	assert.equal(spawnSync("mkfifo", [join(root, "fifo")]).status, 0);
	for (const [name, invalid] of [
		["missing", join(root, "absent")], ["directory", root], ["symlink", join(root, "link")],
		["large", join(root, "large")], ["unreadable", join(root, "unreadable")], ["fifo", join(root, "fifo")],
	]) assert.throws(() => captureRunInputs([{ name: "valid", path }, { name, path: invalid }]), new RegExp(name));
	assert.throws(() => captureRunInputs([{ name: "a", path }, { name: "a", path }]), /duplicate name/);
	assert.throws(() => captureRunInputs([{ name: "bad/name", path }]), /name/);
	assert.throws(() => captureRunInputs([{ name: "a", path }, { name: "b", path: join(root, "hardlink") }]), /duplicate.*(file|identity)/);
	assert.throws(() => captureRunInputs([{ name: "a", path }, { name: "b", path }]), /duplicate.*path/);
	assert.throws(() => captureRunInputs(Array.from({ length: 33 }, (_, index) => ({ name: `x${index}`, path }))), /32 inputs/);
	const big = Array.from({ length: 4 }, (_, index) => {
		const file = join(root, `aggregate-${index}`); writeFileSync(file, ""); truncateSync(file, INPUT_FILE_LIMIT);
		return { name: `aggregate-${index}`, path: file };
	});
	assert.throws(() => captureRunInputs(big), /total/);
	assert.equal(existsSync(join(root, "runtime-content")), false);
	for (const prefix of ["~/", "$HOME/", "${HOME}/"]) assert.equal(captureRunInputs([{ name: "home", path: `${prefix}source` }], root)[0].content.toString(), "source");
});

test("input copies use init bytes and redact source provenance", () => {
	const root = scratch(); const sourceDir = join(root, "unique-source-provenance"); mkdirSync(sourceDir);
	const path = join(sourceDir, "source"); writeFileSync(path, "init bytes");
	const store = new GraphStore({ dbPath: join(root, "graph", "graph.db") });
	try {
		const content = new RuntimeContentStore(store.dbPath);
		const inputs = captureRunInputs([{ name: "archive", path }]).map((input) => ({ name: input.name, sourcePath: input.sourcePath, ...content.retain(input.content) }));
		const run = store.initRun("inputs", "research", "Read declared input archive", undefined, undefined, { inputs, dispatchWorkspaceRoot: root });
		writeFileSync(path, "new bytes"); rmSync(path);
		const evidence = materializeRuntimeEvidence(store, run.runId, join(root, "attempt"));
		const copy = join(root, "attempt", "runtime-evidence", "inputs", "archive");
		assert.equal(readFileSync(copy, "utf8"), "init bytes"); assert.equal(statSync(copy).mode & 0o777, 0o400);
		assert.equal(createHash("sha256").update(readFileSync(copy)).digest("hex"), store.runInputs(run.runId)[0].sha256);
		assert.ok(evidence.taskSuffix.includes(copy));
		assert.ok(JSON.stringify(store.runtimeLedger(run.runId)).includes(path)); assert.ok(renderStatus(store, run.runId).includes(path));
		assert.ok(!JSON.stringify(store.workerRuntimeLedger(run.runId)).includes(sourceDir));
		assert.ok(!readFileSync(evidence.ledgerPath, "utf8").includes(sourceDir)); assert.ok(!evidence.taskSuffix.includes(sourceDir));
		chmodSync(copy, 0o600); writeFileSync(copy, "modified attempt");
		materializeRuntimeEvidence(store, run.runId, join(root, "next-attempt"));
		assert.equal(readFileSync(join(root, "next-attempt", "runtime-evidence", "inputs", "archive"), "utf8"), "init bytes");
		assert.equal(store.getRun(run.runId).dispatch_workspace_root, root);
	} finally { store.close(); }
});

const SUPPORT = join(dirname(new URL(import.meta.url).pathname), "support");
function driver(name: string, args: string[]): string {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", join(SUPPORT, name), ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

test("source reads use a bounded no-follow descriptor", () => {
	assert.match(driver("run-input-capture-races.mjs", [scratch()]), /refuses observed replacement/);
});

test("tool initialization prepares resources without a second picker", () => {
	assert.match(driver("run-input-driver.mjs", ["initialization", scratch()]), /without a second picker/);
});

test("slash initialization hands resource preparation to the supervisor", () => {
	assert.match(driver("run-input-driver.mjs", ["slash", scratch()]), /slash initialization hands resource preparation/);
});

test("dispatch delivers inputs to every graph node and replacement attempt", () => {
	assert.match(driver("run-input-driver.mjs", ["delivery", scratch()]), /every graph node and replacement attempt/);
});

test("legacy runs still dispatch in the session workspace", () => {
	assert.match(driver("run-input-driver.mjs", ["legacy", scratch()]), /legacy runs still dispatch/);
});

test("agentfs reads the materialized input", (t) => {
	if (spawnSync("agentfs", ["--version"]).error) { t.skip("AgentFS is not installed"); return; }
	const root = realpathSync(mkdtempSync(join(homedir(), ".run-input-sandbox-"))); roots.push(root);
	const workspace = join(root, "workspace"); const runDir = join(root, "attempt"); const home = join(runDir, "agentfs-home");
	mkdirSync(workspace); mkdirSync(home, { recursive: true });
	const source = join(root, "source"); writeFileSync(source, "snapshot inside AgentFS");
	const store = new GraphStore({ dbPath: join(root, "graph", "graph.db") });
	try {
		const content = new RuntimeContentStore(store.dbPath);
		const inputs = captureRunInputs([{ name: "archive", path: source }]).map((input) => ({ name: input.name, sourcePath: input.sourcePath, ...content.retain(input.content) }));
		const run = store.initRun("sandbox", "research", "Read archive", undefined, undefined, { inputs });
		materializeRuntimeEvidence(store, run.runId, runDir);
		rmSync(source);
		const result = spawnSync("agentfs", ["run", "--session", `dg-input-${process.pid}`, "--no-default-allows", "--allow", runDir, "cat", join(runDir, "runtime-evidence", "inputs", "archive")], { cwd: workspace, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
		assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "snapshot inside AgentFS");
	} finally { store.close(); }
});

test("v13 input migration preserves existing column values and dependent rows", () => {
	const root = scratch(); const dbPath = join(root, "graph.db");
	const store = new GraphStore({ dbPath }); const run = store.initRun("old", "research", "Read workspace"); store.close();
	const old = new Database(dbPath);
	old.exec("ALTER TABLE runs DROP COLUMN inputs_json; ALTER TABLE runs DROP COLUMN dispatch_workspace_root; DELETE FROM schema_version; INSERT INTO schema_version(version) VALUES (13)");
	const tables = ["runs", "state", "operations", "events", "graphs"];
	const before = tables.map((table) => old.query(`SELECT * FROM ${table}`).all()); old.close();
	const migrated = new GraphStore({ dbPath });
	assert.equal(migrated.getRun(run.runId).inputs_json, "[]"); assert.equal(migrated.getRun(run.runId).dispatch_workspace_root, null); migrated.close();
	const db = new Database(dbPath);
	try {
		assert.equal(db.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version, CURRENT_SCHEMA_VERSION);
		for (const [index, table] of tables.entries()) {
			const columns = Object.keys(before[index][0] ?? {});
			assert.deepEqual(db.query(`SELECT ${columns.join(",")} FROM ${table}`).all(), before[index]);
		}
	} finally { db.close(); }
});
