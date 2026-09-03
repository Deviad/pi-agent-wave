import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runDoctor } from "../scripts/doctor.mjs";

describe("doctor ACPX and AgentFS readiness", () => {
	test("reports exact mandatory runtimes and all three ACP adapters without credentials", () => {
		const result = runDoctor(["--agent-dir", join(process.env.HOME ?? "", ".pi", "agent")]);
		const checks = new Map(result.checks.map((entry) => [entry.check, entry]));
		for (const name of ["acpx-executable", "acpx-version", "acpx-pi-adapter", "acpx-codex-adapter", "acpx-claude-adapter", "agentfs-executable", "agentfs-version", "agentfs-platform-sandbox"]) {
			assert.equal(checks.get(name)?.status, "ok", `${name}: ${checks.get(name)?.detail}`);
		}
		assert.equal(checks.get("acpx-version")?.detail, "0.13.2");
		assert.equal(checks.get("agentfs-version")?.detail, "0.6.4");
		assert.equal(checks.get("claude-setup-token")?.status, "warn");
		assert.match(checks.get("claude-setup-token")?.detail ?? "", /not configured/);
		assert.doesNotMatch(JSON.stringify(result.checks), /sk-|Bearer |accessToken|refreshToken/);
	});
});
