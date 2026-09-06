import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { join } from "node:path";

const DRIVER = join(process.cwd(), "extensions/pi-agent-wave/test/support/provider-snapshot-driver.py");

function driver(mode: string, name: string): Record<string, any> {
	const result = spawnSync("python3", [DRIVER, mode, name], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const snapshot = (name: string): Record<string, any> => driver("snapshot", name);

describe("agent credential files are private copies", () => {
	for (const agent of ["codex", "claude"]) {
		test(`the ${agent} credential is materialized, refresh-tolerant, and substitution-checked`, () => {
			const result = driver("materialization", agent);
			assert.equal(result.error, null, result.error);
			assert.equal(result.isSymlink, false, "a live credential store must never be linked into an attempt");
			assert.equal(result.isRegular, true);
			assert.equal(result.mode, "0o600");
			assert.equal(result.recordKind, "file");
			assert.deepEqual(result.recordKeySet, result.createdKeys);
			assert.equal(result.liveUnchanged, true, "the live store must be untouched");
			assert.equal(result.verification, null);
			assert.equal(result.refreshVerification, null, "rewriting a value in the private copy is a refresh, not a breach");
			assert.match(String(result.keySetTamper), /key set changed/);
		});
	}

	test("a permissive umask still yields a mode-600 credential file", () => {
		const previous = process.umask(0o022);
		try {
			assert.equal(driver("materialization", "codex").mode, "0o600");
		} finally {
			process.umask(previous);
		}
	});
});

describe("agent-aware credential preflight", () => {
	test("the Python agent mirror agrees with selectAcpAgent", () => {
		const { agents } = driver("agent", "agent");
		for (const [model, agent] of Object.entries(agents as Record<string, string>)) {
			assert.equal(agent, selectAcpAgent(model), `agent_for_model(${model}) drifted from selectAcpAgent`);
		}
		assert.equal(Object.keys(agents).length, 5);
	});

	test("accepts a Codex credential in either shape", () => {
		assert.equal(driver("credential", "codex-ok-chatgpt").authType, "chatgpt");
		assert.equal(driver("credential", "codex-ok-apikey").authType, "api_key");
	});

	test("rejects a missing, empty, or unparseable Codex credential with the remedy", () => {
		for (const name of ["codex-missing", "codex-empty", "codex-unparseable"]) {
			const error = String(driver("credential", name).error);
			assert.match(error, /worker preflight/, name);
			assert.match(error, /codex login/, `${name} must name the remedy`);
		}
	});

	test("accepts either Claude credential and rejects neither-present", () => {
		assert.equal(driver("credential", "claude-token-file").authType, "token-file");
		assert.equal(driver("credential", "claude-credentials-file").authType, "credentials-file");
		const error = String(driver("credential", "claude-missing").error);
		assert.match(error, /worker preflight/);
		assert.match(error, /PI_CLAUDE_OAUTH_TOKEN_FILE/);
	});

	test("dispatch blocks before building any provider view when the Codex agent has no credential", () => {
		const result = driver("credential", "codex-wiring");
		assert.match(String(result.wiring), /worker preflight/);
		assert.match(String(result.wiring), /codex login/);
	});
});

describe("worker provider credential materialization", () => {
	test("materializes a private copy when the live auth store already has the provider", () => {
		const result = snapshot("live-entry");
		assert.equal(result.error, null, result.error);
		assert.equal(result.exists, true);
		assert.equal(result.isSymlink, false, "the live credential file must never be linked into an attempt");
		assert.equal(result.isRegular, true);
		assert.equal(result.mode, "0o600");
		assert.deepEqual(result.providers, ["alibaba"], "only the selected provider may be present");
		assert.equal(result.entryType, "api_key");
		assert.equal(result.liveUnchanged, true);
		assert.equal(result.recordKind, "file");
		assert.equal(result.verification, null, "the materialized record must verify as created");
		assert.equal(result.refreshVerification, null, "a private refresh of the same provider must verify clean");
		assert.match(String(result.providerSetTamper), /key set changed/);
		assert.match(String(result.modeTamper), /mode changed/);
		assert.match(String(result.symlinkTamper), /symlink/);
		assert.deepEqual(result.recordKeySet, ["alibaba"]);
	});

	test("resolves a keychain-backed provider into the private file without touching the live store", () => {
		const result = snapshot("resolve");
		assert.equal(result.error, null, result.error);
		assert.equal(result.isRegular, true);
		assert.equal(result.mode, "0o600");
		assert.deepEqual(result.providers, ["alibaba"]);
		assert.deepEqual(result.entryFields, ["key", "type"]);
		assert.equal(result.resolvedKeyMatches, true, "the resolved key must land in the attempt-private file");
		assert.equal(result.liveUnchanged, true);
		assert.equal(result.liveHasSentinel, false, "a resolved key must never be written back to the live auth store");
	});

	test("materializes a resolved key even when pi reports the provider not ready", () => {
		const result = snapshot("check-fail-key-ok");
		assert.equal(result.error, null, result.error);
		assert.equal(result.isRegular, true);
		assert.deepEqual(result.providers, ["alibaba"]);
		assert.equal(result.resolvedKeyMatches, true, "a resolvable key overrides a not-ready check");
		assert.equal(result.mode, "0o600");
	});

	test("blocks the attempt with a named preflight reason when no credential exists", () => {
		const result = snapshot("preflight-fail");
		assert.match(String(result.error), /worker preflight: provider "alibaba" has no usable credential for alibaba\/qwen3\.8-flash/);
		assert.match(String(result.error), /provider_not_found|not_ready/);
		assert.equal(result.exists, false, "a blocked preflight must not leave a credential file behind");
	});

	test("asks Pi about the real registry, not whatever the caller exported", () => {
		const result = snapshot("live-entry");
		assert.equal(result.decoyAgentDir, "/decoy-agent-dir-that-must-not-be-used", "the driver must export a decoy for this case to mean anything");
		assert.notEqual(result.preflightEnvAgentDir, result.decoyAgentDir, "the preflight must not inherit the caller's registry");
		assert.match(String(result.preflightEnvAgentDir), /\.pi\/agent$/);
		assert.equal(String(result.preflightEnvHome), String(result.preflightEnvAgentDir).replace(/\/\.pi\/agent$/, ""));
	});

	test("the preflight reason is transient so the frozen chain advances", async () => {
		const { classifyFailure } = await import("../retry.ts");
		const error = 'worker preflight: provider "alibaba" has no usable credential for alibaba/qwen3.8-flash (provider_not_found)';
		assert.deepEqual(classifyFailure(error), { kind: "transient", reason: "worker-credential-preflight" });
	});
});
