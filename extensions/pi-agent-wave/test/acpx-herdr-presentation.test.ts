import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { focusRegisteredAgent, herdrAgentName, herdrTabLabel } from "../herdr.ts";
import { createAcpxWorkerIdentity, verifyHerdrPresentation } from "./support/acpx-spike.ts";

describe("ACPX Herdr presentation", () => {
	test("maps graph, role, ACPX session, Herdr agent, and tab to one stable identity", () => {
		const identity = createAcpxWorkerIdentity({
			runId: "run-spike",
			operationId: "operation-spike",
			role: "reviewer",
			selectedModel: "openai/gpt-5",
			modelPolicy: "strong",
			acpAgent: "codex",
			acpxSession: "acpx-session-spike",
			herdrAgent: herdrAgentName("acpx-headless-worker-spike", "reviewer"),
			herdrTab: herdrTabLabel("acpx-headless-worker-spike", "reviewer", 1, "openai/gpt-5", "Strong"),
			herdrTabId: "tab-spike",
		});

		assert.equal(identity.key, "run-spike:operation-spike:acpx-session-spike");
		assert.match(identity.herdrAgent, /reviewer/);
		assert.match(identity.herdrTab, /acpx-headless-worker-spike: reviewer/);
		assert.equal(verifyHerdrPresentation(identity, { liveAgents: [identity.herdrAgent], liveTabs: [identity.herdrTabId] }).visible, true);
	});

	test("requires complete live ACPX and AgentFS identity before focus", async () => {
		const complete = { name: "worker", node: "review", role: "reviewer", herdr_agent: "herdr-worker", tab_id: "tab-worker", herdr_pane_id: "pane-worker", acpx_cancel_script: "/tmp/cancel-worker.sh", acp_agent: "codex", acpx_session_id: "acpx-session", acpx_record_id: "acpx-session", acpx_attempt_key: "run:operation:reviewer:0:0:openai-codex/gpt-5.6-sol:codex", acpx_state: "alive", agentfs_session_id: "acpx-session", agentfs_db_path: "/tmp/delta.db" };
		const exec = async (command: string, args: string[]) => command === complete.acpx_cancel_script
			? ({ exitCode: 0, stdout: JSON.stringify({ action: "cancel_attempt", sessionName: complete.acpx_session_id, recordId: complete.acpx_record_id, attemptKey: complete.acpx_attempt_key, cancelled: true, structuredCancelled: true, closed: true, noSession: true }), stderr: "" })
			: args[0] === "pane"
				? ({ exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "pane-worker", tab_id: "tab-worker" } } }), stderr: "" })
				: ({ exitCode: 0, stdout: "", stderr: "" });
		await assert.doesNotReject(() => focusRegisteredAgent([complete], "worker", true, exec));
		await assert.rejects(() => focusRegisteredAgent([{ ...complete, acpx_state: "idle" }], "worker", true, exec), /expected alive/);
		await assert.rejects(() => focusRegisteredAgent([{ ...complete, agentfs_db_path: null }], "worker", true, exec), /incomplete ACPX\/AgentFS identity/);
		const calls: string[][] = [];
		const mismatchExec = async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			if (command === "/tmp/cancel-worker.sh") return { exitCode: 0, stdout: JSON.stringify({ action: "cancel_attempt", sessionName: complete.acpx_session_id, recordId: complete.acpx_record_id, attemptKey: complete.acpx_attempt_key, cancelled: true, structuredCancelled: true, closed: true, noSession: true }), stderr: "" };
			return args[1] === "get"
				? { exitCode: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "other-pane", tab_id: "other-tab" } } }), stderr: "" }
				: { exitCode: 0, stdout: "", stderr: "" };
		};
		await assert.rejects(() => focusRegisteredAgent([complete], "worker", true, mismatchExec), /identity mismatch/);
		assert.ok(calls.some((args) => args[0] === "/tmp/cancel-worker.sh"));
		assert.equal(calls.some((args) => args.join(" ").includes("pane send-keys")), false);
	});

	test("uses existing focus behavior and fails closed when the live tab is absent", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		await focusRegisteredAgent(
			[{ name: "reviewer-1", node: "review", herdr_agent: "dg-spike-reviewer-1" }],
			"reviewer-1",
			true,
			async (command, args) => {
				calls.push({ command, args });
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		);
		assert.deepEqual(calls, [{ command: "herdr", args: ["agent", "focus", "dg-spike-reviewer-1"] }]);

		const identity = createAcpxWorkerIdentity({ runId: "run", operationId: "operation", role: "reviewer", selectedModel: "model", modelPolicy: "exact", acpAgent: "codex", acpxSession: "session", herdrAgent: "agent", herdrTab: "tab", herdrTabId: "tab-id" });
		assert.deepEqual(verifyHerdrPresentation(identity, { liveAgents: ["agent"], liveTabs: [] }), { visible: false, blockers: ["Herdr tab tab-id is not live"] });
	});
});
