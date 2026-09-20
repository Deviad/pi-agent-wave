import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cancelRegisteredAgent, focusRegisteredAgent } from "../herdr.ts";

/** The fixture launcher path does not exist on disk; production checks presence before executing it. */
const launcherPresent = () => true;
const launcherAbsent = () => false;

const complete = { name: "worker", node: "review", role: "reviewer", herdr_agent: "herdr-worker", tab_id: "tab-worker", herdr_pane_id: "pane-worker", acpx_cancel_script: "/tmp/cancel-worker.sh", acp_agent: "codex", acpx_session_id: "acpx-session", acpx_record_id: "acpx-session", acpx_attempt_key: "run:operation:reviewer:0:0:openai-codex/gpt-5.6-sol:codex", acpx_state: "alive", agentfs_session_id: "acpx-session", agentfs_db_path: "/tmp/delta.db" };

const cancelResult = { exitCode: 0, stdout: JSON.stringify({ action: "cancel_attempt", sessionName: complete.acpx_session_id, recordId: complete.acpx_record_id, attemptKey: complete.acpx_attempt_key, cancelled: true, structuredCancelled: true, closed: true, noSession: true }), stderr: "" };

describe("focus-time cancellation", () => {
	test("rejects headless focus without invoking Herdr or cancellation", async () => {
		let calls = 0;
		await assert.rejects(() => focusRegisteredAgent([{ ...complete, transport: "headless", herdr_agent: null, tab_id: null, herdr_pane_id: null }], "worker", false, async () => { calls += 1; return cancelResult; }, launcherPresent), /focus is unavailable for headless worker/);
		assert.equal(calls, 0);
	});
	test("runs exact structured cancellation before rejecting pane identity mismatch", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			if (command === complete.acpx_cancel_script) return cancelResult;
			return args[1] === "get" ? { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "other", tab_id: "other" } } }), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
		};
		await assert.rejects(() => focusRegisteredAgent([complete], "worker", true, exec, launcherPresent), /identity mismatch/);
		assert.ok(calls.some((args) => args[0] === complete.acpx_cancel_script));
		assert.equal(calls.some((args) => args.join(" ").includes("pane send-keys")), false);
		assert.equal(calls.some((args) => args.includes("focus")), false);
	});

	test("cancels the exact session when persisted identity is incomplete", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => { calls.push([command, ...args]); return command === complete.acpx_cancel_script ? cancelResult : { exitCode: 0, stdout: "", stderr: "" }; };
		await assert.rejects(() => focusRegisteredAgent([{ ...complete, agentfs_db_path: null }], "worker", true, exec, launcherPresent), /incomplete/);
		assert.ok(calls.some((args) => args[0] === complete.acpx_cancel_script));
	});

	test("rejects cancel-result-only output", async () => {
		const exec = async (command: string, args: string[]) => command === complete.acpx_cancel_script ? { exitCode: 0, stdout: JSON.stringify({ action: "cancel_result", cancelled: true }), stderr: "" } : args[1] === "get" ? { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "other", tab_id: "other" } } }), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
		await assert.rejects(() => focusRegisteredAgent([complete], "worker", true, exec, launcherPresent), /incomplete structured ACPX cancellation/);
	});

	test("rejects mismatched persisted attempt key and record identity", async () => {
		for (const agent of [{ ...complete, acpx_attempt_key: complete.acpx_attempt_key.replace(":codex", ":claude") }, { ...complete, acpx_record_id: "other-record" }]) {
			const exec = async (command: string) => command === complete.acpx_cancel_script ? cancelResult : { exitCode: 0, stdout: "", stderr: "" };
			await assert.rejects(() => focusRegisteredAgent([agent], "worker", true, exec, launcherPresent), /incomplete structured ACPX cancellation|attempt identity mismatch/);
		}
	});

	test("cancels owned resources for non-alive state", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => { calls.push([command, ...args]); return command === complete.acpx_cancel_script ? cancelResult : { exitCode: 0, stdout: "", stderr: "" }; };
		await assert.rejects(() => focusRegisteredAgent([{ ...complete, acpx_state: "idle" }], "worker", true, exec, launcherPresent), /expected alive/);
		assert.ok(calls.some((args) => args[0] === complete.acpx_cancel_script));
	});

	test("cancel converges when the launcher is already gone", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => { calls.push([command, ...args]); return { exitCode: 1, stdout: "", stderr: "" }; };
		await cancelRegisteredAgent([complete], "worker", exec, launcherAbsent);
		assert.deepEqual(calls, []);
	});

	test("cancel still fails when the launcher exists and exits non-zero", async () => {
		const exec = async () => ({ exitCode: 1, stdout: "", stderr: "launcher exploded" });
		await assert.rejects(() => cancelRegisteredAgent([complete], "worker", exec, launcherPresent), /launcher exploded/);
	});

	test("production default consults the filesystem for the launcher", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => { calls.push([command, ...args]); return { exitCode: 1, stdout: "", stderr: "" }; };
		await cancelRegisteredAgent([{ ...complete, acpx_cancel_script: "/tmp/definitely-missing-launcher-" + process.pid + ".sh" }], "worker", exec);
		assert.deepEqual(calls, []);
	});
});
