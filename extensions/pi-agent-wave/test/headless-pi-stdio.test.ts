import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureAcpxSession, parseWorkerConfig } from "../scripts/acpx-worker.ts";

describe("headless Pi ACP stdio lifecycle", () => {
	test("retries only the exact stream-destroyed ensure transient once", () => {
		const root = mkdtempSync(join(tmpdir(), "acpx-ensure-retry-"));
		try {
			const executable = join(root, "fake-acpx.sh");
			const count = join(root, "count");
			writeFileSync(executable, `#!/bin/sh\nn=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); echo "$n" > '${count}'\nif [ "$n" -eq 1 ]; then printf '%s\\n' '{"error":{"message":"Cannot call write after a stream was destroyed"}}'; exit 1; fi\nprintf '%s\\n' '{"action":"session_ensured"}'\n`, { mode: 0o700 });
			chmodSync(executable, 0o700);
			const config = parseWorkerConfig({ schemaVersion: 1, acpxExecutable: executable, agent: "pi", selectedModel: "anthropic/claude-fable-5", sessionName: "retry", workspaceRelative: ".", node: "audit", reportPath: join(root, "report.json"), acpxHome: root, mode: "prompt", promptFile: join(root, "prompt.md"), resultPath: join(root, "result.json"), stdoutPath: join(root, "stdout"), stderrPath: join(root, "stderr"), timeoutSeconds: 5, hostReadOnly: true, discardAllChanges: true, noTerminal: false });
			writeFileSync(config.promptFile, "fixture");
			const retried = ensureAcpxSession(config, process.env);
			assert.equal(retried.exitCode, 0);
			assert.equal(retried.attempts, 2);
			writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' '{\"error\":{\"message\":\"different failure\"}}'\nexit 1\n", { mode: 0o700 });
			const failed = ensureAcpxSession(config, process.env);
			assert.equal(failed.exitCode, 1);
			assert.equal(failed.attempts, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("owns the detached process group, descriptors, result, and exit code", () => {
		const driver = join(process.cwd(), "extensions/pi-agent-wave/test/support/headless-pi-stdio-driver.py");
		const run = spawnSync("python3", [driver], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout);
		try {
			assert.ok(result.launchMs < 1_000, JSON.stringify(result));
			assert.equal(result.processGroupOwned, true);
			assert.equal(result.stdinBoundary, "private-pty");
			assert.equal(result.resultPersisted, true);
			assert.equal(result.exitCode, 7);
			assert.equal(result.stdout, "fixture stdout\nfixture stderr");
			assert.equal(result.stderr, "");
			assert.deepEqual(result.argv, [join(result.root, "fake-agentfs-acpx-worker.sh")]);
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	test("synthesizes execution-only worker settings instead of linking the supervisor's", () => {
		const script = [
			"import json, sys, tempfile",
			"from pathlib import Path",
			"sys.path.insert(0, 'extensions/pi-agent-wave/scripts')",
			"import delegate_core",
			"root = Path(tempfile.mkdtemp())",
			"real_home = root / 'home'; (real_home / '.pi' / 'agent').mkdir(parents=True)",
			"(real_home / '.pi' / 'agent' / 'auth.json').write_text(json.dumps({'anthropic': {'type': 'oauth', 'access': 'a', 'refresh': 'r', 'expires': 1}}))",
			"(real_home / '.pi' / 'agent' / 'settings.json').write_text(json.dumps({'defaultProvider': 'anthropic', 'defaultModel': 'claude-fable-5', 'defaultThinkingLevel': 'high', 'compaction': {'enabled': True}, 'retry': {'enabled': True}, 'packages': ['npm:x', '/abs/pi-agent-wave'], 'theme': 'dark', 'voice': {'enabled': True}}))",
			"attempt = root / 'attempt'; attempt.mkdir()",
			"acpx_home = root / 'acpx-home'; acpx_home.mkdir()",
			"class Fake: returncode = 0; stdout = json.dumps({'status': 'ready', 'provider': 'anthropic', 'authType': 'oauth'}); stderr = ''",
			"env, links = delegate_core.provider_runtime_environment(attempt, acpx_home, real_home, 'anthropic/claude-fable-5', command_runner=lambda argv: Fake())",
			"worker = attempt / 'providers' / 'pi-agent' / 'settings.json'",
			"parsed = json.loads(worker.read_text())",
			"print(json.dumps({'isSymlink': worker.is_symlink(), 'mode': oct(worker.stat().st_mode & 0o777), 'settings': parsed, 'inLinks': any(item['link'] == str(worker) for item in links), 'authLinked': (attempt / 'providers' / 'pi-agent' / 'auth.json').is_symlink(), 'authIsFile': (attempt / 'providers' / 'pi-agent' / 'auth.json').is_file(), 'authProviders': sorted(json.loads((attempt / 'providers' / 'pi-agent' / 'auth.json').read_text()).keys())}))",
		].join("\n");
		const run = spawnSync("python3", ["-c", script], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout);
		assert.equal(result.isSymlink, false);
		assert.equal(result.mode, "0o600");
		assert.equal(result.inLinks, false);
		assert.equal(result.authLinked, false, "the live credential file must never be linked into an attempt");
		assert.equal(result.authIsFile, true);
		assert.deepEqual(result.authProviders, ["anthropic"]);
		assert.deepEqual(result.settings, { compaction: { enabled: true }, defaultModel: "claude-fable-5", defaultProvider: "anthropic", defaultThinkingLevel: "high", packages: [], retry: { enabled: true } });
	});

	test("production launcher retains the AgentFS to acpx-worker argv and bounded diagnostics", () => {
		const source = readFileSync(join(process.cwd(), "extensions/pi-agent-wave/scripts/delegate_core.py"), "utf8");
		assert.ok(source.includes('shlex.quote(agentfs_executable), "run", "--session"'));
		assert.ok(source.includes('shlex.quote(str(ACPX_WORKER))'));
		assert.match(source, /stdin=subprocess\.DEVNULL/);
		assert.match(source, /start_new_session=True/);
		const supervisor = readFileSync(join(process.cwd(), "extensions/pi-agent-wave/scripts/headless_supervisor.py"), "utf8");
		assert.match(supervisor, /stdin=subprocess\.PIPE/);
		assert.match(supervisor, /worker\.wait\(\)/);
		assert.match(source, /headless worker exited before result/);
		assert.match(source, /diagnostic\[-2000:\]/);
	});
});
