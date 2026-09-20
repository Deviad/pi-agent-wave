import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));

/**
 * Drives the production `wait_for_settled_agent` with a fake `run` and a temporary attempt
 * directory. `WAIT_TIMEOUT_MS` is pinned to 60 s so a regression to the blind wait shows up as
 * a hang past the 10 s spawn timeout rather than a one-hour stall.
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
resource = {'agent': 'worker', 'execution': 'acpx-agentfs', 'worker_result': str(attempt_dir / 'worker-result.json'), 'attempt_dir': str(attempt_dir)}
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
    calls.append(argv[:3])
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
    calls.append(argv[:3])
    return Result(1, json.dumps({'error': {'code': 'agent_not_found', 'message': 'agent target worker not found'}}))
`;
		const observed = probe(body, "herdr");
		assert.match(String(observed.error), /no longer registered before result/);
		assert.ok(Number(observed.elapsed) < 3, `took ${observed.elapsed}s`);
		assert.deepEqual(observed.calls, [["herdr", "agent", "get"]]);
	});

	test("a malformed liveness answer keeps waiting for the result", () => {
		const body = String.raw`
def fake_run(argv, check=True, **_kwargs):
    calls.append(argv[:3])
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
    calls.append(argv[:3])
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
});
