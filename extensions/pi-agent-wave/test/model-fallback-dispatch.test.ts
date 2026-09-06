import { afterEach, describe, expect, test } from "./harness.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import type { ModelPolicyInput, PolicyRoute, ResolvedPolicy } from "../types.ts";

const dirs: string[] = [];

function fixture(): GraphStore {
	const dir = mkdtempSync(join(tmpdir(), "delegate-graph-fallback-"));
	dirs.push(dir);
	return new GraphStore({ dbPath: join(dir, "graph.db"), now: () => new Date("2026-09-06T07:00:00.000Z"), random: () => 0.5 });
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function chainPolicy(chain: string[], input: ModelPolicyInput): ResolvedPolicy {
	const route: PolicyRoute = {
		role: "thinker",
		tier: input.kind === "model" ? "exact" : "reasoning",
		chain,
		thinking: "high",
		session: true,
		capabilityFloor: "planning",
		selectionSource: input.kind === "model" ? "exact-model" : "preset:balanced",
		promoted: false,
		promotionReason: null,
	};
	return { input, routes: [route] };
}

/** Starts the thinker planning operation on chain[0] and returns its dispatch binding. */
function startPlanning(store: GraphStore, chain: string[], input: ModelPolicyInput): { runId: string; operationId: string } {
	const preset = chainPolicy(chain, input);
	const state = store.initRun("route-resilience", "build", "Plan", preset);
	const next = store.next(state.runId);
	const operation = next.operations[0]!;
	store.record({
		runId: state.runId,
		operationId: operation.id,
		status: "running",
		transport: "herdr",
		agentName: "thinker-1",
		modelPolicy: next.policy.input,
		policyDigest: next.policy.digest,
		selectedModel: chain[operation.model_attempt],
		modelAttempt: operation.model_attempt,
	});
	return { runId: state.runId, operationId: operation.id };
}

/** Spends the whole same-model transient budget on the operation's current model. */
function exhaustModelBudget(store: GraphStore, runId: string, operationId: string, error = "provider returned 429 rate limit") {
	let last;
	for (let attempt = 0; attempt < 4; attempt += 1) last = store.record({ runId, operationId, status: "failed", error });
	return last!;
}

describe("frozen chain failover", () => {
	test("advances to the next frozen model once the current model's transient budget is exhausted", () => {
		const store = fixture();
		const chain = ["alibaba/dead-primary", "openai-codex/live-secondary"];
		const { runId, operationId } = startPlanning(store, chain, { kind: "preset", preset: "balanced" });

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const retrying = store.record({ runId, operationId, status: "failed", error: "provider returned 429 rate limit" });
			expect(retrying.retry?.modelAttempt).toBe(0);
			expect(retrying.operation.model_attempt).toBe(0);
			expect(retrying.operation.fallback_reason).toBe(null);
			expect(retrying.operation.retry_reason).toBe("http-429");
		}

		const advanced = store.record({ runId, operationId, status: "failed", error: "provider returned 429 rate limit" });
		expect(advanced.operation.model_attempt).toBe(1);
		expect(advanced.operation.selected_model).toBe("openai-codex/live-secondary");
		expect(advanced.operation.fallback_reason).toBe("http-429");
		expect(advanced.operation.transient_attempts).toBe(0);
		expect(typeof advanced.operation.retry_not_before).toBe("string");
		expect(advanced.state.status).toBe("active");

		const pending = store.next(runId).operations.find((candidate) => candidate.id === operationId);
		expect(pending?.model_attempt).toBe(1);
		expect(pending?.route?.chain[pending.model_attempt]).toBe("openai-codex/live-secondary");

		const events = store.events(runId).filter((event) => event.type === "model_fallback");
		expect(events.length).toBe(1);
		expect(store.events(runId).filter((event) => event.type === "retry_exhausted").length).toBe(0);
		const payload = JSON.parse(events[0]!.payload_json);
		expect(payload.modelAttempt).toBe(1);
		expect(payload.selectedModel).toBe("openai-codex/live-secondary");
		expect(payload.fallbackReason).toBe("http-429");
		expect(store.policy(runId).digest).toBe(store.next(runId).policy.digest);
		store.close();
	});

	test("parks for a user decision once the whole frozen chain is exhausted", () => {
		const store = fixture();
		const { runId, operationId } = startPlanning(store, ["alibaba/dead-primary", "openai-codex/also-dead"], { kind: "preset", preset: "balanced" });
		exhaustModelBudget(store, runId, operationId);
		const parked = exhaustModelBudget(store, runId, operationId, "ETIMEDOUT while prompting the worker");
		expect(parked.operation.model_attempt).toBe(1);
		expect(parked.operation.selected_model).toBe("openai-codex/also-dead");
		expect(parked.state.status).toBe("awaiting_user");
		expect(parked.requiresUserDecision).toBe(true);
		expect(store.events(runId).filter((event) => event.type === "retry_exhausted").length).toBe(1);
		store.close();
	});

	test("treats a settled attempt with no authored report as a transient failure that fails over", () => {
		const store = fixture();
		const chain = ["alibaba/silent-provider", "openai-codex/answering-provider"];
		const { runId, operationId } = startPlanning(store, chain, { kind: "preset", preset: "balanced" });
		const reason = "worker exited without authoring its report (report-missing): the settled attempt carries only the execution-only projection";
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const retrying = store.record({ runId, operationId, status: "failed", error: reason });
			expect(retrying.operation.retry_reason).toBe("worker-report-missing");
			expect(retrying.operation.model_attempt).toBe(0);
		}
		const advanced = store.record({ runId, operationId, status: "failed", error: reason });
		expect(advanced.operation.model_attempt).toBe(1);
		expect(advanced.operation.selected_model).toBe("openai-codex/answering-provider");
		expect(advanced.operation.fallback_reason).toBe("worker-report-missing");
		store.close();
	});

	test("advances the chain when a worker preflight reports an unusable provider credential", () => {
		const store = fixture();
		const chain = ["alibaba/keychain-only", "openai-codex/usable-provider"];
		const { runId, operationId } = startPlanning(store, chain, { kind: "preset", preset: "balanced" });
		const error = 'worker preflight: provider "alibaba" has no usable credential for alibaba/keychain-only (provider_not_found)';
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const retrying = store.record({ runId, operationId, status: "failed", error });
			expect(retrying.operation.retry_reason).toBe("worker-credential-preflight");
		}
		const advanced = store.record({ runId, operationId, status: "failed", error });
		expect(advanced.operation.model_attempt).toBe(1);
		expect(advanced.operation.selected_model).toBe("openai-codex/usable-provider");
		expect(advanced.operation.fallback_reason).toBe("worker-credential-preflight");
		store.close();
	});

	test("never advances an exact-model lock", () => {
		const store = fixture();
		const locked = ["claude-code/claude-opus-5"];
		const { runId, operationId } = startPlanning(store, locked, { kind: "model", model: locked[0]!, reason: "user pinned this model" });
		const result = exhaustModelBudget(store, runId, operationId);
		expect(result.operation.model_attempt).toBe(0);
		expect(result.operation.selected_model).toBe(locked[0]);
		expect(result.operation.fallback_reason).toBe(null);
		expect(result.state.status).toBe("awaiting_user");
		expect(store.events(runId).some((event) => event.type === "model_fallback")).toBe(false);
		store.close();
	});
});
