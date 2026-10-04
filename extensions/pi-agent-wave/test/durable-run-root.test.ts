import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "../sqlite.ts";
import { DEFAULT_DB_PATH, GraphStore } from "../store.ts";

const SCRIPTS = new URL("../scripts", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => {
	// A killed `agentfs run` leaves its NFS mount behind (scripts/delegate_core.py:release_agentfs_session),
	// so mounts under a scratch root are released before the root is removed.
	const mounts = spawnSync("mount", [], { encoding: "utf8" }).stdout ?? "";
	for (const root of roots.splice(0)) {
		for (const line of mounts.split("\n")) {
			const point = line.split(" on ")[1]?.replace(/ \(.*$/, "");
			if (point?.startsWith(`${root}/`)) spawnSync("umount", ["-f", point]);
		}
		rmSync(root, { recursive: true, force: true });
	}
});

function scratch(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(root);
	return root;
}

/**
 * A scratch directory under `$HOME`. The sandbox passes every write through to `/tmp` and to the
 * per-user temp directory (where `os.tmpdir()` points on macOS), so a refusal is only observable for a
 * path outside both, which is where the real graph home lives.
 */
function homeScratch(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(homedir(), `.${prefix}`)));
	roots.push(root);
	return root;
}

function python(body: string, env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync("python3", ["-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport delegate_core as core\n${body}`], { encoding: "utf8", env: { ...env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

describe("durable run root", () => {
	test("init creates the run directory under <graph home>/runs with private modes, never under /tmp", () => {
		const graphHome = join(scratch("run-root-init-"), "graph");
		const env = { ...process.env, DELEGATE_GRAPH_DB: join(graphHome, "graph.db") };
		const init = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPTS, "delegate.ts"), "--transport", "headless", "--", "init", "run-root-init"], { encoding: "utf8", env });
		assert.equal(init.status, 0, init.stderr);
		const runDir = realpathSync(init.stdout.trim());
		assert.equal(dirname(runDir), realpathSync(join(graphHome, "runs")));
		assert.equal(statSync(runDir).mode & 0o777, 0o700);
		assert.equal(statSync(join(graphHome, "runs")).mode & 0o777, 0o700);
		assert.ok(existsSync(join(runDir, "state.json")));
	});

	test("the launcher's default graph database is the store's DEFAULT_DB_PATH, and the run root sits beside it", () => {
		const { DELEGATE_GRAPH_DB: _unset, ...withoutOverride } = process.env;
		assert.equal(python("print(core.graph_db_path())", withoutOverride), DEFAULT_DB_PATH);
		assert.equal(python("print(core.run_root())", withoutOverride), join(dirname(DEFAULT_DB_PATH), "runs"));
		const override = join(scratch("run-root-env-"), "graph.db");
		assert.equal(python("print(core.run_root())", { ...process.env, DELEGATE_GRAPH_DB: override }), join(dirname(override), "runs"));
	});

	test("a run directory's name reduces the run and operation UUIDs to 8 characters, keeping the full label in state", () => {
		const graphHome = join(scratch("run-root-name-"), "graph");
		const env = { ...process.env, DELEGATE_GRAPH_DB: join(graphHome, "graph.db") };
		const label = "run_d34d01f4-a5f7-48d3-945c-8e2548e80a35-op_ed00d5ce-8a52-48e2-abea-4d7d00842fdf";
		const init = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPTS, "delegate.ts"), "--transport", "headless", "--", "init", label], { encoding: "utf8", env });
		assert.equal(init.status, 0, init.stderr);
		const runDir = init.stdout.trim();
		const name = runDir.split("/").at(-1) ?? "";
		assert.match(name, /^delegate-graph-herdr-run-d34d01f4-op-ed00d5ce\.[^/]+$/);
		assert.ok(name.length <= 55, `the run directory name is ${name.length} characters: ${name}`);
		assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).run_label, label, "the full label stays in state");
		assert.equal(python(`core.require_run_dir(${JSON.stringify(runDir)}); print("accepted")`, env), "accepted");
	});

	test("a pi worker whose AgentFS working directory would overflow pi's session directory name is refused before any credential exists", () => {
		// Two long components push the attempt's mount path past 252 characters, the longest pi 0.87.1 can open.
		const runDir = join(scratch("run-root-deep-"), "a".repeat(90), "b".repeat(90), "delegate-graph-herdr-deep.abc");
		mkdirSync(runDir, { recursive: true, mode: 0o700 });
		const workspace = scratch("run-root-deep-ws-");
		const outcome = python(`
import os
from pathlib import Path
core.ACTIVE_TRANSPORT = 'headless'
run_dir = Path(${JSON.stringify(runDir)})
os.environ['HOME'] = str(run_dir / 'no-provider-home')
os.chdir(${JSON.stringify(workspace)})
model = 'alibaba/deepseek-v4.1-flash'
args = core.build_parser().parse_args(['start', str(run_dir), 'thinker', '--node', 'thinker_plan', '--model', model])
task = run_dir / 'task.md'; task.write_text('Offline fixture; never dispatched.'); task.chmod(0o600)
try:
    core.prepare_acpx_attempt(run_dir, args, {'run_label': 'deep'}, 'dg_deep_thinker_0001', model, task, 'thinker_plan')
    print(json.dumps({'refused': None}))
except core.DelegateError as error:
    attempt = run_dir / 'acpx' / 'dg_deep_thinker_0001'
    print(json.dumps({'refused': str(error), 'providers': (attempt / 'providers').exists(), 'credentials': [str(p) for p in run_dir.rglob('auth.json')]}))`);
		const result = JSON.parse(outcome) as { refused: string | null; providers?: boolean; credentials?: string[] };
		assert.ok(result.refused, "the attempt must be refused");
		assert.match(result.refused, /^\[dispatch_precondition\] /);
		assert.match(result.refused, /working directory would be \d+ characters; pi can open at most 252/);
		assert.equal(result.providers, false, "no provider directory is materialized");
		assert.deepEqual(result.credentials, [], "no credential file is written");

		const verdicts = python(`
from pathlib import Path
short = Path(${JSON.stringify(workspace)})
deep = Path(${JSON.stringify(runDir)})
print(json.dumps([core.worker_cwd_precondition('pi', short, 'dg-thinker-0-0-0123456789ab'), core.worker_cwd_precondition('codex', deep / ('c' * 200), 'dg-thinker-0-0-0123456789ab')]))`);
		assert.deepEqual(JSON.parse(verdicts), [null, null], "a short pi path and an unmeasured agent are not refused");
	});

	test("require_run_dir accepts the run root and, for one release, /tmp; it refuses anything else", () => {
		const graphHome = join(scratch("run-root-require-"), "graph");
		const env = { ...process.env, DELEGATE_GRAPH_DB: join(graphHome, "graph.db") };
		const durable = join(graphHome, "runs", "delegate-graph-herdr-durable.abc");
		const legacy = mkdtempSync(join("/tmp", "delegate-graph-herdr-legacy-test."));
		roots.push(legacy);
		const elsewhere = join(scratch("run-root-elsewhere-"), "delegate-graph-herdr-elsewhere.abc");
		for (const dir of [durable, legacy, elsewhere]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "state.json"), "{}"); }
		const verdict = (dir: string) => python(`
try:
    core.require_run_dir(${JSON.stringify(dir)}); print("accepted")
except core.DelegateError as error:
    print("refused")`, env);
		assert.equal(verdict(durable), "accepted");
		assert.equal(verdict(legacy), "accepted");
		assert.equal(verdict(elsewhere), "refused");
	});

	test("prune reclaims a run directory under the run root", () => {
		const graphHome = join(scratch("run-root-prune-"), "graph");
		mkdirSync(graphHome, { mode: 0o700 });
		const dbPath = join(graphHome, "graph.db");
		const store = new GraphStore({ dbPath });
		try {
			const runDirectory = join(graphHome, "runs", "delegate-graph-herdr-run-pruned-op-1.abc");
			const attempt = join(runDirectory, "acpx", "dg_pruned_thinker_0001");
			mkdirSync(attempt, { recursive: true, mode: 0o700 });
			writeFileSync(join(attempt, "cancel-acpx.sh"), "#!/bin/sh\n", { mode: 0o700 });
			const db = new Database(dbPath);
			db.query("INSERT INTO runs(id,story,graph_name,task,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("run_pruned", "story", "build", "Old task", "cancelled", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
			db.query("INSERT INTO agents(id,run_id,name,node,role,transport,status,current_task,created_at,last_activity_at,acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,herdr_pane_id,acpx_cancel_script) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
				.run("agent_pruned", "run_pruned", "dg_pruned_thinker_0001", "thinker_plan", "thinker", "headless", "running", "task", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", "pi", "record-1", "session-1", "settled", "run:op:thinker_plan:0:0:model:pi", "agentfs-1", join(attempt, "delta.db"), null, join(attempt, "cancel-acpx.sh"));
			db.close();
			assert.equal(store.prune(1), 1);
			assert.equal(existsSync(runDirectory), false);
		} finally { store.close(); }
	});
});

describe("the worker's grant over a run root under $HOME (real AgentFS)", () => {
	/** A graph home laid out as in production, beside a workspace, all under a scratch directory in $HOME. */
	function layout() {
		const root = homeScratch("dg-run-root-");
		const graphHome = join(root, "graph");
		const own = join(graphHome, "runs", "delegate-graph-herdr-own.abc");
		const sibling = join(graphHome, "runs", "delegate-graph-herdr-sibling.def");
		for (const dir of [own, sibling, join(graphHome, "runtime-content"), join(graphHome, "evidence"), join(graphHome, "failures"), join(root, "workspace")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(graphHome, "graph.db"), "store");
		writeFileSync(join(sibling, "state.json"), "{\"sibling\":true}");
		return { root, graphHome, own, sibling, workspace: join(root, "workspace") };
	}

	test("the launcher grants exactly its run directory, which contains none of the store's paths", () => {
		const { graphHome, own } = layout();
		const prepared = python(`
import os
from pathlib import Path
core.ACTIVE_TRANSPORT = 'headless'
own = Path(${JSON.stringify(own)})
home = own / 'provider-home'
(home / '.codex').mkdir(parents=True)
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
os.environ['HOME'] = str(home); os.environ['CODEX_HOME'] = str(home / '.codex'); os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
os.chdir(${JSON.stringify(join(dirname(graphHome), "workspace"))})
model = 'openai-codex/gpt-5.6-sol'
args = core.build_parser().parse_args(['start', str(own), 'thinker', '--node', 'thinker_plan', '--model', model])
task = own / 'task.md'; task.write_text('Offline fixture; never dispatched.')
resource, _ = core.prepare_acpx_attempt(own, args, {'run_label': 'grant'}, 'fixture-worker', model, task, 'thinker_plan')
print(Path(resource['worker_launcher']).read_text())`);
		const allows = [...prepared.matchAll(/--allow (\S+)/g)].map((match) => match[1]!.replace(/^'|'$/g, ""));
		assert.deepEqual(allows, [own]);
		for (const protectedPath of [join(graphHome, "graph.db"), join(graphHome, "runtime-content"), join(graphHome, "evidence"), join(graphHome, "failures"), join(graphHome, "runs", "delegate-graph-herdr-sibling.def")]) {
			assert.ok(!protectedPath.startsWith(`${own}/`), `${protectedPath} lies outside the grant`);
		}
	});

	test("inside the sandbox the store, its evidence and a sibling run directory refuse writes; the own run directory accepts them", () => {
		const { graphHome, own, sibling, workspace } = layout();
		const agentFsHome = join(own, "acpx", "w", "agentfs-home");
		mkdirSync(agentFsHome, { recursive: true, mode: 0o700 });
		const targets: Record<string, string> = {
			"graph database": join(graphHome, "graph.db"),
			"runtime-content": join(graphHome, "runtime-content", "x"),
			evidence: join(graphHome, "evidence", "x"),
			failures: join(graphHome, "failures", "x"),
			"sibling run directory": join(sibling, "state.json"),
			"own run directory": join(own, "acpx", "w", "worker-result.json"),
		};
		const script = Object.entries(targets).map(([label, path]) => `(printf tampered > '${path}' 2>/dev/null && echo 'OK ${label}') || echo 'REFUSED ${label}'`).join("; ");
		const run = spawnSync("agentfs", ["run", "--session", `dg-grant-${process.pid}`, "--no-default-allows", "--allow", own, "sh", "-c", script], { cwd: workspace, encoding: "utf8", env: { ...process.env, HOME: agentFsHome }, timeout: 120_000 });
		assert.equal(run.status, 0, run.stderr);
		for (const label of ["graph database", "runtime-content", "evidence", "failures", "sibling run directory"]) assert.match(run.stdout, new RegExp(`REFUSED ${label}`), `${label} must refuse the write`);
		assert.match(run.stdout, /OK own run directory/);
		assert.equal(readFileSync(join(graphHome, "graph.db"), "utf8"), "store");
		assert.equal(readFileSync(join(sibling, "state.json"), "utf8"), "{\"sibling\":true}");
		assert.equal(readFileSync(join(own, "acpx", "w", "worker-result.json"), "utf8"), "tampered");
	});

	test("what a worker wrote into its run directory survives the worker being killed", async () => {
		const { own, workspace } = layout();
		const agentFsHome = join(own, "acpx", "w", "agentfs-home");
		const output = join(own, "acpx", "w", "runtime-output");
		mkdirSync(agentFsHome, { recursive: true, mode: 0o700 });
		// AgentFS runs the sandboxed command outside the child's process group, so a group SIGKILL can leave
		// the long-running step alive. It carries a unique marker and never holds the test's stdio, so it is
		// found and killed by name and cannot keep the test runner waiting.
		const marker = `dg-kill-wait-${process.pid}-${Date.now()}`;
		const body = `mkdir -p '${output}' && printf 'partial answer' > '${output}/public-answer.txt' && printf '{"event":"chunk"}\\n' > '${output}/worker.stdout.ndjson' && echo READY && python3 -c 'import time; time.sleep(300)' ${marker} </dev/null >/dev/null 2>&1`;
		const child = spawn("agentfs", ["run", "--session", `dg-kill-${process.pid}`, "--no-default-allows", "--allow", own, "sh", "-c", body], { cwd: workspace, env: { ...process.env, HOME: agentFsHome }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("worker never became ready")), 120_000);
				child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("READY")) { clearTimeout(timer); resolve(); } });
			});
			process.kill(-child.pid!, "SIGKILL");
			await new Promise((resolve) => child.on("exit", resolve));
		} finally {
			spawnSync("pkill", ["-KILL", "-f", marker]);
			child.stdout?.destroy(); child.stderr?.destroy();
		}
		assert.equal(readFileSync(join(output, "public-answer.txt"), "utf8"), "partial answer");
		assert.equal(readFileSync(join(output, "worker.stdout.ndjson"), "utf8"), "{\"event\":\"chunk\"}\n");
		for (const volatile of ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]) assert.ok(!own.startsWith(volatile), `${own} must not lie on a volatile root`);
	});
});
