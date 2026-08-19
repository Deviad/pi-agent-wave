import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { delegateInvocation, selectTransport } from "../scripts/delegate.ts";
import { runDeferred } from "../scripts/deferred-runner.ts";
import { PanelAdapter, type CommandRunner } from "../scripts/panel.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("TypeScript Delegate Graph script rehearsal", () => {
	test("prefers Herdr when its verified workspace identity is available", () => {
		const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace:1", HERDR_TAB_ID: "tab:1" } as NodeJS.ProcessEnv;
		assert.equal(selectTransport(env, "auto", (name) => name === "herdr"), "herdr");
		assert.equal(selectTransport({}, "auto", () => false), "panel");
		assert.equal(selectTransport(env, "panel", () => true), "panel");
		assert.throws(() => selectTransport({}, "herdr", () => false), /unavailable/);
	});

	test("builds direct argv invocations without Bash", () => {
		const herdr = delegateInvocation("herdr", ["start", "run", "reviewer"]);
		assert.equal(herdr.file, "python3");
		assert.ok(herdr.args[0].endsWith("herdr_delegate.py"));
		assert.deepEqual(herdr.args.slice(1), ["start", "run", "reviewer"]);
		const panel = delegateInvocation("panel", ["run", "--anchor", "%1"]);
		assert.equal(panel.file, process.execPath);
		assert.deepEqual(panel.args.slice(0, 2), ["--experimental-strip-types", panel.args[1]]);
		assert.ok(panel.args[1].endsWith("panel.ts"));
		assert.ok(!JSON.stringify([herdr, panel]).includes("bash -lc"));
	});

	test("preserves hostile text as one literal tmux argv", () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const runner: CommandRunner = (file, args) => { calls.push({ file, args }); return { status: 0, stdout: "", stderr: "" }; };
		const adapter = new PanelAdapter(runner, { PANEL_MUX: "tmux", PANEL_TMUX_BIN: "tmux -L test" });
		const hostile = "$(touch /tmp/no) 'quoted' \"double\"\nsecond line";
		adapter.send("%9", hostile);
		assert.deepEqual(calls[0], { file: "tmux", args: ["-L", "test", "send-keys", "-t", "%9", "-l", "--", hostile] });
	});

	test("runs spawn-send-check-capture-close in order and propagates success", () => {
		const dir = mkdtempSync(join(tmpdir(), "panel-rehearsal-"));
		dirs.push(dir);
		const log = join(dir, "calls.jsonl");
		const fake = join(dir, "fake-tmux.mjs");
		writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_LOG, JSON.stringify(args)+'\\n');
if(args.includes('split-window')) console.log('%9');
if(args.includes('capture-pane')) console.log('{"status":"ok"}');
`, { mode: 0o755 });
		chmodSync(fake, 0o755);
		const hostile = "printf '%s' \"$(not-executed)\"";
		const result = spawnSync(process.execPath, [
			"--experimental-strip-types", new URL("../scripts/panel.ts", import.meta.url).pathname,
			"run", "--anchor", "%1", "--polls", "1", "--interval", "0", "--", hostile,
		], { encoding: "utf8", env: { ...process.env, PANEL_MUX: "tmux", PANEL_TMUX_BIN: fake, FAKE_LOG: log } });
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		const names = calls.map((args) => args.find((arg) => ["split-window", "send-keys", "capture-pane", "kill-pane"].includes(arg)) ?? "other");
		assert.equal(names[0], "split-window");
		assert.ok(names.indexOf("send-keys") < names.indexOf("capture-pane"));
		assert.equal(names.at(-1), "kill-pane");
		const literal = calls.find((args) => args.includes("-l"));
		assert.ok(literal?.at(-1)?.endsWith(hostile));
		assert.ok(calls.every((args) => !args.includes("bash")));
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

	test("repairs one invalid panel report in the same pane", () => {
		const dir = mkdtempSync(join(tmpdir(), "panel-report-repair-"));
		dirs.push(dir);
		const log = join(dir, "calls.jsonl");
		const report = join(dir, "report.json");
		writeFileSync(report, "invalid", { mode: 0o644 });
		const fake = join(dir, "fake-tmux.mjs");
		writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_LOG, JSON.stringify(args)+'\\n');
if(args.includes('split-window')) console.log('%9');
if(args.includes('capture-pane')) console.log('{"status":"ok"}');
const payload=args.at(-1)||'';
if(payload.includes('Repair the same assigned JSON file once')) writeFileSync(process.env.FAKE_REPORT, JSON.stringify({schemaVersion:1,verdict:'PASS',claims:[{statement:'repaired',evidence:[{kind:'command',source:'fake tmux',detail:'same pane repair prompt observed'}],verification:'verified'}]}));
`, { mode: 0o755 });
		chmodSync(fake, 0o755);
		const result = spawnSync(process.execPath, [
			"--experimental-strip-types", new URL("../scripts/panel.ts", import.meta.url).pathname,
			"run", "--anchor", "%1", "--polls", "1", "--interval", "0",
			"--report", report, "--node", "review", "--private-root", dir, "--", "run task",
		], { encoding: "utf8", env: { ...process.env, PANEL_MUX: "tmux", PANEL_TMUX_BIN: fake, FAKE_LOG: log, FAKE_REPORT: report } });
		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
		assert.equal(calls.filter((args) => args.includes("capture-pane")).length, 3);
		assert.ok(calls.some((args) => args.at(-1)?.includes("JSON_PARSE")));
		assert.equal(JSON.parse(readFileSync(report, "utf8")).verdict, "PASS");
	});
});
