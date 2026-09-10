import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "./support/repoRoot.ts";

// Opt-in only, matching test/herdr-state-concurrency.test.ts: the offline suite stays hermetic and
// no developer run reaches a provider. Set PI_RUN_LIVE_PREFLIGHT=1 to exercise the real `pi auth check`.
const RUN_LIVE = process.env.PI_RUN_LIVE_PREFLIGHT === "1";

const DRIVER = join(packageRoot, "test/support/credential-preflight-driver.py");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const STORE = join(AGENT_DIR, "auth.json");

/** Providers this machine is actually configured for, reported rather than assumed. */
function configuredProviders(): string[] {
	if (!existsSync(STORE)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(STORE, "utf8"));
		return parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>).sort() : [];
	} catch {
		return [];
	}
}

const providers = configuredProviders();

describe("credential preflight against the real Pi CLI", () => {
	test("the live probe answers in the shape the parser expects, for every configured provider", {
		skip: RUN_LIVE ? false : "set PI_RUN_LIVE_PREFLIGHT=1 to run the live credential probe",
		timeout: 120_000,
	}, (t) => {
		// No store and no providers is a legitimate machine state, not a failure to hide.
		if (providers.length === 0) {
			t.skip("no provider credentials configured on this machine");
			return;
		}
		for (const provider of providers) {
			const result = spawnSync("python3", [DRIVER, `live:${provider}`], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
			assert.equal(result.status, 0, `${provider}: ${result.stderr}`);
			const observed = JSON.parse(result.stdout) as { authType: string; reason: string | null; storeUnchanged: boolean };
			// Live output must stay JSON: if it were plain text it would read as unparseable and every
			// launch would lose its credential answer without any of the offline tests noticing.
			assert.notEqual(
				observed.reason,
				"status=unparseable exit=0",
				`${provider}: live output no longer parses as JSON (${JSON.stringify(observed).slice(0, 160)})`,
			);
			if (observed.reason === null) {
				assert.notEqual(observed.authType, "unknown", `${provider}: a ready answer must carry an authType`);
			}
			// Nothing that looks like key material may travel back through the report path.
			assert.ok(
				!/[A-Za-z0-9_\-]{32,}/.test(JSON.stringify(observed)),
				`${provider}: the probe reported a value long enough to be credential material`,
			);
			// This is the whole point of --no-refresh: a preflight must not mutate the live store.
			assert.equal(observed.storeUnchanged, true, `${provider}: the preflight changed the live auth.json`);
		}
		assert.ok(providers.length > 0);
	});
});