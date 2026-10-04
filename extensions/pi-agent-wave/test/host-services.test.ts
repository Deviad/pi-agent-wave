import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { attachHostServices, loadHostServices, parseHostServices } from "../lib/host-services.mjs";
import { runDoctor } from "../scripts/doctor.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const BROWSER = {
	description: "Throwaway headless Chromium; connect over CDP at $BROWSER_CDP_URL",
	start: { darwin: { executable: "/opt/browser/headless_shell", args: ["--remote-debugging-port={port}", "--user-data-dir={stateDir}"] } },
	env: { BROWSER_CDP_URL: "http://127.0.0.1:{port}" },
	readyTimeoutSeconds: 20,
};

describe("host service registry", () => {
	test("accepts a valid registry and resolves an attached service for its platform", () => {
		const services = parseHostServices({ services: { browser: BROWSER } });
		assert.deepEqual(attachHostServices(services, ["browser"], "darwin"), [{
			name: "browser",
			description: BROWSER.description,
			executable: "/opt/browser/headless_shell",
			args: ["--remote-debugging-port={port}", "--user-data-dir={stateDir}"],
			env: { BROWSER_CDP_URL: "http://127.0.0.1:{port}" },
			readyTimeoutSeconds: 20,
		}]);
		assert.equal(parseHostServices({ services: { db: { ...BROWSER, env: undefined, readyTimeoutSeconds: undefined } } })[0].readyTimeoutSeconds, 30);
	});

	test("an absent registry means no services", () => {
		assert.deepEqual(loadHostServices(join(scratch("host-services-absent-"), "host-services.jsonc")), []);
	});

	const invalid: [string, unknown, RegExp][] = [
		["no services map", { browser: BROWSER }, /registry: must be an object with a services map/],
		["a bad name", { services: { Browser: BROWSER } }, /service Browser: name must match/],
		["no description", { services: { browser: { ...BROWSER, description: " " } } }, /service browser\.description: is required/],
		["an unknown platform", { services: { browser: { ...BROWSER, start: { macos: BROWSER.start.darwin } } } }, /service browser\.start\.macos: platform must be one of darwin, linux, win32/],
		["a relative executable", { services: { browser: { ...BROWSER, start: { darwin: { executable: "headless_shell", args: [] } } } } }, /service browser\.start\.darwin\.executable: must be an absolute path/],
		["an unknown placeholder", { services: { browser: { ...BROWSER, start: { darwin: { executable: "/x", args: ["--dir={home}"] } } } } }, /service browser\.start\.darwin\.args\[0\]: unknown placeholder \{home\}/],
		["a reserved variable", { services: { browser: { ...BROWSER, env: { PATH: "/x" } } } }, /service browser\.env\.PATH: is reserved/],
		["a PI_ variable", { services: { browser: { ...BROWSER, env: { PI_ACPX_CONFIG: "/x" } } } }, /service browser\.env\.PI_ACPX_CONFIG: is reserved/],
		["a lower-case variable", { services: { browser: { ...BROWSER, env: { cdp: "x" } } } }, /service browser\.env\.cdp: name must match/],
		["an out-of-range timeout", { services: { browser: { ...BROWSER, readyTimeoutSeconds: 0 } } }, /service browser\.readyTimeoutSeconds: must be an integer from 1 to 120/],
	];
	for (const [label, document, message] of invalid) {
		test(`refuses ${label}, naming the service and field`, () => {
			assert.throws(() => parseHostServices(document), message);
		});
	}

	test("attaching refuses an unknown, repeated or unavailable service", () => {
		const services = parseHostServices({ services: { browser: BROWSER } });
		assert.throws(() => attachHostServices(services, ["db"], "darwin"), /service db: is not registered \(registered: browser\)/);
		assert.throws(() => attachHostServices(services, ["browser", "browser"], "darwin"), /service browser: is attached twice/);
		assert.throws(() => attachHostServices(services, ["browser"], "linux"), /service browser: has no start entry for linux/);
	});
});

// A route with no credential anywhere: a dispatch that passes validation stops at the worker preflight,
// which is how an accepted attachment is observed without spending a model.
const DEAD_ROUTE = "nosuchproviderxyz/dead-route";
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

