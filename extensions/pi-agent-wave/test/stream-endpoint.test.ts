import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packageRoot } from "./support/repoRoot.ts";

/**
 * The live channel a headless worker gets in place of a pane. Everything below runs the shipped supervisor,
 * a real loopback listener and a real subscriber socket; only the worker's payload is a fixture.
 */

function python(script: string, args: string[] = []) {
	return spawnSync("python3", [script, ...args], { cwd: packageRoot, encoding: "utf8", timeout: 120_000 });
}

describe("headless live stream endpoint", () => {
	test("publishes the running worker's output on a token-gated loopback endpoint that dies with the supervisor", () => {
		const run = python(join(packageRoot, "test/support/stream-endpoint-driver.py"));
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout);

		// One resolver, one backend per platform, pinned for every supported platform.
		assert.deepEqual(result.backends, { Darwin: "loopback-tcp", Linux: "loopback-tcp", Windows: "loopback-tcp" });
		assert.match(String(result.unsupportedPlatform), /unsupported platform for the live worker stream: Plan9/);

		// Loopback, ephemeral port, and a per-attempt bearer token written mode 600.
		assert.equal(result.endpoint.backend, "loopback-tcp");
		assert.equal(result.endpoint.host, "127.0.0.1");
		assert.ok(Number(result.endpoint.port) > 0, `an ephemeral port was assigned: ${result.endpoint.port}`);
		assert.equal(result.tokenAppeared, true);
		assert.equal(result.tokenMode, "0o600");

		// A connection without the token is refused and is given no worker output at all.
		assert.equal(result.withoutToken, "unauthorized");

		// A connection with the token receives what was already emitted, then what arrives live.
		assert.equal(result.backlog, "first line\n", "the subscriber sees the line emitted before it connected");
		assert.equal(result.live, "second line\n", "and then the line the worker emits while it is connected");

		// The supervisor owns the listener: it is reachable while the supervisor runs and gone once it exits.
		assert.equal(result.exitCode, 0);
		assert.equal(result.endpointGoneAfterExit, true, "the endpoint does not outlive the supervisor");
		assert.equal(result.tokenRemovedAfterExit, true);
		assert.equal(result.endpointRemovedAfterExit, true);

		// The channel retains nothing of its own: no replay file, no transcript, only the capture path's files.
		assert.deepEqual(result.filesAfterExit, ["fixture-worker.sh", "gate", "status.json", "stderr", "stdout"], "the channel leaves no artifact behind");
	});

	test("an unbindable loopback is a named blocker before dispatch, not a worker that cannot be watched", () => {
		// EPERM on a fresh loopback bind is what the restricted host in tasks/prd-runtime-owned-results.md
		// returns, so the probe is forced to meet exactly that error rather than a fabricated one.
		const script = `
import errno, json, socket, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(join(packageRoot, "scripts"))})
import stream_endpoint
import delegate_core

real_bind = socket.socket.bind
def refuse(self, address):
    raise OSError(errno.EPERM, "Operation not permitted")
socket.socket.bind = refuse
report = {}
try:
    stream_endpoint.probe_stream_endpoint()
    report["probe"] = None
except RuntimeError as error:
    report["probe"] = str(error)
launched = []
delegate_core.subprocess.Popen = lambda *a, **k: launched.append(a) or (_ for _ in ()).throw(AssertionError("dispatch must not reach the launch"))
try:
    delegate_core.launch_headless_worker({"worker_launcher": "/bin/true", "sandbox_base": "/tmp", "headless_stdout": "/tmp/o", "headless_stderr": "/tmp/e", "headless_status": "/tmp/s", "stream_token": "/tmp/t", "stream_endpoint": "/tmp/p"}, {})
    report["dispatch"] = None
except RuntimeError as error:
    report["dispatch"] = str(error)
report["launched"] = len(launched)
socket.socket.bind = real_bind
print(json.dumps(report, sort_keys=True))
`;
		const run = python("-c", [script]);
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout);
		assert.match(String(result.probe), /^live worker stream unavailable: cannot bind a loopback listener on 127\.0\.0\.1 \(EPERM\)$/);
		assert.equal(result.dispatch, result.probe, "dispatch fails with the probe's own blocker text");
		assert.equal(result.launched, 0, "no worker is started when its stream cannot be published");
	});
});
