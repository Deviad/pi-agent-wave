import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));

/**
 * Drives the production `wait_for_settled_agent` with a fake `run` and a temporary attempt
 * directory. `WAIT_TIMEOUT_MS` is pinned to 60 s so a regression to the blind wait shows up as
 * a hang past the 10 s spawn timeout rather than a one-hour stall.
 *
 * The fixture answers are the real CLI's, captured 2026-09-20 against a running Herdr:
 *   herdr agent get wR:p3                        -> {"result":{"agent":{"agent":"dg_run-e5b0_thinker_8d06cc93","agent_status":"working","pane_id":"wR:p3",...}}}
 *   herdr agent get dg_run-e5b0_thinker_8d06cc93 -> {"error":{"code":"agent_not_found",...}}   (same worker, alive)
 *   herdr agent get wS:p2                        -> {"error":{"code":"agent_not_found",...}}   (pane gone)
 * `agent get` resolves pane refs only, which is why the probe must never take the agent name.
 */
function probe(body: string, transport: "herdr" | "headless"): Record<string, unknown> {
	const source = String.raw`
import json, pathlib, runpy, shutil, sys, tempfile, threading, time
module = runpy.run_path(sys.argv[1])
core = module['wait_for_settled_agent'].__globals__
core['WAIT_TIMEOUT_MS'] = '60000'
core['HERDR_LIVENESS_INTERVAL_S'] = 0.3
core['ACTIVE_TRANSPORT'] = ${JSON.stringify(transport)}
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-liveness-'))
attempt_dir = run_dir / 'acpx' / 'worker'
attempt_dir.mkdir(parents=True)
resource = {'agent': 'worker', 'pane': 'wZ:p9', 'execution': 'acpx-agentfs', 'worker_result': str(attempt_dir / 'worker-result.json'), 'attempt_dir': str(attempt_dir)}
calls = []
class Result:
    def __init__(self, returncode, stdout=''):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ''
${body}
core['run'] = fake_run
started = time.monotonic()
error = None
try:
    module['wait_for_settled_agent'](run_dir, resource)
except Exception as caught:
    error = str(caught)
print(json.dumps({'error': error, 'elapsed': time.monotonic() - started, 'calls': calls}))
`;
	const result = spawnSync("python3", ["-c", source, script], { encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || "python probe timed out");
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Herdr wait notices a torn-down worker", () => {
	test("fails within seconds when the attempt directory is removed", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    return Result(0, json.dumps({'result': {'agent': {'agent_status': 'working'}}}))
threading.Timer(0.5, lambda: shutil.rmtree(attempt_dir)).start()
`;
		const observed = probe(body, "herdr");
		assert.match(String(observed.error), /attempt directory removed before result/);
		assert.ok(Number(observed.elapsed) < 3, `took ${observed.elapsed}s`);
	});

	test("fails within seconds when Herdr no longer knows the agent", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    return Result(1, json.dumps({'error': {'code': 'agent_not_found', 'message': 'agent target worker not found'}}))
`;
		const observed = probe(body, "herdr");
		assert.match(String(observed.error), /no longer registered before result/);
		assert.ok(Number(observed.elapsed) < 3, `took ${observed.elapsed}s`);
		assert.deepEqual(observed.calls, [["herdr", "agent", "get", "wZ:p9"]], "the probe must target the pane: `herdr agent get <name>` answers agent_not_found for a live worker");
	});

	test("a malformed liveness answer keeps waiting for the result", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    return Result(1, 'herdr: socket unavailable')
def finish():
    (attempt_dir / 'worker-result.json').write_text(json.dumps({'schemaVersion': 2, 'resultContract': 'runtime-v1'}))
threading.Timer(0.8, finish).start()
core['wait_for_worker_exit'] = lambda resource: None
`;
		const observed = probe(body, "herdr");
		assert.equal(observed.error, null);
		assert.ok((observed.calls as unknown[]).length >= 1);
	});

	test("headless transport never asks Herdr", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    return Result(1, json.dumps({'error': {'code': 'agent_not_found'}}))
def finish():
    (attempt_dir / 'worker-result.json').write_text(json.dumps({'schemaVersion': 2, 'resultContract': 'runtime-v1'}))
threading.Timer(0.8, finish).start()
core['wait_for_worker_exit'] = lambda resource: None
`;
		const observed = probe(body, "headless");
		assert.equal(observed.error, null);
		assert.deepEqual(observed.calls, []);
	});

	test("a live pane keeps the wait going even though the agent name would not resolve", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    # Real shapes: the pane resolves to the reported agent; the same agent queried by NAME is not found.
    if argv[3] == 'wZ:p9':
        return Result(0, json.dumps({'result': {'agent': {'agent': 'worker', 'agent_status': 'working', 'pane_id': 'wZ:p9'}}}))
    return Result(1, json.dumps({'error': {'code': 'agent_not_found', 'message': 'agent target worker not found'}}))
def finish():
    (attempt_dir / 'worker-result.json').write_text(json.dumps({'schemaVersion': 2, 'resultContract': 'runtime-v1'}))
threading.Timer(0.8, finish).start()
core['wait_for_worker_exit'] = lambda resource: None
`;
		const observed = probe(body, "herdr");
		assert.equal(observed.error, null, "a worker whose pane still has an agent must not be torn down");
		assert.ok((observed.calls as string[][]).every((argv) => argv[3] === "wZ:p9"), `probe must query the pane, got ${JSON.stringify(observed.calls)}`);
	});

	test("no wait path uses pane or agent status as its settle condition", () => {
		// `herdr agent wait --until idle` never fires for a healthy worker: its status stays `working` for the
		// whole turn. Pane status is only an advisory liveness probe; the settle condition is the result file.
		const core = readFileSync(fileURLToPath(new URL("../scripts/delegate_core.py", import.meta.url)), "utf8");
		assert.equal(/"agent",\s*"wait"/.test(core), false, "no `herdr agent wait` invocation");
		assert.equal(/agent_status/.test(core), false, "no settle decision reads `agent_status`");
		const wait = core.slice(core.indexOf("def wait_for_settled_agent"), core.indexOf("def run_acpx_again"));
		assert.match(wait, /while time\.monotonic\(\) < deadline and not result_path\.exists\(\):/);
	});

	test("the worker publishes its result atomically, so a poll can never read a half-written file", () => {
		// The observed intermittent failure was `invalid ACPX worker result: Expecting value: line 1
		// column 1 (char 0)`: the waiter polls for the path and parses it, and the worker used to create
		// the file and write it afterwards, so the poll could catch it empty. The rename closes that window.
		const worker = readFileSync(fileURLToPath(new URL("../scripts/acpx-worker.ts", import.meta.url)), "utf8");
		assert.match(worker, /renameSync\(pending, config\.resultPath\)/, "the runtime result is published by rename");
		assert.equal(/openSync\(config\.resultPath, "wx"/.test(worker), false, "the result path is never created before it is written");

		// And the waiter, driven for real: a writer that publishes by rename is never seen half-written.
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv)
    return Result(0, json.dumps({'result': {'agent': {'agent': 'worker', 'agent_status': 'working', 'pane_id': 'wZ:p9'}}}))
def finish():
    target = attempt_dir / 'worker-result.json'
    pending = attempt_dir / 'worker-result.json.tmp'
    # Exactly the worker's sequence: content first, into a sibling, then one rename.
    pending.write_text(json.dumps({'schemaVersion': 2, 'resultContract': 'runtime-v1'}))
    pending.rename(target)
threading.Timer(0.8, finish).start()
core['wait_for_worker_exit'] = lambda resource: None
`;
		const observed = probe(body, "herdr");
		assert.equal(observed.error, null, "the published result parses on the first poll that sees it");
	});
});
