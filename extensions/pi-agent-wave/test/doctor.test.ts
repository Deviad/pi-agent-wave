import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runDoctor } from "../scripts/doctor.mjs";

const AGENT_DIR = join(process.env.HOME ?? "", ".pi", "agent");

/**
 * Run `body` with exactly the Herdr environment it names. The doctor reads the ambient environment, so a
 * test that leaves identity to the caller's shell passes inside a Herdr workspace and fails outside one.
 */
function withHerdrIdentity<T>(identity: Record<string, string | undefined>, body: () => T): T {
	const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
	try {
		for (const [key, value] of Object.entries(identity)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		return body();
	} finally {
		if (saved.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = saved.env;
		if (saved.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = saved.workspace;
		if (saved.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = saved.tab;
	}
}

describe("optional Herdr doctor capability", () => {
	test("reports installed Herdr without workspace identity as an optional warning", () => {
		withHerdrIdentity({ HERDR_ENV: undefined, HERDR_WORKSPACE_ID: undefined, HERDR_TAB_ID: undefined }, () => {
			const result = runDoctor(["--agent-dir", AGENT_DIR]);
			const capability = result.checks.find((entry) => entry.check === "herdr-presentation");
			assert.equal(capability?.status, "warn");
			assert.match(capability?.detail ?? "", /optional.*inactive/i);
			assert.equal(result.fatal.some((entry) => entry.check === "herdr-presentation"), false);
		});
	});

	test("reports complete active Herdr presentation identity", () => {
		withHerdrIdentity({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab" }, () => {
			const result = runDoctor(["--agent-dir", AGENT_DIR]);
			const capability = result.checks.find((entry) => entry.check === "herdr-presentation");
			assert.equal(capability?.status, "ok");
			assert.match(capability?.detail ?? "", /active/i);
		});
	});
});
