import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import delegateGraphExtension from "../index.ts";
import { requireAgentFs } from "../require-agentfs.ts";

const originalEnv = { ...process.env };
const directories: string[] = [];
afterEach(() => {
	process.env = { ...originalEnv };
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(directory: string, name: string, output: string): void {
	const path = join(directory, name);
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function registrationTrap(): ExtensionAPI {
	return new Proxy({}, { get(_target, property) { throw new Error(`registration attempted through ${String(property)}`); } }) as ExtensionAPI;
}

describe("mandatory AgentFS prerequisite", () => {
	test("uses a direct executable argv boundary", () => {
		const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
		requireAgentFs({}, (command, args, options) => {
			calls.push({ command, args, shell: options.shell });
			return { pid: 1, output: [null, "agentfs v0.6.4\n", ""], stdout: "agentfs v0.6.4\n", stderr: "", status: 0, signal: null };
		});
		assert.deepEqual(calls, [{ command: "agentfs", args: ["--version"], shell: false }]);
	});

	test("fails before registration when AgentFS is missing or mismatched", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-wave-agentfs-"));
		directories.push(directory);
		executable(directory, "herdr", "herdr 0.8.0");
		executable(directory, "acpx", "0.13.2");
		process.env.PATH = directory;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "workspace:test";
		process.env.HERDR_TAB_ID = "tab:test";
		assert.throws(() => delegateGraphExtension(registrationTrap()), /requires AgentFS 0\.6\.4/);
		executable(directory, "agentfs", "agentfs v0.6.3");
		assert.throws(() => delegateGraphExtension(registrationTrap()), /requires AgentFS 0\.6\.4; found 0\.6\.3/);
	});
});
