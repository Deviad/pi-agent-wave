import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

interface RuntimeResult {
	before: string | null;
	afterCatalog: string | null;
	afterSources: string | null;
	copies: boolean[];
	modes: string[];
	configMatched: boolean;
	unchanged: boolean;
	destinations: string[];
	claudeTokenEnvironment: boolean;
	mutations: { changed: string | null; mode: string | null; specialMode: string | null; missing: string | null; link: string | null }[];
	credentialSpecialMode: string | null;
	legacyBefore: string | null;
	legacyAfter: string | null;
}

const expected = {
	codex: ["attempt/providers/codex/auth.json", "attempt/providers/codex/config.toml"],
	"codex-custom": ["attempt/providers/codex/auth.json", "attempt/providers/codex/config.toml"],
	pi: ["attempt/providers/pi-agent/auth.json", "attempt/providers/pi-agent/models.json", "attempt/providers/pi-agent/models-store.json", "attempt/providers/pi-agent/model-routing.jsonc"],
	claude: ["attempt/providers/claude/.credentials.json", "acpx/.claude.json", "attempt/providers/claude/settings.json", "attempt/providers/claude/setup-token"],
};

for (const [agent, paths] of Object.entries(expected)) {
	test(`${agent} configuration is isolated from live rewrites and rejects private substitution`, () => {
		const process = spawnSync("python3", [join(import.meta.dirname, "support/provider-runtime-driver.py"), agent], { encoding: "utf8" });
		assert.equal(process.status, 0, process.stderr);
		const result: RuntimeResult = JSON.parse(process.stdout);
		assert.equal(result.before, null);
		assert.equal(result.afterCatalog, null, "a live Pi catalog rewrite must not invalidate an isolated attempt");
		assert.deepEqual(result.destinations.sort(), paths.sort());
		assert.equal(result.claudeTokenEnvironment, agent === "claude");
		assert.ok(result.copies.length > 0 && result.copies.every(Boolean));
		assert.ok(result.modes.every((mode) => mode === "0o600"));
		assert.equal(result.configMatched, true);
		assert.equal(result.afterSources, null);
		assert.equal(result.unchanged, true);
		assert.equal(result.mutations.length, result.copies.length);
		assert.match(result.credentialSpecialMode ?? "", /mode changed/);
		for (const mutation of result.mutations) {
			assert.match(mutation.changed ?? "", /changed/);
			assert.match(mutation.mode ?? "", /mode changed/);
			assert.match(mutation.specialMode ?? "", /mode changed/);
			assert.match(mutation.missing ?? "", /missing/);
			assert.match(mutation.link ?? "", /symlink/);
		}
		assert.equal(result.legacyBefore, null);
		assert.match(result.legacyAfter ?? "", /target changed/);
	});
}
