import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import delegateGraphExtension from "../index.ts";
import questionnaireExtension from "../questionnaire.ts";
import cmuxSessionExtension from "../cmux-session.ts";
import modelFailoverExtension from "../model-failover.ts";
import { delegateInvocation, selectTransport } from "../scripts/delegate.ts";

const entryPoints = [delegateGraphExtension, questionnaireExtension, cmuxSessionExtension, modelFailoverExtension] as const;

function registrationRecorder(): { api: ExtensionAPI; calls: string[] } {
	const calls: string[] = [];
	const api = new Proxy({}, { get(_target, property) { return () => { calls.push(String(property)); }; } }) as ExtensionAPI;
	return { api, calls };
}

describe("optional Herdr presentation", () => {
	for (const [name, env, executable, expected] of [
		["complete capability", { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab" }, true, "herdr"],
		["no identity", {}, true, "headless"],
		["missing workspace", { HERDR_ENV: "1", HERDR_TAB_ID: "tab" }, true, "headless"],
		["missing tab", { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace" }, true, "headless"],
		["blank identity", { HERDR_ENV: "1", HERDR_WORKSPACE_ID: " ", HERDR_TAB_ID: "tab" }, true, "headless"],
		["missing executable", { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab" }, false, "headless"],
	] as const) {
		test(`auto selects ${expected} for ${name}`, () => {
			assert.equal(selectTransport(env, "auto", () => executable), expected);
		});
	}

	test("explicit headless performs no Herdr probe", () => {
		let probes = 0;
		assert.equal(selectTransport({}, "headless", () => { probes += 1; return false; }), "headless");
		assert.equal(probes, 0);
		assert.match(delegateInvocation("headless", ["status"]).args[0], /headless_delegate\.py$/);
	});

	test("explicit Herdr fails closed without complete capability", () => {
		assert.throws(() => selectTransport({}, "herdr", () => true), /Herdr transport is unavailable/);
		assert.throws(() => selectTransport({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab" }, "herdr", () => false), /Herdr transport is unavailable/);
	});

	test("the installed Herdr capability preserves package entry-point registration", () => {
		const version = spawnSync("herdr", ["--version"], { encoding: "utf8", shell: false });
		assert.equal(version.status, 0, version.stderr);
		// The capability selector reads the ambient environment, so name the identity under test rather than
		// inheriting the caller's shell: this test otherwise passes only inside a Herdr workspace.
		const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		process.env.HERDR_ENV = "1";
		process.env.HERDR_WORKSPACE_ID = "workspace";
		process.env.HERDR_TAB_ID = "tab";
		try {
			assert.equal(selectTransport(process.env, "herdr"), "herdr");
		} finally {
			if (saved.env === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = saved.env;
			if (saved.workspace === undefined) delete process.env.HERDR_WORKSPACE_ID; else process.env.HERDR_WORKSPACE_ID = saved.workspace;
			if (saved.tab === undefined) delete process.env.HERDR_TAB_ID; else process.env.HERDR_TAB_ID = saved.tab;
		}
		for (const entryPoint of entryPoints) {
			const { api, calls } = registrationRecorder();
			assert.doesNotThrow(() => entryPoint(api));
			assert.ok(calls.length > 0);
		}
	});
});