async function toolIn(dir: string, invocations: { command: string; args: string[] }[]): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.PI_HOST_SERVICES;
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models: [DEAD_ROUTE], thinking: "off", session: true } },
		roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
	}));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "host-services.jsonc"), `// operator registry\n${JSON.stringify({ services: { browser: { ...BROWSER, start: { [process.platform]: BROWSER.start.darwin } } } })}`);
	const { default: extension } = await import(`../index.ts?host-services=${Date.now()}-${Math.random()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		on() {},
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			invocations.push({ command, args: [...args] });
			const result = spawnSync(command, args, { encoding: "utf8", cwd: options?.cwd });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return tool;
}

/** A research run with its thinker pending, ready for op=dispatch. */
async function pendingThinker(tool: Record<string, any>): Promise<{ runId: string; operationId: string }> {
	const init = parsed(await tool.execute("init", { op: "init", story: "host-services", graph: "research", task: "Look something up" }, undefined, () => {}, {} as ExtensionContext));
	assert.equal(init.error, undefined, JSON.stringify(init));
	const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
	try {
		return { runId: init.state.runId, operationId: store.next(init.state.runId).operations[0].id };
	} finally { store.close(); }
}

function runDirsFor(runId: string): string[] {
	const token = `run-${runId.replace(/^run_/, "").slice(0, 8)}`;
	const runRoot = join(dirname(process.env.DELEGATE_GRAPH_DB!), "runs");
	return existsSync(runRoot) ? readdirSync(runRoot).filter((name) => name.includes(token)) : [];
}

describe("op=dispatch with host services", () => {
	const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, services: process.env.PI_HOST_SERVICES };
	afterEach(() => {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["DELEGATE_GRAPH_DB", saved.db], ["PI_HOST_SERVICES", saved.services]] as const) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});

	test("an unknown service is a parameter error: nothing is launched, created or recorded", async () => {
		const dir = scratch("host-services-dispatch-");
		const invocations: { command: string; args: string[] }[] = [];
		const tool = await toolIn(dir, invocations);
		const { runId, operationId } = await pendingThinker(tool);
		invocations.length = 0;
		const result = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless", hostServices: ["db"] }, undefined, () => {}, { cwd: dir } as ExtensionContext));
		assert.match(String(result.error), /host services: service db: is not registered \(registered: browser\)/);
		assert.equal(invocations.length, 0, "no launcher may run");
		assert.deepEqual(runDirsFor(runId), []);
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		try {
			const operation = store.getOperation(operationId);
			assert.equal(operation.status, "pending");
			assert.equal(operation.transient_attempts, 0);
		} finally { store.close(); }
	});

	test("a registered service reaches the launcher resolved for this platform", async () => {
		const dir = scratch("host-services-dispatch-");
		const invocations: { command: string; args: string[] }[] = [];
		const tool = await toolIn(dir, invocations);
		const { runId, operationId } = await pendingThinker(tool);
		invocations.length = 0;
		await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless", hostServices: ["browser"] }, undefined, () => {}, { cwd: dir } as ExtensionContext);
		const start = invocations.find((call) => call.args.includes("start"));
		assert.ok(start, "the launcher's start must run");
		const at = start.args.indexOf("--host-services-json");
		assert.ok(at > 0, "start receives --host-services-json");
		assert.deepEqual(JSON.parse(start.args[at + 1]), [{ name: "browser", description: BROWSER.description, executable: "/opt/browser/headless_shell", args: BROWSER.start.darwin.args, env: BROWSER.env, readyTimeoutSeconds: 20 }]);
	});
});

/** Runs prepare_acpx_attempt offline (no model is dispatched) and returns the launcher, prompt and resource. */
function prepare(extraArgv: readonly string[]): { launcher: string; serviceLauncher: string | null; prompt: string; resource: Record<string, unknown>; spec: unknown } {
	const workspace = realpathSync(scratch("host-services-prepare-ws-"));
	const privateDir = join(scratch("host-services-prepare-"), "private");
	mkdirSync(privateDir, { mode: 0o700 });
	const script = `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
core.ACTIVE_TRANSPORT = 'headless'
base, private = Path(sys.argv[2]), Path(sys.argv[3])
home = private / 'provider-home'
(home / '.codex').mkdir(parents=True)
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
os.environ['HOME'] = str(home)
os.environ['CODEX_HOME'] = str(home / '.codex')
os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
os.chdir(base)
model = 'openai-codex/gpt-5.6-sol'
argv = ['start', str(private), 'thinker', '--node', 'thinker_plan', '--model', model, '--access-mode', 'read-only'] + json.loads(sys.argv[4])
args = core.build_parser().parse_args(argv)
task = private / 'task.md'
task.write_text('Offline preparation fixture; do not dispatch a model.')
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'host-fixture'}, 'fixture-worker', model, task, 'thinker_plan')
spec = Path(resource['attempt_dir']) / 'host-services.json'
service = resource.get('service_launcher')
print(json.dumps({'launcher': Path(resource['worker_launcher']).read_text(), 'serviceLauncher': Path(service).read_text() if service else None, 'firstLauncher': core.first_launcher(resource), 'prompt': Path(resource['prompt_file']).read_text(), 'resource': {k: resource.get(k) for k in ('host_services', 'host_services_root', 'attempt_dir', 'worker_launcher', 'service_launcher')}, 'spec': json.loads(spec.read_text()) if spec.exists() else None}))
`;
	const result = spawnSync("python3", ["-c", script, new URL("../scripts", import.meta.url).pathname, workspace, privateDir, JSON.stringify(extraArgv)], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("launch preparation with host services", () => {
	const attached = [{ name: "browser", description: BROWSER.description, executable: "/opt/browser/headless_shell", args: BROWSER.start.darwin.args, env: BROWSER.env, readyTimeoutSeconds: 20 }];

	test("only the first launch runs beside the services; launch-acpx.sh, which later runs of the session reuse, is unchanged", () => {
		const plain = prepare([]);
		const withServices = prepare(["--host-services-json", JSON.stringify(attached)]) as ReturnType<typeof prepare> & { firstLauncher: string };
		assert.match(plain.launcher, /^#!\/bin\/sh\nexec \S*agentfs run /);
		assert.equal(plain.serviceLauncher, null);
		assert.equal((plain as typeof withServices).firstLauncher, plain.resource.worker_launcher);
		assert.equal(plain.prompt.includes("Host services"), false);
		assert.deepEqual(plain.resource.host_services, []);
		assert.equal(plain.resource.host_services_root, null);
		assert.equal(plain.spec, null);

		const attemptDir = String(withServices.resource.attempt_dir);
		const privateOf = (prepared: { resource: Record<string, unknown> }) => dirname(dirname(String(prepared.resource.attempt_dir)));
		// The session close after settlement runs worker_launcher again: it must never start the services a second time.
		assert.equal(
			withServices.launcher.replaceAll(privateOf(withServices), "<private>"),
			plain.launcher.replaceAll(privateOf(plain), "<private>"),
			"launch-acpx.sh is identical with and without services",
		);
		assert.equal(withServices.firstLauncher, join(attemptDir, "launch-with-host-services.sh"));
		assert.equal(withServices.serviceLauncher, `#!/bin/sh\nexec ${withServices.serviceLauncher!.split(" ")[1]} ${withServices.serviceLauncher!.split(" ")[2]} --spec ${join(attemptDir, "host-services.json")} --state-root ${join(attemptDir, "host-services")} -- ${withServices.resource.worker_launcher}\n`);
		assert.match(withServices.serviceLauncher!, /^#!\/bin\/sh\nexec \S*python\S* \S*host_service_launcher\.py /);
		assert.deepEqual(withServices.spec, attached);
		assert.deepEqual(withServices.resource.host_services, ["browser"]);
		assert.equal(withServices.resource.host_services_root, join(attemptDir, "host-services"));
		assert.match(withServices.prompt, /Host services: the following run on the host, outside your sandbox/);
		assert.match(withServices.prompt, /- browser: Throwaway headless Chromium; connect over CDP at \$BROWSER_CDP_URL \(endpoint variables: \$BROWSER_CDP_URL\)/);
		const servicesParagraph = withServices.prompt.slice(withServices.prompt.indexOf("Host services"));
		assert.equal(/\/opt\/browser|\{port\}|127\.0\.0\.1|\/tmp\/|\/Users\//.test(servicesParagraph), false, "no path or port reaches the worker");
	});

	test("refuses a malformed service list", () => {
		assert.throws(() => prepare(["--host-services-json", JSON.stringify([{ ...attached[0], executable: "relative" }])]), /invalid service/);
	});
});

