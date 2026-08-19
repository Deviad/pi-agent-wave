import { describe, expect, test } from "./test-api.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONS = ["0.84.1", "0.84.2"];

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 120_000 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

async function pack(root: string): Promise<string> {
	const destination = join(root, "artifact");
	await mkdir(destination, { recursive: true });
	const output = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: ROOT }));
	return join(destination, output[0].filename);
}

async function seedRuntimeConfig(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "model-routing.jsonc"), `${JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models: ["fixture/local"], thinking: "off", session: false } },
		roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])),
	}, null, 2)}\n`);
	await writeFile(join(agentDir, "models.json"), `${JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1" } } }, null, 2)}\n`);
}

async function seedNpmAgentDir(agentDir: string): Promise<void> {
	await seedRuntimeConfig(agentDir);
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:@dpugliese/pi-agent-wave"] }, null, 2)}\n`);
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("failed to allocate loopback port"));
			server.close(() => resolvePort(address.port));
		});
	});
}

async function createGitFixture(root: string) {
	const source = join(root, "git-source");
	await cp(ROOT, source, { recursive: true, filter: (path) => !path.includes(`${join(ROOT, "node_modules")}/`) && !path.includes(`${join(ROOT, ".git")}/`) });
	run("git", ["init", "--initial-branch=main"], { cwd: source });
	run("git", ["config", "user.name", "pi-agent-wave rehearsal"], { cwd: source });
	run("git", ["config", "user.email", "rehearsal@localhost"], { cwd: source });
	run("git", ["add", "."], { cwd: source });
	run("git", ["commit", "-m", "rehearsal package"], { cwd: source });
	const commit = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();
	const served = join(root, "git-served");
	await mkdir(served, { recursive: true });
	const repository = join(served, "owner", "repo.git");
	await mkdir(dirname(repository), { recursive: true });
	run("git", ["clone", "--bare", source, repository]);
	run("git", ["update-server-info"], { cwd: repository });
	const port = await freePort();
	const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", served], { stdio: "ignore" });
	const url = `http://127.0.0.1:${port}/owner/repo.git`;
	for (let attempt = 0; attempt < 50; attempt++) {
		const probe = spawnSync("git", ["ls-remote", url], { encoding: "utf8" });
		if (probe.status === 0) return { server, url, commit };
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	server.kill();
	throw new Error("loopback Git HTTP server did not become ready");
}

async function findInstalledGitPackage(root: string): Promise<string> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (!entry.isDirectory()) continue;
		try {
			const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
			if (manifest.name === "@dpugliese/pi-agent-wave") return path;
		} catch {}
		const nested = await findInstalledGitPackage(path).catch(() => undefined);
		if (nested) return nested;
	}
	throw new Error(`installed Git package not found under ${root}`);
}

async function loadPackage(piRoot: string, packageRoot: string, agentDir: string, cwd: string, home: string) {
	const pi = await import(`${pathToFileURL(join(piRoot, "dist", "index.js")).href}?agent=${encodeURIComponent(agentDir)}`);
	const settingsManager = pi.SettingsManager.create(cwd, agentDir);
	const loader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	const previous = { ...process.env };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_MODEL_ROUTING = join(agentDir, "model-routing.jsonc");
	process.env.PI_MODEL_CATALOG = join(agentDir, "models.json");
	try {
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(4);
		expect(loaded.extensions.every((extension: any) => extension.resolvedPath.startsWith(packageRoot))).toBe(true);
		const tools = loaded.extensions.flatMap((extension: any) => [...extension.tools.keys()]);
		const commands = loaded.extensions.flatMap((extension: any) => [...extension.commands.keys()]);
		expect(tools.filter((name: string) => name === "delegate_graph")).toHaveLength(1);
		expect(tools.filter((name: string) => name === "questionnaire")).toHaveLength(1);
		for (const command of ["delegate", "graph", "route", "failover"]) expect(commands.filter((name: string) => name === command)).toHaveLength(1);

		const policyScript = join(packageRoot, "scripts", "policy-resolver.mjs");
		const policyProbe = spawnSync("node", [policyScript, "--input", JSON.stringify({ kind: "model", model: "fixture/local", reason: "installation rehearsal" })], { cwd, env: process.env, encoding: "utf8" });
		expect(policyProbe.status).toBe(0);
		expect(policyProbe.stdout.trim()).not.toBe("");
		const graphExtension = loaded.extensions.find((extension: any) => extension.tools.has("delegate_graph"));
		const tool = graphExtension.tools.get("delegate_graph").definition;
		const ctx = { cwd, mode: "json", hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionFile: () => undefined } };
		const story = `install-${agentDir.split("/").pop()}`;
		const initialized = await tool.execute("install-rehearsal", { op: "init", story, graph: "research", task: "bounded package initialization", modelPolicy: { kind: "model", model: "fixture/local", reason: "installation rehearsal" } }, undefined, undefined, ctx);
		const initialPayload = JSON.parse(initialized.content[0].text);
		if (!initialPayload.state?.runId) throw new Error(`bounded initialization failed: ${initialized.content[0].text}`);
		expect(typeof initialPayload.state.runId).toBe("string");
		expect(initialPayload.state.runId.length > 0).toBe(true);
		const status = await tool.execute("status-rehearsal", { op: "status", runId: initialPayload.state.runId }, undefined, undefined, ctx);
		expect(status.content[0].text).toContain(initialPayload.state.runId);
		return { loaded, runId: initialPayload.state.runId };
	} finally {
		process.env = previous;
	}
}

