import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { attachHostServices, parseHostServices } from "../lib/host-services.mjs";

const LAUNCHER = new URL("../scripts/host_service_launcher.py", import.meta.url).pathname;
const SCRIPTS = new URL("../scripts", import.meta.url).pathname;
const PYTHON = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const AGENTFS = spawnSync("agentfs", ["--version"]).status === 0;

const dirs: string[] = [];
const strays: number[] = [];
afterEach(() => {
	for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}

/** A real loopback HTTP service on the port the launcher assigns, serving its private state directory. */
function httpService(name = "files") {
	return { name, description: "HTTP file server", executable: PYTHON, args: ["-m", "http.server", "--bind", "127.0.0.1", "{port}", "--directory", "{stateDir}"], env: { SVC_URL: "http://127.0.0.1:{port}" }, readyTimeoutSeconds: 20 };
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every process whose command line names `fragment`, which is how cleanup's absence audit finds owned processes. */
function processesNaming(fragment: string): string[] {
	return spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(fragment) && !line.includes("ps -axo"));
}

function writeSpec(dir: string, services: unknown[]): string {
	const spec = join(dir, "host-services.json");
	writeFileSync(spec, JSON.stringify(services));
	return spec;
}

/** The launcher around `agentfs run` with the worker's flags; HOME keeps AgentFS sessions out of the real home. */
function sandboxed(dir: string, command: string[]): string[] {
	return ["agentfs", "run", "--session", `dg-hs-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`, "--no-default-allows", "--allow", dir, ...command];
}

function runLauncher(dir: string, spec: string, worker: string[]) {
	return spawnSync(PYTHON, [LAUNCHER, "--spec", spec, "--state-root", join(dir, "host-services"), "--", ...worker], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir }, timeout: 120_000 });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
	return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs).unref())]);
}

