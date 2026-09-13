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
	mutations: { mutableCatalog: boolean; changed: string | null; mode: string | null; specialMode: string | null; missing: string | null; link: string | null }[];
	catalogRefresh: { verification: string | null; changed: boolean; liveUnchanged: boolean; readBack: boolean } | null;
	retention: { cleanupRemoved: boolean; count: number; exact: boolean; mode: string | null; hashesMatch: boolean; privateDataLeaked: boolean };
	credentialSpecialMode: string | null;
	legacyBefore: string | null;
	legacyAfter: string | null;
	selfWrites: { tolerated: string[]; rewritten: string | null; recorded: Record<string, unknown>[]; notJson: string | null; notObject: string | null; restored: string | null; restoredRecorded: unknown[] } | null;
}

const expected = {
	codex: ["attempt/providers/codex/auth.json", "attempt/providers/codex/config.toml"],
	"codex-custom": ["attempt/providers/codex/auth.json", "attempt/providers/codex/config.toml"],
	pi: ["attempt/providers/pi-agent/auth.json", "attempt/providers/pi-agent/models.json", "attempt/providers/pi-agent/models-store.json", "attempt/providers/pi-agent/model-routing.jsonc"],
	claude: ["attempt/providers/claude/.credentials.json", "acpx/.claude.json", "attempt/providers/claude/settings.json", "attempt/providers/claude/setup-token"],
};

for (const [agent, paths] of Object.entries(expected)) {
	test(`${agent} configuration is isolated from live rewrites and rejects private substitution`, () => {
		const storeModule = new URL("core/models-store.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
		const process = spawnSync("python3", [join(import.meta.dirname, "support/provider-runtime-driver.py"), agent, storeModule], { encoding: "utf8" });
		assert.equal(process.status, 0, process.stderr);
		const result: RuntimeResult = JSON.parse(process.stdout);
		assert.equal(result.before, null);
		if (agent === "pi") {
			assert.deepEqual(result.catalogRefresh, { verification: null, changed: true, liveUnchanged: true, readBack: true });
		}
		assert.deepEqual(result.retention, { cleanupRemoved: true, count: 1, exact: true, mode: "0o600", hashesMatch: true, privateDataLeaked: false });
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
		if (agent === "claude") {
			const selfWrites = result.selfWrites;
			assert.ok(selfWrites, "claude reports its tolerated self-write checks");
			assert.deepEqual(selfWrites.tolerated, [".claude.json", "settings.json"]);
			assert.equal(selfWrites.rewritten, null, "a JSON rewrite of Claude's own configuration is tolerated");
			assert.deepEqual(selfWrites.recorded.map((item) => ({ name: item.name, addedKeys: item.addedKeys, removedKeys: item.removedKeys, contentChanged: item.contentChanged })), [
				{ name: ".claude.json", addedKeys: ["promptQueueUseCount"], removedKeys: [], contentChanged: true },
				{ name: "settings.json", addedKeys: ["added"], removedKeys: [], contentChanged: true },
			]);
			assert.match(selfWrites.notJson ?? "", /changed and is no longer a JSON object/);
			assert.match(selfWrites.notObject ?? "", /changed and is no longer a JSON object/);
			assert.equal(selfWrites.restored, null);
			assert.deepEqual(selfWrites.restoredRecorded, [], "an unchanged snapshot records no self-write");
		} else {
			assert.equal(result.selfWrites, null);
			assert.ok(result.mutations.every((mutation) => !("selfWrites" in mutation)));
		}
		for (const mutation of result.mutations) {
			if (mutation.mutableCatalog) assert.equal(mutation.changed, null);
			else assert.match(mutation.changed ?? "", /changed/);
			assert.match(mutation.mode ?? "", /mode changed/);
			assert.match(mutation.specialMode ?? "", /mode changed/);
			assert.match(mutation.missing ?? "", /missing/);
			assert.match(mutation.link ?? "", /symlink/);
		}
		assert.equal(result.legacyBefore, null);
		assert.match(result.legacyAfter ?? "", /target changed/);
	});
}
