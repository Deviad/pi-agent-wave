import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./support/repoRoot.ts";

/**
 * The live channel a headless worker gets in place of a pane. Everything below runs the shipped supervisor,
 * a real loopback listener and a real subscriber socket; only the worker's payload is a fixture.
 */

function python(script: string, args: string[] = []) {
	return spawnSync("python3", [script, ...args], { cwd: packageRoot, encoding: "utf8", timeout: 120_000 });
}

/**
 * Scratch roots the drivers created, removed after every test. Collected rather than removed inline so a
 * failing assertion above the removal cannot leak a directory - which is how six of these accumulated.
 */
const driverRoots: string[] = [];
afterEach(() => { for (const root of driverRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Runs a driver and takes ownership of the scratch root it reports. */
function driver(name: string, args: string[] = []): Record<string, any> {
	const run = python(join(packageRoot, "test/support", name), args);
	assert.equal(run.status, 0, run.stderr);
	const result = JSON.parse(run.stdout) as Record<string, any>;
	if (typeof result.root === "string") driverRoots.push(result.root);
	return result;
}

describe("pane reading", () => {
	test("a hung pane read gives up instead of freezing the view it runs on", () => {
		// readPane runs synchronously on the UI thread, once per worker per redraw, so an unbounded
		// spawnSync freezes the whole Pi terminal for as long as `herdr` hangs. Proven against a real
		// hanging executable: without the timeout this call never returned.
		const stub = mkdtempSync(join(tmpdir(), "hung-herdr-"));
		try {
			writeFileSync(join(stub, "herdr"), "#!/bin/sh\nsleep 300\n", { mode: 0o700 });
			const probe = spawnSync(process.execPath, ["--experimental-strip-types", "-e", `
				import { readPane } from ${JSON.stringify(join(packageRoot, "lib", "pane-read.ts"))};
				const started = Date.now();
				const value = readPane("wA:p1", 5);
				process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - started, value }));
			`], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
			assert.equal(probe.signal, null, "the probe itself must not be the thing that timed out");
			assert.equal(probe.status, 0, probe.stderr);
			const observed = JSON.parse(probe.stdout);
			assert.equal(observed.value, null, "a pane that cannot be read in time reads as absent");
			assert.ok(observed.elapsedMs < 5_000, `the read must give up quickly, took ${observed.elapsedMs}ms`);
		} finally { rmSync(stub, { recursive: true, force: true }); }
	});
});

describe("headless live stream endpoint", () => {
	test("publishes the running worker's output on a token-gated loopback endpoint that dies with the supervisor", () => {
		const result = driver("stream-endpoint-driver.py");

		// One resolver, one backend per platform, pinned for every supported platform.
		assert.deepEqual(result.backends, { Darwin: "loopback-tcp", Linux: "loopback-tcp", Windows: "loopback-tcp" });
		assert.match(String(result.unsupportedPlatform), /unsupported platform for the live worker stream: Plan9/);

		// Loopback, ephemeral port, and a per-attempt bearer token written mode 600.
		assert.equal(result.endpoint.backend, "loopback-tcp");
		assert.equal(result.endpoint.host, "127.0.0.1");
		assert.ok(Number(result.endpoint.port) > 0, `an ephemeral port was assigned: ${result.endpoint.port}`);
		assert.equal(result.tokenAppeared, true);
		// The descriptor is read by anyone polling for it, so it must never be observable half-written.
		// The counter below is best-effort - the write is fast enough that a poll often misses the window -
		// so atomicity is pinned by asserting how the file is published, which is deterministic.
		assert.equal(result.descriptorInvalidReads, 0, "no poll saw a half-written descriptor");
		assert.match(readFileSync(join(packageRoot, "scripts", "headless_supervisor.py"), "utf8"), /publish_private_file\(endpoint,/, "the endpoint descriptor is published by an atomic rename");
		assert.equal(/endpoint\.write_text\(/.test(readFileSync(join(packageRoot, "scripts", "headless_supervisor.py"), "utf8")), false, "and never by truncate-then-write");
		assert.match(readFileSync(join(packageRoot, "scripts", "stream_endpoint.py"), "utf8"), /publish_private_file\(token_path,/, "the bearer token is published the same way");
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

	test("a subscriber that stops reading loses its view rather than stalling the worker", () => {
		// The first implementation published with a blocking sendall on the drain thread, so a subscriber
		// that authenticated and stopped reading filled the socket buffer, held the drain thread and
		// backpressured the worker's PTY: the capture file froze mid-run and the worker never finished.
		// Verified as a real regression guard by reintroducing the blocking socket, which wedges the worker
		// for the full budget; with the non-blocking publish the same worker finishes in well under a second.
		const result = driver("stream-backpressure-driver.py");
		assert.equal(result.workerFinished, true, `the worker must finish while a subscriber stalls (${result.elapsedSeconds}s of ${result.budgetSeconds}s)`);
		assert.ok(result.elapsedSeconds < 30, `and must not merely scrape in under the budget: took ${result.elapsedSeconds}s`);
		assert.ok(result.captureBytes > 1_000_000, `the capture must hold the worker's full output, got ${result.captureBytes} bytes`);
	});

	test("output with no newline reaches the capture and the channel while the worker is still running", () => {
		// `read(size)` waited for 8 KB or EOF, and `readline` waits for a line ending, so a worker that prints
		// without one reached neither sink. The launcher prints and then waits for a gate file, so both
		// observations below are made while the worker provably cannot have exited.
		const result = driver("partial-line-driver.py");
		assert.equal(result.captureMarkerSeenWhileGated, true, "the capture must advance as the worker writes, not at a line ending");
		assert.equal(result.gateStillClosedWhenSeen, true, "and that must be observed while the worker cannot have exited");
		assert.equal(result.channelWhileRunning, "partial output with no newline", "the live channel publishes the unterminated remainder too");
		assert.equal(result.tailInChannel, "tail line\n", "and the line that follows arrives as a line");
		assert.equal(result.exitCode, 0);
		const drain = result.drain;
		assert.ok(drain.parts >= 2, `a long unterminated run is published as it arrives, not held until exit: ${JSON.stringify(drain)}`);
		assert.ok(drain.maxPartBytes <= drain.chunkLimit, `no published part may exceed one read: ${JSON.stringify(drain)}`);
		assert.equal(drain.carryWithheld, true, "a trailing carriage return waits for the next read rather than becoming a line ending of its own");
		assert.equal(drain.captureMatchesNormalized, true, "the capture keeps one newline where the PTY's CRLF straddled two reads");
		assert.equal(drain.partsConcatenationMatchesCapture, true, "and the channel's parts concatenate to the bytes the capture holds");
		const window = result.window;
		assert.ok(window.windowBytes <= window.cap + window.chunkBytes, `a late subscriber's window must stay bounded: ${JSON.stringify(window)}`);
		assert.equal(window.hasNewest, true, "the window keeps the most recent output");
		assert.equal(window.hasOldest, false, "and drops the oldest rather than growing with the worker");
	});

	test("an unbindable loopback is a named blocker before dispatch, not a worker that cannot be watched", () => {
		// EPERM on a fresh loopback bind is what a restricted host
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