function stopHostServices(root: string): string[] {
	const result = spawnSync(PYTHON, ["-c", "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport delegate_core as core\nprint(json.dumps(core.stop_host_services({'host_services_root': sys.argv[2]})))", SCRIPTS, root], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

/** A launcher whose worker records its pid and then waits, so a test can act on a live attempt. */
async function liveLauncher(dir: string): Promise<{ launcher: ReturnType<typeof spawn>; workerPid: number; servicePid: number; root: string }> {
	const root = join(dir, "host-services");
	const pidFile = join(dir, "worker.pid");
	const launcher = spawn(PYTHON, [LAUNCHER, "--spec", writeSpec(dir, [httpService()]), "--state-root", root, "--", "/bin/sh", "-c", `echo $$ > ${pidFile}; exec sleep 60`], { cwd: dir, stdio: "ignore" });
	strays.push(launcher.pid!);
	await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the worker to start");
	const workerPid = Number(readFileSync(pidFile, "utf8").trim());
	strays.push(workerPid);
	const [entry] = JSON.parse(readFileSync(join(root, "running.json"), "utf8"));
	strays.push(entry.pid);
	return { launcher, workerPid, servicePid: entry.pid, root };
}

describe("host service launcher", () => {
	test("a sandboxed worker reaches the service through its variable, and nothing is left afterwards", { skip: AGENTFS ? false : "needs agentfs" }, () => {
		const dir = scratch("dg-hs-reach-");
		const probe = "const r = await fetch(process.env.SVC_URL + '/'); console.log('status', r.status, process.env.AGENTFS_SANDBOX ?? 'none');";
		const result = runLauncher(dir, writeSpec(dir, [httpService()]), sandboxed(dir, [process.execPath, "--input-type=module", "-e", probe]));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^status 200 (macos-sandbox|\S+)$/m);
		assert.equal(/status 200 none/.test(result.stdout), false, "the worker ran inside agentfs");
		assert.equal(existsSync(join(dir, "host-services", "running.json")), false);
		assert.deepEqual(processesNaming(join(dir, "host-services")), []);
	});

	test("a service that never becomes ready stops the launch before the worker runs", () => {
		const dir = scratch("dg-hs-broken-");
		const marker = join(dir, "worker-ran");
		const broken = { name: "broken", description: "exits at once", executable: PYTHON, args: ["-c", "print('boom', flush=True); import sys; sys.exit(3)"], env: {}, readyTimeoutSeconds: 10 };
		const result = runLauncher(dir, writeSpec(dir, [httpService(), broken]), ["/usr/bin/touch", marker]);
		assert.equal(result.status, 70);
		assert.match(result.stderr, /host service broken did not become ready: exited with status 3; last log line: boom/);
		assert.equal(existsSync(marker), false, "the worker must not start");
		assert.equal(existsSync(join(dir, "host-services", "running.json")), false);
		assert.deepEqual(processesNaming(join(dir, "host-services")), [], "the service that did start is stopped too");
	});

	test("SIGTERM to the launcher stops the worker and every service", async () => {
		const dir = scratch("dg-hs-term-");
		const { launcher, workerPid, servicePid, root } = await liveLauncher(dir);
		assert.ok(alive(servicePid));
		const exited = new Promise<number | null>((resolve) => launcher.on("exit", (code) => resolve(code)));
		launcher.kill("SIGTERM");
		assert.equal(await within(exited, 10_000, "the launcher to exit after SIGTERM"), 128 + 15);
		assert.equal(alive(workerPid), false, "the worker received the forwarded signal");
		await waitFor(() => !alive(servicePid), "the service to stop", 2_000);
		assert.equal(existsSync(join(root, "running.json")), false);
	});

	test("after the launcher is killed outright, stop_host_services stops what it left", async () => {
		const dir = scratch("dg-hs-kill-");
		const { launcher, servicePid, root } = await liveLauncher(dir);
		const exited = new Promise((resolve) => launcher.on("exit", resolve));
		launcher.kill("SIGKILL");
		await exited;
		assert.ok(alive(servicePid), "a killed launcher cannot stop its service");
		assert.deepEqual(stopHostServices(root), []);
		await waitFor(() => !alive(servicePid), "the backstop to stop the service", 2_000);
		assert.equal(existsSync(join(root, "running.json")), false);
	});

	test("stop_host_services leaves alone a recorded pid that now runs something else", () => {
		const dir = scratch("dg-hs-reused-");
		const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		strays.push(bystander.pid!);
		writeFileSync(join(dir, "running.json"), JSON.stringify([{ name: "browser", pid: bystander.pid, started: "Thu Jan  1 00:00:00 1970", executable: "/bin/sleep" }]));
		assert.deepEqual(stopHostServices(dir), []);
		assert.ok(alive(bystander.pid!), "a reused pid is never signalled");
	});

	test("the absence audit reports a leaked service as an owned process", () => {
		const script = "import json, sys\nsys.path.insert(0, sys.argv[1])\nimport delegate_core as core\nattempt = sys.argv[2]\nresource = {'tab': '', 'acpx_session': 'dg-session', 'attempt_dir': attempt, 'acpx_home': attempt + '/acpx-home', 'agentfs_home': attempt + '/agentfs-home', 'agentfs_db_path': attempt + '/delta.db', 'provider_links': []}\nleaked = '4242 /opt/browser/headless_shell --user-data-dir=' + attempt + '/host-services/browser'\nprint(json.dumps(core.cleanup_absence_inventory(resource, '', False, False, leaked, '')['ownedProcessesAbsent']))";
		const result = spawnSync(PYTHON, ["-c", script, SCRIPTS, join(scratch("dg-hs-audit-"), "acpx", "worker")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout), false);
	});
});

const PLAYWRIGHT = join(homedir(), "Library", "Caches", "ms-playwright");
const HEADLESS_SHELL = existsSync(PLAYWRIGHT)
	? readdirSync(PLAYWRIGHT).filter((name) => name.startsWith("chromium_headless_shell-")).sort().map((name) => join(PLAYWRIGHT, name, "chrome-mac", "headless_shell")).find((path) => existsSync(path))
	: undefined;

describe("browser host service", () => {
	test("a worker inside agentfs drives the registered browser over CDP", { skip: AGENTFS && HEADLESS_SHELL ? false : "needs agentfs and Playwright's headless shell", timeout: 120_000 }, () => {
		const dir = scratch("dg-hs-browser-");
		const [browser] = attachHostServices(parseHostServices({ services: { browser: {
			description: "Throwaway headless Chromium; connect over CDP at $BROWSER_CDP_URL",
			start: { [process.platform]: { executable: HEADLESS_SHELL, args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port={port}", "--user-data-dir={stateDir}", "--no-first-run", "about:blank"] } },
			env: { BROWSER_CDP_URL: "http://127.0.0.1:{port}" },
		} } }), ["browser"]);
		writeFileSync(join(dir, "cdp.mjs"), `
const base = process.env.BROWSER_CDP_URL;
const target = (await (await fetch(base + "/json/list")).json()).find((entry) => entry.type === "page");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const replies = new Map();
socket.onmessage = (message) => { const data = JSON.parse(message.data); replies.get(data.id)?.(data); };
const call = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
await call(1, "Page.enable", {});
await call(2, "Page.navigate", { url: "data:text/html,<title>from-sandbox</title><p id=x>42</p>" });
await new Promise((resolve) => setTimeout(resolve, 300));
const evaluated = await call(3, "Runtime.evaluate", { expression: "document.title + ':' + document.getElementById('x').textContent", returnByValue: true });
socket.close();
console.log("evaluated " + evaluated.result.result.value + " in " + process.env.AGENTFS_SANDBOX);
`);
		const result = runLauncher(dir, writeSpec(dir, [browser]), sandboxed(dir, [process.execPath, join(dir, "cdp.mjs")]));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^evaluated from-sandbox:42 in macos-sandbox$/m);
		assert.deepEqual(processesNaming(join(dir, "host-services")), [], "the browser and its helpers are stopped");
	});
});
