import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import delegateGraphExtension from "../index.ts";
import questionnaireExtension from "../questionnaire.ts";
import cmuxSessionExtension from "../cmux-session.ts";
import modelFailoverExtension from "../model-failover.ts";
import { requireAcpx } from "../require-acpx.ts";

const entryPoints = [delegateGraphExtension, questionnaireExtension, cmuxSessionExtension, modelFailoverExtension] as const;
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
	return new Proxy({}, {
		get(_target, property) {
			throw new Error(`registration attempted through ${String(property)}`);
		},
	}) as ExtensionAPI;
}

describe("mandatory ACPX prerequisite", () => {
	test("uses a direct executable argv boundary", () => {
		const calls: Array<{ command: string; args: readonly string[]; shell: boolean }> = [];
		requireAcpx({}, (command, args, options) => {
			calls.push({ command, args, shell: options.shell });
			return { pid: 1, output: [null, "0.13.2\n", ""], stdout: "0.13.2\n", stderr: "", status: 0, signal: null };
		});
		assert.deepEqual(calls, [{ command: "acpx", args: ["--version"], shell: false }]);
	});

	test("every entry point fails before registration when ACPX is missing", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-wave-acpx-missing-"));
		directories.push(directory);
		executable(directory, "herdr", "herdr 0.8.0");
		process.env.PATH = directory;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "workspace:test";
		process.env.HERDR_TAB_ID = "tab:test";
		for (const entryPoint of entryPoints) {
			assert.throws(() => entryPoint(registrationTrap()), /requires ACPX 0\.13\.2/);
		}
	});

	test("rejects a mismatched ACPX version before registration", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-agent-wave-acpx-version-"));
		directories.push(directory);
		executable(directory, "herdr", "herdr 0.8.0");
		executable(directory, "acpx", "0.13.1");
		process.env.PATH = directory;
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "workspace:test";
		process.env.HERDR_TAB_ID = "tab:test";
		for (const entryPoint of entryPoints) {
			assert.throws(() => entryPoint(registrationTrap()), /requires ACPX 0\.13\.2; found 0\.13\.1/);
		}
	});
});