describe("doctor: host services", () => {
	test("reports none, an invalid registry, a missing executable, and a usable registry", () => {
		const agentDir = scratch("host-services-doctor-");
		const saved = process.env.PI_HOST_SERVICES;
		delete process.env.PI_HOST_SERVICES;
		const capability = () => runDoctor(["--agent-dir", agentDir]).checks.find((entry: { check: string }) => entry.check === "host-services");
		try {
			assert.deepEqual(capability(), { check: "host-services", status: "ok", detail: "none registered" });
			const registry = join(agentDir, "host-services.jsonc");
			writeFileSync(registry, JSON.stringify({ services: { Browser: BROWSER } }));
			assert.equal(capability()?.status, "warn");
			assert.match(capability()?.detail ?? "", /service Browser: name must match/);
			writeFileSync(registry, JSON.stringify({ services: { browser: { ...BROWSER, start: { [process.platform]: { executable: join(agentDir, "absent"), args: [] } } } } }));
			assert.deepEqual(capability(), { check: "host-services", status: "warn", detail: "executable missing on this host for: browser" });
			writeFileSync(registry, JSON.stringify({ services: { browser: { ...BROWSER, start: { [process.platform]: { executable: process.execPath, args: [] } } } } }));
			assert.deepEqual(capability(), { check: "host-services", status: "ok", detail: `1 registered, 1 with a start entry for ${process.platform}` });
			assert.equal(readFileSync(registry, "utf8").includes(process.execPath), true, "doctor never rewrites the registry");
		} finally {
			if (saved === undefined) delete process.env.PI_HOST_SERVICES; else process.env.PI_HOST_SERVICES = saved;
		}
	});
});
