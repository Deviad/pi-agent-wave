import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packageRoot } from "./support/repoRoot.ts";

// Resolved from packageRoot so the file reports the same result from the repository root or the package directory.
const DRIVER = join(packageRoot, "test/support/credential-preflight-driver.py");

type Observed = {
	argv?: string[];
	envHome?: string;
	envAgentDir?: string;
	authType?: string;
	reason?: string | null;
	raised?: string | null;
	link?: string;
	mode?: string;
	isSymlink?: boolean;
	keySet?: string;
	liveUnchanged?: boolean;
	callCount?: number;
	checkCall?: string[];
};

function observe(name: string): Observed {
	const result = spawnSync("python3", [DRIVER, name], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
	assert.equal(result.status, 0, `${name}: ${result.stderr}`);
	return JSON.parse(result.stdout) as Observed;
}

const DECOY_HOME = "/decoy/home";
const DECOY_AGENT_DIR = "/decoy/agent-dir";

describe("credential preflight", () => {
	test("asks Pi for the executing provider with the flags the parser depends on", () => {
		const observed = observe("ready-json");
		// `--json` decides whether the answer parses at all and `--no-refresh` is what keeps a
		// preflight from rotating a credential, so both are pinned as literal argv, not inferred.
		assert.deepEqual(observed.argv, ["pi", "auth", "check", "--provider", "anthropic", "--json", "--no-refresh"]);
		assert.equal(observed.authType, "oauth", "a ready check must carry the provider's authType through");
		assert.equal(observed.reason, null, "a ready check must not report a reason");
	});

	test("the answer is read from the store of the agent that will run, never the caller's exports", () => {
		for (const name of ["ready-json", "plain-ready", "not-ready-reason"]) {
			const observed = observe(name);
			// The driver poisons HOME and PI_CODING_AGENT_DIR; inheriting either would make the
			// preflight answer for some other agent's store.
			assert.notEqual(observed.envHome, DECOY_HOME, `${name}: inherited a poisoned HOME`);
			assert.notEqual(observed.envAgentDir, DECOY_AGENT_DIR, `${name}: inherited a poisoned PI_CODING_AGENT_DIR`);
			assert.ok(observed.envHome && observed.envAgentDir?.startsWith(observed.envHome), `${name}: agent dir escaped the attempt home`);
			assert.equal(`${observed.envHome}/.pi/agent`, observed.envAgentDir, `${name}: agent dir was not the attempt's own`);
		}
	});

	test("a bare `ready` is not usable, which is what makes --json load-bearing", () => {
		const observed = observe("plain-ready");
		assert.equal(observed.authType, "unknown");
		assert.equal(observed.reason, "status=unparseable exit=0");
	});

	test("a not-ready answer passes its own reason through unchanged", () => {
		const observed = observe("not-ready-reason");
		assert.equal(observed.reason, "no credential configured", "the provider's reason must survive to the log");
	});

	test("exit code zero is required, so a ready payload from a failing check is not trusted", () => {
		const observed = observe("ready-but-failed-exit");
		assert.match(String(observed.reason), /exit=1$/, `a non-zero exit must be reported, got: ${observed.reason}`);
		assert.notEqual(observed.reason, null, "a check that exited non-zero must not read as ready");
	});

	test("an unusable runner degrades to a named reason instead of blocking the launch silently", () => {
		const observed = observe("runner-raised");
		assert.equal(observed.authType, "unknown");
		assert.equal(observed.reason, "check-unavailable: pi binary missing");
	});

	test("a usable credential in the live store overrides a not-ready answer", () => {
		const observed = observe("override-not-ready-but-live-entry");
		assert.equal(observed.raised, null, `a usable credential must not block the launch: ${observed.raised}`);
		assert.equal(observed.isSymlink, false, "the attempt must get its own file, never a link into the live store");
		assert.equal(observed.mode, "0o600", `materialised credentials must be private, got ${observed.mode}`);
		assert.equal(observed.liveUnchanged, true, "the live auth.json must not be rewritten");
		// One call means the credential lookup was never consulted: the store entry was used directly.
		assert.equal(observed.callCount, 1, "a seeded live entry must not trigger a print-api-key lookup");
		assert.deepEqual(observed.checkCall, ["pi", "auth", "check", "--provider", "anthropic", "--json", "--no-refresh"]);
	});

	test("with no usable credential the preflight refuses and names the reason", () => {
		const observed = observe("no-usable-credential");
		assert.ok(observed.raised, "a launch with no credential must be refused, not started");
		assert.match(String(observed.raised), /no usable credential for anthropic\/claude-test/);
		// The refusal has to carry the check's own reason, or a blocked launch is undiagnosable.
		assert.match(String(observed.raised), /check=no credential configured/, `the reason must be quoted back: ${observed.raised}`);
		assert.equal(observed.liveUnchanged, true);
	});
});