const installTest = (globalThis as any).Bun ? test.skip : test;

describe("isolated package installation", () => {
	installTest("the exact npm tarball and supported Git source load on Pi 0.84.1 and 0.84.2", { timeout: 300_000 }, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-wave-install-"));
		let gitServer: ReturnType<typeof spawn> | undefined;
		let failure: unknown;
		try {
			const tarball = await pack(root);
			const gitFixture = await createGitFixture(root);
			gitServer = gitFixture.server;
			for (const version of VERSIONS) {
				const cell = join(root, version);
				const agentDir = join(cell, "agent");
				const npmRoot = join(agentDir, "npm");
				const home = join(cell, "home");
				await mkdir(npmRoot, { recursive: true });
				await mkdir(home, { recursive: true });
				await writeFile(join(npmRoot, "package.json"), '{"private":true}\n');
				run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, `@earendil-works/pi-coding-agent@${version}`], { cwd: npmRoot });
				await seedNpmAgentDir(agentDir);
				const migrationBin = join(npmRoot, "node_modules", ".bin", "pi-agent-wave-migrate");
				const migrationPlan = JSON.parse(run(migrationBin, ["--agent-dir", agentDir, "--backup-id", "installed-bin-probe"], { cwd: cell }));
				expect(migrationPlan.mode).toBe("dry-run");
				const packageRoot = join(npmRoot, "node_modules", "@dpugliese", "pi-agent-wave");

				// The initializer and doctor bins must be present, executable, and functional.
				const initBin = join(npmRoot, "node_modules", ".bin", "pi-agent-wave-init");
				const doctorBin = join(npmRoot, "node_modules", ".bin", "pi-agent-wave-doctor");
				const initProbeDir = join(cell, "init-probe-agent");
				await mkdir(initProbeDir, { recursive: true });
				await writeFile(join(initProbeDir, "models.json"), `${JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "local", name: "Local", contextWindow: 128000 }] } } }, null, 2)}\n`);
				const tierFlags = ["--tools", "fixture/local", "--coding", "fixture/local", "--test", "fixture/local", "--review", "fixture/local", "--reasoning", "fixture/local", "--long-context", "fixture/local"];
				const initPlan = JSON.parse(run(initBin, ["--agent-dir", initProbeDir, ...tierFlags], { cwd: cell }));
				expect(initPlan.mode).toBe("dry-run");
				expect(existsSync(join(initProbeDir, "model-routing.jsonc"))).toBe(false);
				const applied = JSON.parse(run(initBin, ["apply", "--agent-dir", initProbeDir, ...tierFlags], { cwd: cell }));
				expect(applied.ok).toBe(true);
				expect(existsSync(join(initProbeDir, "model-routing.jsonc"))).toBe(true);
				const doctorResult = JSON.parse(run(doctorBin, ["--agent-dir", initProbeDir, "--json"], { cwd: cell }));
				expect(doctorResult.ok).toBe(true);

				const piRoot = join(npmRoot, "node_modules", "@earendil-works", "pi-coding-agent");
				await loadPackage(piRoot, packageRoot, agentDir, cell, home);

				const gitAgentDir = join(cell, "git-agent");
				const gitHome = join(cell, "git-home");
				await mkdir(gitHome, { recursive: true });
				await seedRuntimeConfig(gitAgentDir);
				const piBinary = join(npmRoot, "node_modules", ".bin", "pi");
				const env = {
					...process.env,
					HOME: gitHome,
					PI_CODING_AGENT_DIR: gitAgentDir,
					GIT_TERMINAL_PROMPT: "0",
					PATH: `${join(npmRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
				};
				run(piBinary, ["install", `${gitFixture.url}@${gitFixture.commit}`, "--approve"], { cwd: cell, env });
				const gitSettings = JSON.parse(await readFile(join(gitAgentDir, "settings.json"), "utf8"));
				expect(gitSettings.packages).toHaveLength(1);
				expect(String(gitSettings.packages[0])).toContain(gitFixture.url);
				const gitPackageRoot = await findInstalledGitPackage(join(gitAgentDir, "git"));
				await loadPackage(piRoot, gitPackageRoot, gitAgentDir, cell, gitHome);
			}
		} catch (error) {
			failure = error;
		} finally {
			gitServer?.kill();
			await rm(root, { recursive: true, force: true });
		}
		expect(existsSync(root)).toBe(false);
		expect(gitServer?.killed).toBe(true);
		if (failure) throw failure;
	});
});
