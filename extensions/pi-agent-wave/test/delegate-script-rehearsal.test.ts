import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateInvocation, selectTransport } from "../scripts/delegate.ts";
import { runDeferred } from "../scripts/deferred-runner.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("TypeScript Delegate Graph script rehearsal", () => {
	test("selects optional Herdr only with verified workspace identity", () => {
		const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace:1", HERDR_TAB_ID: "tab:1" } as NodeJS.ProcessEnv;
		assert.equal(selectTransport(env, "auto", (name) => name === "herdr"), "herdr");
		assert.equal(selectTransport(env, "herdr", (name) => name === "herdr"), "herdr");
		assert.equal(selectTransport({}, "auto", () => false), "headless");
		assert.throws(() => Reflect.apply(selectTransport, undefined, [env, "panel", () => true]), /unsupported worker transport/);
	});

	test("builds direct headless and Herdr argv invocations without Bash", () => {
		const headless = delegateInvocation("headless", ["start", "run", "reviewer"]);
		assert.equal(headless.file, "python3");
		assert.ok(headless.args[0].endsWith("headless_delegate.py"));
		const herdr = delegateInvocation("herdr", ["start", "run", "reviewer"]);
		assert.equal(herdr.file, "python3");
		assert.ok(herdr.args[0].endsWith("herdr_delegate.py"));
		assert.deepEqual(herdr.args.slice(1), ["start", "run", "reviewer"]);
		assert.ok(!JSON.stringify(herdr).includes("bash -lc"));
	});

	test("renders concise operational command and report-repair prompts without workflow duplication", () => {
		const helper = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));
		const command = JSON.stringify({ executable: "node", args: ["/opt/search.mjs", "--source", "linkedin"], cwd: "/work" });
		const commandProbe = spawnSync("python3", ["-c", "import runpy,sys; print(runpy.run_path(sys.argv[1])['operational_instruction'](sys.argv[2]))", helper, command], { encoding: "utf8" });
		assert.equal(commandProbe.status, 0, commandProbe.stderr);
		assert.match(commandProbe.stdout, /first execution command/);
		assert.match(commandProbe.stdout, /\["node", "\/opt\/search\.mjs", "--source", "linkedin"\]/);
		assert.doesNotMatch(commandProbe.stdout, /jh-doctor|cdp-preflight|salary|scoring/);
		const reportPrompt = fileURLToPath(new URL("../scripts/report-prompt.ts", import.meta.url));
		const repair = spawnSync("node", ["--experimental-strip-types", reportPrompt, "--node", "source_search", "--report", "/tmp/report.json", "--repair-json", JSON.stringify([{ code: "EXECUTION_REQUIRED", path: "$.execution", message: "missing" }])], { encoding: "utf8" });
		assert.equal(repair.status, 0, repair.stderr);
		assert.equal(repair.stdout.length < 2_000, true);
		assert.match(repair.stdout, /EXECUTION_REQUIRED|execution/);
		assert.doesNotMatch(repair.stdout, /Read and execute the complete assigned task|jh-doctor|cdp-preflight/);
	});

	test("deferred runner propagates Pi exit and removes its plist", () => {
		const dir = mkdtempSync(join(tmpdir(), "deferred-runner-"));
		dirs.push(dir);
		const plist = join(dir, "job.plist");
		const log = join(dir, "launchctl.log");
		writeFileSync(plist, "fixture");
		const pi = join(dir, "pi");
		writeFileSync(pi, "#!/usr/bin/env node\nprocess.exit(7);\n", { mode: 0o755 });
		chmodSync(pi, 0o755);
		const launchctl = join(dir, "launchctl");
		writeFileSync(launchctl, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n');\n`, { mode: 0o755 });
		chmodSync(launchctl, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}:${previousPath}`;
		try {
			assert.equal(runDeferred(["--uid", "501", "--label", "dg.test", "--plist", plist, "--pi", pi, "--prompt", "resume run"]), 7);
		} finally {
			process.env.PATH = previousPath;
		}
		assert.equal(existsSync(plist), false);
		assert.equal(readFileSync(log, "utf8").trim(), "bootout gui/501/dg.test");
	});
});
