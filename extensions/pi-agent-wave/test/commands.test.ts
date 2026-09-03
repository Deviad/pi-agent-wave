import { afterEach, describe, expect, test } from "./harness.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLog, renderStatus } from "../commands.ts";
import {
	focusHerdrAgent,
	focusRegisteredAgent,
	herdrAgentName,
	herdrTabLabel,
	modelPolicyLabel,
	shortModelName,
} from "../herdr.ts";
import {
	parsePolicyArg,
	pickPolicy,
	policyInputFromName,
	POLICY_PICKER_OPTIONS,
	POLICY_PICKER_TITLE,
	resolvePolicy,
} from "../index.ts";
import { parseDeferredTime, writeDeferredJob } from "../scheduler.ts";
import { GraphStore, roleForNode } from "../store.ts";
import type { ResolvedPolicy } from "../types.ts";

const SOL_MODEL = "openai-codex/gpt-5.6-sol";
const FALLBACK_MODEL = "anthropic/claude-opus-4-1";

type HerdrStartResult = {
	agent: string;
	"policy-digest": string;
	model: string;
	"model-attempt": number;
	"fallback-reason": string | null;
	tab: string;
};

function exactPolicy(): ResolvedPolicy {
	return {
		input: { kind: "model", model: SOL_MODEL, reason: "Explicit worker model lock" },
		routes: [
			{
				role: "thinker",
				tier: "exact",
				chain: [SOL_MODEL],
				thinking: "high",
				session: true,
				capabilityFloor: "planning",
				selectionSource: "model",
				promoted: false,
				promotionReason: null,
			},
		],
	};
}

function fallbackPolicy(): ResolvedPolicy {
	return {
		input: { kind: "preset", preset: "strong" },
		routes: [
			{
				role: "thinker",
				tier: "reasoning",
				chain: [SOL_MODEL, "anthropic/claude-opus-4-1"],
				thinking: "high",
				session: true,
				capabilityFloor: "planning",
				selectionSource: "preset",
				promoted: false,
				promotionReason: null,
			},
		],
	};
}

