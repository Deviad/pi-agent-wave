import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentForModel, inspectRouteCredential, runDoctor } from "../scripts/doctor.mjs";
import { selectAcpAgent } from "../lib/acpx-select.ts";

const ROUTE_MODELS = ["openai-codex/gpt-6-astra", "claude-code/claude-opus-5", "alibaba/qwen3.8-flash", "z.ai-sub/glm-5.2", "lmstudio/qwen3.6-27b-mlx"];

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

	test("the doctor, TypeScript selector, and Python preflight all map a model to the same agent", () => {
		const driver = join(process.cwd(), "extensions/pi-agent-wave/test/support/provider-snapshot-driver.py");
		const run = spawnSync("python3", [driver, "agent", "agent"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
		assert.equal(run.status, 0, run.stderr);
		const python = JSON.parse(run.stdout).agents as Record<string, string>;
		for (const model of ROUTE_MODELS) {
			assert.equal(agentForModel(model), selectAcpAgent(model), `doctor.mjs drifted from lib/acpx-select.ts for ${model}`);
			assert.equal(python[model], selectAcpAgent(model), `delegate_core.py drifted from lib/acpx-select.ts for ${model}`);
		}
	});

	test("reports an unusable Codex route with the remedy instead of a silent dispatch failure", () => {
		const emptyCodexHome = mkdtempSync(join(tmpdir(), "doctor-codex-home-"));
		const saved = process.env.CODEX_HOME;
		process.env.CODEX_HOME = emptyCodexHome;
		try {
			const result = runDoctor(["--agent-dir", join(process.env.HOME ?? "", ".pi", "agent")]);
			const entry = result.checks.find((candidate) => candidate.check === "route-credentials");
			assert.equal(entry?.status, "fail", JSON.stringify(entry));
			assert.match(entry?.detail ?? "", /codex: no credential at .*auth\.json; run codex logout && codex login \(openai-codex\//);
			assert.doesNotMatch(JSON.stringify(result.checks), /sk-|Bearer |accessToken|refreshToken/);
		} finally {
			if (saved === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = saved;
			rmSync(emptyCodexHome, { recursive: true, force: true });
		}
	});

	test("distinguishes a stored Pi provider entry from one materialized at dispatch", () => {
		assert.deepEqual(inspectRouteCredential("pi", "alibaba/qwen3.8-flash", "/unused-agent-dir"), { usable: true, kind: "materialized-at-dispatch" });
		const agentDir = mkdtempSync(join(tmpdir(), "doctor-agent-dir-"));
		try {
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ alibaba: { type: "api_key", key: "k" } }), { mode: 0o600 });
			assert.deepEqual(inspectRouteCredential("pi", "alibaba/qwen3.8-flash", agentDir), { usable: true, kind: "stored" });
			assert.deepEqual(inspectRouteCredential("pi", "z.ai-sub/glm-5.2", agentDir), { usable: true, kind: "materialized-at-dispatch" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
