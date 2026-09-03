import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpxPreflightError, collectAcpxPreflight, resolveExecutable } from "./support/acpx-spike.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeExecutable(directory: string, name: string, version: string): void {
	const executable = join(directory, name);
	writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
	chmodSync(executable, 0o755);
}

describe("ACPX spike preflight", () => {
	test("records exact direct-executable versions and isolated paths", () => {
		const bin = mkdtempSync(join(tmpdir(), "acpx-spike-bin-"));
		const home = mkdtempSync(join(tmpdir(), "acpx-spike-home-"));
		directories.push(bin, home);
		fakeExecutable(bin, "acpx", "acpx 0.13.2");
		fakeExecutable(bin, "herdr", "herdr 0.8.0");
		fakeExecutable(bin, "codex", "codex-cli 0.137.0");

		const baseline = collectAcpxPreflight({
			path: bin,
			home,
			env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace:test", HERDR_TAB_ID: "tab:test" },
			agentCommand: "codex",
		});

		assert.equal(baseline.status, "ready");
		assert.equal(baseline.dependencies.acpx.version, "acpx 0.13.2");
		assert.equal(baseline.dependencies.herdr.version, "herdr 0.8.0");
		assert.equal(baseline.dependencies.agent.version, "codex-cli 0.137.0");
		assert.equal(baseline.acpx.configPath, join(home, ".acpx", "config.json"));
		assert.equal(baseline.acpx.sessionStorePath, join(home, ".acpx", "sessions"));
		assert.equal(baseline.herdr.workspaceId, "workspace:test");
	});

	test("fails closed before setup when ACPX or complete Herdr identity is missing", () => {
		const bin = mkdtempSync(join(tmpdir(), "acpx-spike-bin-"));
		const home = mkdtempSync(join(tmpdir(), "acpx-spike-home-"));
		directories.push(bin, home);
		fakeExecutable(bin, "herdr", "herdr 0.8.0");
		fakeExecutable(bin, "codex", "codex-cli 0.137.0");

		assert.throws(
			() => collectAcpxPreflight({ path: bin, home, env: { HERDR_ENV: "1" }, agentCommand: "codex" }),
			(error: unknown) => error instanceof AcpxPreflightError && error.blockers.includes("missing executable: acpx") && error.blockers.includes("incomplete Herdr workspace identity"),
		);
	});

	test("checks the current environment without substituting a fixture for ACPX", () => {
		const home = mkdtempSync(join(tmpdir(), "acpx-spike-real-home-"));
		directories.push(home);
		const acpx = resolveExecutable("acpx", process.env.PATH ?? "");
		if (!acpx) {
			assert.throws(
				() => collectAcpxPreflight({ path: process.env.PATH ?? "", home, env: process.env, agentCommand: "codex" }),
				(error: unknown) => error instanceof AcpxPreflightError && error.blockers.includes("missing executable: acpx"),
			);
			return;
		}
		const baseline = collectAcpxPreflight({ path: process.env.PATH ?? "", home, env: process.env, agentCommand: "codex" });
		assert.equal(baseline.dependencies.acpx.path, acpx);
	});
});