const dirs: string[] = [];
function fixture(): { dir: string; store: GraphStore } {
	const dir = mkdtempSync(join(tmpdir(), "delegate-graph-command-"));
	dirs.push(dir);
	return { dir, store: new GraphStore({ dbPath: join(dir, "graph.db"), now: () => new Date("2026-08-17T12:00:00.000Z") }) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor UX", () => {
	test("registers Delegate Graph commands and typed model-policy graph tool without opening the database", async () => {
		const { default: delegateGraphExtension } = await import("../index.ts");
		const commands: string[] = [];
		const tools: Array<{ name: string; parameters: unknown }> = [];
		const fakePi = {
			registerCommand(name: string) {
				commands.push(name);
			},
			registerTool(tool: { name: string; parameters: unknown }) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		delegateGraphExtension(fakePi);
		expect(commands).toEqual(["route", "delegate", "graph"]);
		expect(tools.map((tool) => tool.name)).toEqual(["delegate_graph"]);
		const schema = JSON.stringify(tools[0]?.parameters);
		for (const field of ["modelPolicy", "policyDigest", "selectedModel", "modelAttempt", "retryReason", "fallbackReason"]) {
			expect(schema).toContain(`\"${field}\"`);
		}
		for (const kind of ["auto", "preset", "tier", "model"]) expect(schema).toContain(`\"${kind}\"`);
		expect(schema).toContain("reason");
		expect(schema.includes("panel")).toBe(false);
		expect(schema.includes("paneId")).toBe(false);
	});

	test("status and log expose Herdr transport model identity and frozen policy fields", () => {
		const { store } = fixture();
		const state = store.initRun("ux-story", "build", "Build UX", fallbackPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0]!;
		const digest = next.policy.digest;
		const agentId = store.registerAgent({ runId: state.runId, name: "thinker-1", node: "thinker_plan", role: "thinker", transport: "herdr", herdrAgent: "dg-ux-thinker-1", tabId: "w1:t2", herdrPaneId: "w1:p2", policyDigest: digest, selectedModel: SOL_MODEL, modelAttempt: 0, currentTask: operation.task });
		store.record({ runId: state.runId, operationId: operation.id, status: "running", agentId, agentName: "thinker-1", transport: "herdr", modelPolicy: next.policy.input, policyDigest: digest, selectedModel: SOL_MODEL, modelAttempt: 0 });
		const status = renderStatus(store, state.runId);
		const log = renderLog(store, state.runId);
		expect(status).toContain(`policy=Strong | digest=${digest}`);
		expect(status).toContain(`thinker-1 | thinker_plan | herdr | Strong | reasoning | ${SOL_MODEL} | 1/2 | running`);
		expect(status).toContain("2026-08-17T12:00:00.000Z");
		expect(log).toContain("supervisor -> thinker-1");
		expect(log).toContain("reply_to=supervisor");
		expect(log).toContain("policy=Strong");
		expect(log).toContain("tier=reasoning");
		expect(log).toContain(`model=${SOL_MODEL}`);
		expect(log).toContain("attempt=1/2");
		expect(log).toContain(`digest=${digest}`);
		expect(log).toContain("message=Build UX");
		store.close();
	});

	test("status and log are on-demand and schedule no polling timers", () => {
		const { store } = fixture();
		const state = store.initRun("timer-ux", "research", "Inspect");
		const original = globalThis.setTimeout;
		let timers = 0;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			timers += 1;
			return original(...args);
		}) as typeof setTimeout;
		try {
			renderStatus(store, state.runId);
			renderLog(store, state.runId);
		} finally {
			globalThis.setTimeout = original;
			store.close();
		}
		expect(timers).toBe(0);
	});

	test("retry exhaustion emits the focus trio and asks for an in-session decision", async () => {
		const { store } = fixture();
		const state = store.initRun("recovery-ux", "build", "Recover");
		const operation = store.next(state.runId).operations[0];
		store.record({ runId: state.runId, operationId: operation.id, status: "running", transport: "herdr" });
		store.record({ runId: state.runId, operationId: operation.id, status: "failed", error: "compile error" });
		const calls: string[][] = [];
		const fakePi = {
			exec: async (command: string, args: string[]) => {
				calls.push([command, ...args]);
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		} as unknown as ExtensionAPI;
		const fakeContext = {
			mode: "tui",
			ui: {
				select: async () => "Retry now",
			},
		} as unknown as ExtensionContext;
		const { resolveUserDecision } = await import("../index.ts");
		const decision = await resolveUserDecision(fakePi, fakeContext, store, state.runId, operation.id);
		expect(decision.action).toBe("retry");
		expect(calls.map((call) => call[0])).toEqual(["afplay", "say", "osascript"]);
		expect(store.getState(state.runId).status).toBe("active");
		store.close();
	});

	test("defer, abort, and escalate recovery choices update durable state", async () => {
		const { resolveUserDecision } = await import("../index.ts");
		for (const [choice, expected] of [
			["Defer", "deferred"],
			["Abort", "cancelled"],
			["Escalate", "blocked"],
		] as const) {
			const { store } = fixture();
			const state = store.initRun(`recovery-${choice}`, "build", "Recover");
			const operation = store.next(state.runId).operations[0];
			store.record({ runId: state.runId, operationId: operation.id, status: "running", transport: "herdr" });
			store.record({ runId: state.runId, operationId: operation.id, status: "failed", error: "compile error" });
			const calls: string[][] = [];
			const fakePi = {
				exec: async (command: string, args: string[]) => {
					calls.push([command, ...args]);
					return { code: 0, stdout: "", stderr: "", killed: false };
				},
			} as unknown as ExtensionAPI;
			const fakeContext = {
				mode: "tui",
				ui: {
					select: async () => choice,
					input: async () => "+15m",
				},
			} as unknown as ExtensionContext;
			const decision = await resolveUserDecision(fakePi, fakeContext, store, state.runId, operation.id);
			expect(store.getState(state.runId).status).toBe(expected);
			if (choice === "Defer") {
				expect(decision.action).toBe("defer");
				expect(calls.map((call) => call[0])).toContain("plutil");
				expect(calls.map((call) => call[0])).toContain("launchctl");
			}
			store.close();
		}
	});

	test("production registration maps graph nodes to persisted attempt roles", () => {
		expect(["thinker_plan", "thinker_synthesize", "implement", "review", "test", "audit", "search"].map((node) => roleForNode(node as Parameters<typeof roleForNode>[0]))).toEqual(["thinker", "thinker", "implementer", "reviewer", "tester", "auditor", "searcher"]);
		const source = readFileSync(join(process.cwd(), "extensions/pi-agent-wave/index.ts"), "utf8");
		expect(source).toContain("role: roleForNode(operation.node)");
		expect(source.includes("role: operation.node")).toBe(false);
	});

	test("Herdr identity and focus use native role names and fails explicitly outside Herdr", async () => {
		expect(herdrAgentName("Story One", "Implementer", 2)).toBe("dg-story-one-implementer-2");
		expect(herdrTabLabel("Story One", "Implementer", 2)).toBe("Story One: Implementer-2");
		const calls: string[][] = [];
		await focusHerdrAgent("dg-story-one-implementer-2", async (command, args) => {
			calls.push([command, ...args]);
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		expect(calls).toEqual([["herdr", "agent", "focus", "dg-story-one-implementer-2"]]);
		await assert.rejects(
			focusRegisteredAgent(
				[{ name: "implementer-2", node: "implement", herdr_agent: "dg-story-one-implementer-2" }],
				"implementer-2",
				false,
				async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			),
			/outside Herdr/,
		);
	});

	test("writes a private valid one-shot launchd fixture", () => {
		const { dir, store } = fixture();
		const runAt = parseDeferredTime("+15m", new Date("2026-08-17T12:00:00.000Z"));
		const job = writeDeferredJob({ home: dir, runId: "run-1", operationId: "op-1", runAt, piPath: "/usr/local/bin/pi", uid: 501 });
		const plist = readFileSync(job.plistPath, "utf8");
		expect(plist).toContain("<key>StartCalendarInterval</key>");
		expect(plist).toContain(job.runnerPath);
		expect(plist).toContain("--experimental-strip-types");
		expect(plist).toContain("/usr/local/bin/pi");
		expect(plist.includes("/bin/zsh")).toBe(false);
		expect(plist.includes(".sh</string>")).toBe(false);
		expect(statSync(job.plistPath).mode & 0o777).toBe(0o600);
		const lint = spawnSync("plutil", ["-lint", job.plistPath]);
		expect(lint.status).toBe(0);
		store.close();
	});

	test("parses --policy and leaves the task untouched", () => {
		expect(parsePolicyArg("--policy auto")).toEqual({ policy: { kind: "auto" }, task: "" });
		expect(parsePolicyArg("--policy balanced Implement the feature")).toEqual({ policy: { kind: "preset", preset: "balanced" }, task: "Implement the feature" });
		expect(parsePolicyArg("--policy strong")).toEqual({ policy: { kind: "preset", preset: "strong" }, task: "" });
		expect(parsePolicyArg("Implement the feature")).toEqual({ policy: null, task: "Implement the feature" });
		expect(() => parsePolicyArg("--policy")).toThrow(/requires a value/);
		expect(() => parsePolicyArg("--policy nonsense")).toThrow(/unknown policy/);
	});

	test("maps friendly policy names to inputs and rejects unknowns", () => {
		expect(policyInputFromName("auto")).toEqual({ kind: "auto" });
		expect(policyInputFromName("cheap")).toEqual({ kind: "preset", preset: "cheap" });
		expect(policyInputFromName("long-context")).toEqual({ kind: "preset", preset: "long-context" });
		expect(() => policyInputFromName("bogus")).toThrow(/unknown policy/);
	});

	test("selects friendly policies exactly, bypasses explicit policy, and treats cancellation as auto", async () => {
		expect(POLICY_PICKER_OPTIONS).toEqual([
			"Auto (recommended)",
			"Economy",
			"Balanced",
			"Strong",
			"Local only",
			"Long context",
		]);
		expect(POLICY_PICKER_TITLE).toContain("Capability floors may promote");
		expect(POLICY_PICKER_TITLE).toContain("Local only");
		expect(POLICY_PICKER_TITLE).toContain("fails closed before dispatch");

		const headless = { mode: "headless" } as unknown as ExtensionContext;
		expect(await pickPolicy(headless, null)).toEqual({ kind: "auto" });

		let selectCalls = 0;
		const explicitCtx = {
			mode: "tui",
			ui: { select: async () => { selectCalls += 1; return "Balanced"; } },
		} as unknown as ExtensionContext;
		expect(await pickPolicy(explicitCtx, { kind: "preset", preset: "strong" })).toEqual({ kind: "preset", preset: "strong" });
		expect(selectCalls).toBe(0);

		let selectedTitle = "";
		let selectedOptions: string[] = [];
		const chosenCtx = {
			mode: "tui",
			ui: {
				select: async (title: string, options: string[]) => {
					selectedTitle = title;
					selectedOptions = options;
					return "Economy";
				},
			},
		} as unknown as ExtensionContext;
		expect(await pickPolicy(chosenCtx, null)).toEqual({ kind: "preset", preset: "cheap" });
		expect(selectedTitle).toBe(POLICY_PICKER_TITLE);
		expect(selectedOptions).toEqual(POLICY_PICKER_OPTIONS);

		const cancelledCtx = { mode: "tui", ui: { select: async () => undefined } } as unknown as ExtensionContext;
		expect(await pickPolicy(cancelledCtx, null)).toEqual({ kind: "auto" });
	});

	test("resolves a policy through the shared resolver seam and fails closed", async () => {
		const calls: string[][] = [];
		const exec = async (command: string, args: string[]) => {
			calls.push([command, ...args]);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					roles: [{ role: "thinker", tier: "reasoning", models: ["alibaba/qwen3.8-max", "opencode-go/glm-5.2"], thinking: "high", session: true, capabilityFloor: "planning", promoted: false, promotedFrom: null }],
				}),
				stderr: "",
			};
		};
		const resolved = await resolvePolicy({ kind: "auto" }, exec);
		expect(resolved.input).toEqual({ kind: "auto" });
		expect(resolved.routes[0]?.role).toBe("thinker");
		expect(resolved.routes[0]?.chain).toEqual(["alibaba/qwen3.8-max", "opencode-go/glm-5.2"]);
		expect(calls[0]?.[0]).toBe("node");
		expect(calls[0]?.includes("--input")).toBe(true);
		await assert.rejects(resolvePolicy({ kind: "auto" }, async () => ({ exitCode: 1, stdout: "", stderr: "resolver missing" })), /policy resolver failed/);
		await assert.rejects(resolvePolicy({ kind: "tier", tier: "nope" }, async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: false, roles: [], errors: ["unknown tier 'nope'"] }), stderr: "" })), /unknown tier 'nope'/);
	});

	test("propagates an exact model-policy input through resolution and frozen dispatch", async () => {
		const input = exactPolicy().input;
		let resolverInput: unknown;
		const resolved = await resolvePolicy(input, async (command, args) => {
			expect(command).toBe("node");
			const inputIndex = args.indexOf("--input");
			assert.ok(inputIndex >= 0);
			resolverInput = JSON.parse(args[inputIndex + 1] ?? "null");
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					roles: [{ role: "thinker", tier: "exact", models: [SOL_MODEL], thinking: "high", session: true, capabilityFloor: "planning", promoted: false, promotedFrom: null }],
				}),
				stderr: "",
			};
		});
		expect(resolverInput).toEqual(input);
		expect(resolved.input).toEqual(input);
		expect(resolved.routes[0]?.role).toBe("thinker");
		expect(resolved.routes[0]?.tier).toBe("exact");
		expect(resolved.routes[0]?.chain).toEqual([SOL_MODEL]);
		expect(resolved.routes[0]?.promoted).toBe(false);

		const { store } = fixture();
		const state = store.initRun("exact-policy", "build", "Plan", resolved);
		const next = store.next(state.runId);
		expect(next.policy.input).toEqual(input);
		expect(next.operations[0]?.route?.chain).toEqual([SOL_MODEL]);
		expect(next.operations[0]?.route?.tier).toBe("exact");
		const operation = next.operations[0]!;
		const agentId = store.registerAgent({
			runId: state.runId,
			name: "exact-thinker",
			node: "thinker_plan",
			role: "thinker",
			transport: "herdr",
			herdrAgent: "dg-exact-thinker-1",
			tabId: "tab-exact",
			herdrPaneId: "pane-exact",
			policyDigest: next.policy.digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
			currentTask: operation.task,
		});
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			agentId,
			agentName: "exact-thinker",
			transport: "herdr",
			modelPolicy: input,
			policyDigest: next.policy.digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
		});
		const registered = store.agents(state.runId)[0]!;
		expect(registered.policy_digest).toBe(next.policy.digest);
		expect(registered.selected_model).toBe(SOL_MODEL);
		expect(registered.model_attempt).toBe(0);
		expect(() => store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			agentId,
			transport: "herdr",
			modelPolicy: { kind: "auto" },
			policyDigest: next.policy.digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
		})).toThrow(/model policy.*frozen|conflict/i);
		store.close();
	});

	test("records zero-based primary and fallback routes emitted by the Herdr launcher", () => {
		const dir = mkdtempSync("/tmp/delegate-graph-command-launcher-");
		dirs.push(dir);
		const binDir = join(dir, "bin");
		mkdirSync(binDir);
		const taskPath = join(dir, "task.txt");
		writeFileSync(taskPath, "Return an evidence report.\n", { mode: 0o600 });
		writeFileSync(join(binDir, "herdr"), `#!/bin/sh
if [ "$1 $2" = "integration status" ]; then
  echo "pi: current (v8) (/tmp/fake/herdr-agent-state.ts)"
elif [ "$1 $2" = "tab create" ]; then
  echo '{"result":{"tab":{"tab_id":"w-test:t2"},"root_pane":{"pane_id":"w-test:p2"}}}'
elif [ "$1 $2" = "agent start" ] && [ -n "$FAKE_TRANSIENT_MODEL" ]; then
  case " $* " in
    *" --model $FAKE_TRANSIENT_MODEL "*) echo "provider unavailable: HTTP 429" >&2; exit 1 ;;
  esac
fi
exit 0
`);
		chmodSync(join(binDir, "herdr"), 0o700);
		const helper = new URL("../scripts/herdr_delegate.py", import.meta.url).pathname;
		const baseEnv = {
			...process.env,
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w-test:p1",
			HERDR_TAB_ID: "w-test:t1",
			HERDR_WORKSPACE_ID: "w-test",
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		};
		const launch = (args: string[]): HerdrStartResult => {
			const init = spawnSync("python3", [helper, "init", "command contract"], {
				encoding: "utf8",
				env: baseEnv,
			});
			assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
			const runDir = init.stdout.trim();
			dirs.push(runDir);
			const result = spawnSync("python3", [helper, "start", runDir, "Thinker", ...args], {
				encoding: "utf8",
				env: baseEnv,
			});
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			return JSON.parse(result.stdout) as HerdrStartResult;
		};

		const { store } = fixture();
		for (const scenario of [
			{ policy: exactPolicy(), expectedModel: SOL_MODEL, expectedAttempt: 0, fallbackReason: null },
			{ policy: fallbackPolicy(), expectedModel: FALLBACK_MODEL, expectedAttempt: 1, fallbackReason: "http-429" },
		] as const) {
			const state = store.initRun(`launcher-${scenario.expectedAttempt}`, "build", "Plan", scenario.policy);
			const next = store.next(state.runId);
			const operation = next.operations[0]!;
			const reportPath = join(dir, `report-${scenario.expectedAttempt}.json`);
			const commonArgs = [
				"--policy", modelPolicyLabel(next.policy.input),
				"--policy-digest", next.policy.digest,
				"--report", reportPath,
				"--task-file", taskPath,
			];
			const launcher = scenario.expectedAttempt === 0
				? launch(["--model", SOL_MODEL, "--reason", "cross-contract exact lock", ...commonArgs])
				: launch([
					"--model", FALLBACK_MODEL,
					"--reason", "frozen fallback after http-429",
					"--model-attempt", "1",
					"--fallback-reason", "http-429",
					...commonArgs,
				]);
			expect(launcher["policy-digest"]).toBe(next.policy.digest);
			expect(launcher.model).toBe(scenario.expectedModel);
			expect(launcher["model-attempt"]).toBe(scenario.expectedAttempt);
			expect(launcher["fallback-reason"]).toBe(scenario.fallbackReason);

			const agentId = store.registerAgent({
				runId: state.runId,
				name: launcher.agent,
				node: operation.node,
				role: "thinker",
				transport: "herdr",
				herdrAgent: launcher.agent,
				tabId: launcher.tab,
				herdrPaneId: launcher.pane,
				policyDigest: launcher["policy-digest"],
				selectedModel: launcher.model,
				modelAttempt: launcher["model-attempt"],
				currentTask: operation.task,
			});
			const recorded = store.record({
				runId: state.runId,
				operationId: operation.id,
				status: "running",
				agentId,
				agentName: launcher.agent,
				transport: "herdr",
				modelPolicy: next.policy.input,
				policyDigest: launcher["policy-digest"],
				selectedModel: launcher.model,
				modelAttempt: launcher["model-attempt"],
				fallbackReason: launcher["fallback-reason"] ?? undefined,
			});
			expect(recorded.operation.selected_model).toBe(scenario.expectedModel);
			expect(recorded.operation.model_attempt).toBe(scenario.expectedAttempt);
		}
		store.close();
	});

	test("freezes resolved routes against caller mutation and database reopen", () => {
		const { dir, store } = fixture();
		const supplied = fallbackPolicy();
		const state = store.initRun("frozen-route", "build", "Plan", supplied);
		const digest = store.policy(state.runId).digest;
		supplied.input = { kind: "auto" };
		supplied.routes[0]!.chain.splice(0, supplied.routes[0]!.chain.length, "mutated/model");

		const firstRead = store.next(state.runId);
		expect(firstRead.policy.digest).toBe(digest);
		expect(firstRead.policy.input).toEqual({ kind: "preset", preset: "strong" });
		expect(firstRead.operations[0]?.route?.chain).toEqual([SOL_MODEL, "anthropic/claude-opus-4-1"]);
		store.close();

		const reopened = new GraphStore({ dbPath: join(dir, "graph.db") });
		const resumed = reopened.next(state.runId);
		expect(resumed.policy.digest).toBe(digest);
		expect(resumed.operations[0]?.route?.chain).toEqual([SOL_MODEL, "anthropic/claude-opus-4-1"]);
		reopened.close();
	});

	test("deferred resume targets the existing run and reuses its frozen digest", () => {
		const { dir, store } = fixture();
		const state = store.initRun("deferred-policy", "build", "Plan", exactPolicy());
		const operation = store.next(state.runId).operations[0]!;
		const digest = store.policy(state.runId).digest;
		const job = writeDeferredJob({
			home: dir,
			runId: state.runId,
			operationId: operation.id,
			policyDigest: digest,
			runAt: new Date("2026-08-18T12:00:00.000Z"),
			piPath: "/usr/local/bin/pi",
			uid: 501,
		});
		const plist = readFileSync(job.plistPath, "utf8");
		expect(plist).toContain(`run ${state.runId}`);
		expect(plist).toContain(`operation ${operation.id}`);
		expect(plist).toContain(`frozen policy digest is ${digest}`);
		expect(plist.includes("--policy")).toBe(false);
		expect(plist.includes("Choose model policy")).toBe(false);
		store.close();

		const resumed = new GraphStore({ dbPath: join(dir, "graph.db") });
		expect(resumed.policy(state.runId).digest).toBe(digest);
		expect(resumed.next(state.runId).operations[0]?.route?.chain).toEqual([SOL_MODEL]);
		resumed.close();
	});

	test("makes transient cross-model fallback explicit in events, status, and log", () => {
		const { store } = fixture();
		const state = store.initRun("fallback-visibility", "build", "Plan", fallbackPolicy());
		const next = store.next(state.runId);
		const operation = next.operations[0]!;
		const digest = next.policy.digest;
		const agentId = store.registerAgent({
			runId: state.runId,
			name: "fallback-thinker",
			node: "thinker_plan",
			role: "thinker",
			transport: "herdr",
			herdrAgent: "dg-fallback-thinker",
			tabId: "workspace:tab",
			herdrPaneId: "workspace:pane",
			policyDigest: digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
			currentTask: operation.task,
		});
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			agentId,
			agentName: "fallback-thinker",
			transport: "herdr",
			modelPolicy: fallbackPolicy().input,
			policyDigest: digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
		});
		const failed = store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "failed",
			agentId,
			agentName: "fallback-thinker",
			error: "HTTP 503 during provider launch",
			modelPolicy: fallbackPolicy().input,
			policyDigest: digest,
			selectedModel: SOL_MODEL,
			modelAttempt: 0,
			retryReason: "provider-launch",
			fallbackReason: "http-503",
		});
		expect(failed.retry?.modelAttempt).toBe(0);
		expect(failed.retry?.selectedModel).toBe(SOL_MODEL);
		store.record({
			runId: state.runId,
			operationId: operation.id,
			status: "running",
			agentId,
			agentName: "fallback-thinker",
			transport: "herdr",
			modelPolicy: fallbackPolicy().input,
			policyDigest: digest,
			selectedModel: "anthropic/claude-opus-4-1",
			modelAttempt: 1,
			retryReason: "provider-launch",
			fallbackReason: "http-503",
		});
		const events = store.events(state.runId);
		expect(events.some((event) => event.type === "model_selected")).toBe(true);
		expect(events.some((event) => event.type === "model_fallback")).toBe(true);
		const log = renderLog(store, state.runId);
		expect(log).toContain("model_selected");
		expect(log).toContain("model_fallback");
		expect(log).toContain("fallback=http-503");
		expect(log).toContain("model=anthropic/claude-opus-4-1");
		expect(log).toContain("attempt=2/2");
		store.close();
	});

	test("resolves auto against the real policy-resolver.mjs", async () => {
		const script = new URL("../scripts/policy-resolver.mjs", import.meta.url).pathname;
		const exec = async (command: string, args: string[]) => {
			expect(command).toBe("node");
			expect(args[0]).toBe(script);
			const child = spawnSync("node", args, { encoding: "utf8" });
			return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
		};
		const resolved = await resolvePolicy({ kind: "auto" }, exec);
		assert.ok(resolved.routes.length > 0);
		const thinker = resolved.routes.find((route) => route.role === "thinker");
		expect(thinker?.tier).toBe("reasoning");
		assert.ok((thinker?.chain.length ?? 0) > 0);
		const roles = resolved.routes.map((route) => route.role).sort();
		expect(roles).toEqual(["auditor", "implementer", "reviewer", "searcher", "tester", "thinker"]);
	});

	test("Herdr labels include the friendly policy and selected model", () => {
		expect(shortModelName(SOL_MODEL)).toBe("gpt-5.6-sol");
		expect(modelPolicyLabel({ kind: "preset", preset: "strong" })).toBe("Strong");
		expect(herdrTabLabel("Story One", "Implementer", 2, SOL_MODEL, "Strong")).toBe("Story One: Implementer-2 [Strong] @ gpt-5.6-sol");
		expect(herdrTabLabel("Story One", "Thinker")).toBe("Story One: Thinker");
	});
});
