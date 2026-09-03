import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runDoctor } from "../scripts/doctor.mjs";

const AGENT_DIR = join(process.env.HOME ?? "", ".pi", "agent");

describe("optional Herdr doctor capability", () => {
	test("reports installed Herdr without workspace identity as an optional warning", () => {
		const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_WORKSPACE_ID;
		delete process.env.HERDR_TAB_ID;
		try {
			const result = runDoctor(["--agent-dir", AGENT_DIR]);
			const capability = result.checks.find((entry) => entry.check === "herdr-presentation");
			assert.equal(capability?.status, "warn");
			assert.match(capability?.detail ?? "", /optional.*inactive/i);
			assert.equal(result.fatal.some((entry) => entry.check === "herdr-presentation"), false);
		} finally {
			if (saved.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = saved.env;
			if (saved.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = saved.workspace;
			if (saved.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = saved.tab;
		}
	});

	test("reports complete active Herdr presentation identity", () => {
		const result = runDoctor(["--agent-dir", AGENT_DIR]);
		const capability = result.checks.find((entry) => entry.check === "herdr-presentation");
		assert.equal(capability?.status, "ok");
		assert.match(capability?.detail ?? "", /active/i);
	});
});
