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

const originalEnv = { ...process.env };
const dirs: string[] = [];
const entryPoints = [delegateGraphExtension, questionnaireExtension, cmuxSessionExtension, modelFailoverExtension] as const;

afterEach(() => {
	process.env = { ...originalEnv };
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installMandatoryRuntimes(): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-wave-headless-runtime-"));
	dirs.push(dir);
	for (const [name, output] of [["acpx", "0.13.2"], ["agentfs", "agentfs v0.6.4"]] as const) {
		const executable = join(dir, name);
		writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
		chmodSync(executable, 0o755);
	}
	process.env.PATH = dir;
}

function registrationRecorder(): { api: ExtensionAPI; calls: string[] } {
	const calls: string[] = [];
	const api = new Proxy({}, { get(_target, property) { return () => { calls.push(String(property)); }; } }) as ExtensionAPI;
	return { api, calls };
}

describe("headless package loading", () => {
	test("all package entry points register with ACPX and AgentFS but no Herdr", () => {
		installMandatoryRuntimes();
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_WORKSPACE_ID;
		delete process.env.HERDR_TAB_ID;
		for (const entryPoint of entryPoints) {
			const { api, calls } = registrationRecorder();
			assert.doesNotThrow(() => entryPoint(api));
			assert.ok(calls.length > 0);
		}
	});
});
