import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparationFixture, prepared } from "./support/workspace-preparation-fixture.ts";
import { revokeWorkspaceRecipe, workspaceRecipeStatus } from "../lib/workspace-preparation.ts";

test("unapproved recipe executes no command", async () => {
	const fx = preparationFixture();
	try {
		await assert.rejects(fx.prepare(), /approval.*approve/);
		assert.deepEqual(fx.events(), []);
		fx.approve(); revokeWorkspaceRecipe(fx.agentDir, fx.workspace);
		await assert.rejects(fx.prepare(), /approval/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("changed recipe requires renewed approval", async () => {
	const fx = preparationFixture();
	try {
		fx.approve(); fx.save({ ...fx.recipe, timeoutMs: 20_000 });
		assert.equal(workspaceRecipeStatus(fx.agentDir, fx.workspace).approved, false);
		await assert.rejects(fx.prepare(), /approval/);
		assert.deepEqual(fx.events(), []);
		fx.approve(); await prepared(fx);
	} finally { fx.cleanup(); }
});

test("approved recipe is selected by canonical workspace", async () => {
	const fx = preparationFixture();
	try {
		const alias = join(fx.root, "workspace-alias");
		symlinkSync(fx.workspace, alias, "dir");
		fx.approve();
		const result = await prepared(fx, { workspace: alias });
		assert.equal(result.workspace, fx.workspace);
	} finally { fx.cleanup(); }
});

test("unchanged preparation is reused", async () => {
	const fx = preparationFixture();
	try {
		fx.approve(); await prepared(fx);
		const reused = await prepared(fx);
		assert.equal(reused.reused, true);
		assert.deepEqual(fx.events(), ["install", "baseline"]);
		await prepared(fx, { runId: "run-two" });
		assert.deepEqual(fx.events(), ["install", "baseline", "install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("changed lockfile invalidates readiness", async () => {
	const fx = preparationFixture();
	try {
		fx.approve(); await prepared(fx);
		const lock = join(fx.workspace, "package-lock.json");
		writeFileSync(lock, readFileSync(lock, "utf8") + "\n");
		await prepared(fx);
		assert.deepEqual(fx.events(), ["install", "baseline", "install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("deleted dependency invalidates readiness", async () => {
	const fx = preparationFixture();
	try {
		fx.approve(); await prepared(fx);
		rmSync(join(fx.workspace, "node_modules"), { recursive: true });
		await prepared(fx);
		assert.deepEqual(fx.events(), ["install", "baseline", "install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("repository script changes invalidate command approval", async () => {
	const fx = preparationFixture();
	try {
		const script = "baseline.cjs";
		writeFileSync(join(fx.workspace, script), "require('preparation-local');\n");
		fx.save({ ...fx.recipe, baseline: [{ executable: process.execPath, args: [script] }], scriptInputs: [script] });
		fx.approve(); writeFileSync(join(fx.workspace, script), "process.exit(0);\n");
		await assert.rejects(fx.prepare(), /approval/);
		fx.save({ ...fx.recipe, scriptInputs: [] });
		assert.throws(fx.approve, /scriptInputs/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("argv containing spaces and metacharacters arrives unchanged", async () => {
	const fx = preparationFixture();
	try {
		const argv = ["space inside", "$(touch source.ts)", ";exit 19", "'quoted'", "*", "a\nb"];
		fx.save({ ...fx.recipe, baseline: [{ executable: process.execPath, args: ["-e", "require('fs').writeFileSync('.preparation-scratch/argv', JSON.stringify(process.argv.slice(1)))", ...argv] }] });
		fx.approve(); await prepared(fx);
		assert.deepEqual(JSON.parse(readFileSync(join(fx.workspace, ".preparation-scratch/argv"), "utf8")), argv);
		assert.equal(readFileSync(join(fx.workspace, "source.ts"), "utf8"), "operator source\n");
	} finally { fx.cleanup(); }
});

test("preparation source mutation blocks launch", async () => {
	const fx = preparationFixture();
	try {
		fx.save({ ...fx.recipe, baseline: [fx.node("require('fs').writeFileSync('source.ts', 'unexpected write')")] });
		fx.approve(); await assert.rejects(fx.prepare(), /source.*source.ts/);
		assert.equal(readFileSync(join(fx.workspace, "source.ts"), "utf8"), "unexpected write");
	} finally { fx.cleanup(); }
});

for (const outcome of ["failure", "timeout", "cancellation"] as const) {
	test(`real preparation ${outcome} retains bounded diagnostics and no success receipt`, async () => {
		const fx = preparationFixture();
		try {
			fx.approve(); await prepared(fx);
			fx.save({ ...fx.recipe, install: [], baseline: [fx.node(outcome === "failure" ? "process.stdout.write('x'.repeat(200000));process.exit(7)" : "console.log('waiting');setInterval(()=>{},1000)")], timeoutMs: outcome === "timeout" ? 5000 : 30_000 });
			fx.approve();
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await assert.rejects(fx.prepare({ signal: controller.signal, progress: (phase) => { if (outcome === "cancellation" && phase === "baseline") timer = setTimeout(() => controller.abort(), 100); } }), (error: Error & { diagnosticsPath?: string; phase?: string }) => {
					assert.equal(error.phase, "baseline");
					assert.match(error.message, new RegExp(outcome === "failure" ? "exited 7" : outcome === "cancellation" ? "cancelled" : "timeout"));
					assert.ok(error.diagnosticsPath && existsSync(error.diagnosticsPath));
					assert.ok(readFileSync(error.diagnosticsPath!).length < 80_000);
					return true;
				});
			} finally { if (timer) clearTimeout(timer); }
			const receipts = join(fx.workspace, ".git/pi-agent-wave-preparation/receipts");
			for (const file of readdirSync(receipts)) assert.equal(JSON.parse(readFileSync(join(receipts, file), "utf8")).ready, false);
		} finally { fx.cleanup(); }
	});
}

test("success after baseline failure avoids duplicate successful installation", async () => {
	const fx = preparationFixture();
	try {
		fx.save({ ...fx.recipe, baseline: [fx.node("const fs=require('fs'); if(!fs.existsSync('.preparation-scratch/allow'))process.exit(9);fs.appendFileSync('.preparation-scratch/events','baseline\\n')")] });
		fx.approve(); await assert.rejects(fx.prepare(), /baseline.*exited 9/);
		writeFileSync(join(fx.workspace, ".preparation-scratch/allow"), "yes");
		await prepared(fx);
		assert.deepEqual(fx.events(), ["install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("real subprocess overlap never installs concurrently and never clears a live lock", async () => {
	const fx = preparationFixture();
	try {
		fx.save({ ...fx.recipe, install: [fx.node("require('fs').writeFileSync('.preparation-scratch/started','yes');setTimeout(()=>{},2000)")], baseline: [], readiness: fx.node("process.exit(0)") });
		fx.approve();
		const module = fileURLToPath(new URL("../lib/workspace-preparation.ts", import.meta.url));
		const source = `import {prepareWorkspace} from ${JSON.stringify(module)};const g=await prepareWorkspace(${JSON.stringify({ workspace: fx.workspace, agentDir: fx.agentDir, dbPath: join(fx.root, "graph.db"), runId: "subprocess-run", operationId: "subprocess-op" })});g.release();`;
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
		const completed = new Promise<number | null>((resolve) => child.once("close", resolve));
		try {
			for (let count = 0; count < 100 && !existsSync(join(fx.workspace, ".preparation-scratch/started")); count++) await new Promise((resolve) => setTimeout(resolve, 20));
			assert.ok(existsSync(join(fx.workspace, ".preparation-scratch/started")));
			await assert.rejects(fx.prepare(), /busy.*retry/);
			assert.equal(await completed, 0);
		} finally { if (child.exitCode === null) child.kill("SIGKILL"); await completed; }
	} finally { fx.cleanup(); }
});

test("AgentFS inherits the actual host-installed local npm dependency", async () => {
	const fx = preparationFixture();
	try {
		fx.approve(); await prepared(fx);
		const result = spawnSync("agentfs", ["run", process.execPath, "-e", "require('assert').equal(require('preparation-local'),'loaded-real-package');console.log('dependency inherited')"], { cwd: fx.workspace, env: { ...process.env, HOME: fx.root, AGENTFS_HOME: fx.root }, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /dependency inherited/);
	} finally { fx.cleanup(); }
});

test("operator CLI approval is separate from repository data and explicitly requires host access", () => {
	const fx = preparationFixture();
	try {
		const cli = fileURLToPath(new URL("../scripts/workspace-preparation.ts", import.meta.url));
		const invoke = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: fx.agentDir }, encoding: "utf8" });
		assert.equal(invoke("approve", "--workspace", fx.workspace).status, 1);
		assert.equal(workspaceRecipeStatus(fx.agentDir, fx.workspace).approved, false);
		const approved = invoke("approve", "--workspace", fx.workspace, "--host-access");
		assert.equal(approved.status, 0, approved.stderr);
		assert.equal(JSON.parse(approved.stdout).approved, true);
		assert.equal(invoke("status", "--workspace", fx.workspace).status, 0);
		assert.equal(invoke("revoke", "--workspace", fx.workspace).status, 0);
		assert.equal(workspaceRecipeStatus(fx.agentDir, fx.workspace).approved, false);
	} finally { fx.cleanup(); }
});

test("changed npm script definitions require renewed approval but dependency versions do not", async () => {
	const fx = preparationFixture();
	try {
		fx.approve();
		const path = join(fx.workspace, "package.json");
		const pkg = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...pkg, dependencies: { "preparation-local": "file:./local-package-v2" } }));
		assert.equal(workspaceRecipeStatus(fx.agentDir, fx.workspace).approved, true);
		writeFileSync(path, JSON.stringify({ ...pkg, scripts: { baseline: "node malicious.cjs" } }));
		await assert.rejects(fx.prepare(), /approval/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("a missing successful phase diagnostic invalidates the receipt on resume", async () => {
	const fx = preparationFixture();
	try {
		fx.approve();
		const result = await prepared(fx);
		const receipt = JSON.parse(readFileSync(result.receiptPath!, "utf8"));
		rmSync(join(fx.workspace, ".git/pi-agent-wave-preparation", receipt.baselineEvidence[0]));
		await prepared(fx);
		assert.deepEqual(fx.events(), ["install", "baseline", "install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("an unconfirmed launch blocks refresh instead of inferring that no worker exists", async () => {
	const fx = preparationFixture();
	try {
		fx.approve();
		const guard = await fx.prepare();
		guard.beginLaunch(); guard.retainLaunch(); guard.release();
		await assert.rejects(fx.prepare({ runId: "another-run" }), /graph database missing.*reconcile launch/);
		assert.deepEqual(fx.events(), ["install", "baseline"]);
	} finally { fx.cleanup(); }
});

test("tracked source cannot be declared writable dependency state", async () => {
	const fx = preparationFixture();
	try {
		fx.save({ ...fx.recipe, writePaths: [...fx.recipe.writePaths, "source.ts"] });
		fx.approve();
		await assert.rejects(fx.prepare(), /writePaths covers tracked source/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("real npm install failure marks dependency state not ready", async () => {
	const fx = preparationFixture();
	try {
		fx.approve();
		const path = join(fx.workspace, "package.json");
		const pkg = JSON.parse(readFileSync(path, "utf8"));
		pkg.dependencies.unavailable = "1.0.0";
		writeFileSync(path, JSON.stringify(pkg));
		await assert.rejects(fx.prepare(), (error: Error & { phase?: string; diagnosticsPath?: string }) => {
			assert.equal(error.phase, "install");
			const diagnostic = JSON.parse(readFileSync(error.diagnosticsPath!, "utf8"));
			assert.equal(diagnostic.ok, false);
			assert.match(diagnostic.output, /npm error/);
			return true;
		});
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("repository data cannot grant preparation approval", async () => {
	const fx = preparationFixture();
	try {
		writeFileSync(join(fx.workspace, ".preparation-scratch/approval.json"), JSON.stringify({ approved: true, hostAccess: true }));
		await assert.rejects(fx.prepare(), /approval/);
		const registry = join(fx.agentDir, "workspace-preparation.jsonc");
		const repositoryRegistry = join(fx.workspace, ".preparation-scratch/registry.jsonc");
		writeFileSync(repositoryRegistry, readFileSync(registry), { mode: 0o600 });
		rmSync(registry); symlinkSync(repositoryRegistry, registry);
		assert.throws(fx.approve, /repository data cannot be.*authority registry/);
		await assert.rejects(fx.prepare(), /repository data cannot be.*authority registry/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});

test("extensionless repository executables must be pinned by script approval", async () => {
	const fx = preparationFixture();
	try {
		const executable = join(fx.workspace, "baseline-command");
		writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		fx.save({ ...fx.recipe, baseline: [{ executable, args: [] }] });
		assert.throws(fx.approve, /scriptInputs/);
		fx.save({ ...fx.recipe, scriptInputs: ["baseline-command"] });
		fx.approve();
		writeFileSync(executable, "#!/bin/sh\nexit 1\n");
		await assert.rejects(fx.prepare(), /approval/);
		assert.deepEqual(fx.events(), []);
	} finally { fx.cleanup(); }
});
