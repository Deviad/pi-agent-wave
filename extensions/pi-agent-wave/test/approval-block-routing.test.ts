import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { classifyFailure, selectModelFallback } from "../retry.ts";
import { detectApprovalBlock } from "../scripts/acpx-worker.ts";
import { classifyFailoverError } from "../lib/model-failover-native.mjs";

// Resolved from this file so the suite reports the same result from the repository root or the package directory.
const DRIVER = new URL("./support/approval-block-driver.py", import.meta.url).pathname;

/** Runs one real worker-result shape through the production `wait_for_settled_agent` reader. */
function observe(caseName: string): { case: string; raised: string | null; exitCode: number; terminalKind: string } {
	const result = spawnSync("python3", [DRIVER, caseName], { cwd: process.cwd(), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const CHAIN = ["openai-codex/gpt-6-astra", "anthropic/some-other-model"] as const;

describe("approval block routing", () => {
	for (const caseName of ["denied-completed", "denied-terminal-failed"]) {
		test(`${caseName} is not a transient failure and never advances the frozen chain`, () => {
			const observed = observe(caseName);
			assert.ok(observed.raised !== null, "a denied attempt must still settle as a failure");
			assert.match(observed.raised, /permission/i, `the raised reason must name the block, got: ${observed.raised}`);
			assert.equal(classifyFailure(observed.raised).kind, "permanent", `approval block must not be retryable: ${observed.raised}`);
			const fallback = selectModelFallback(CHAIN, 0, observed.raised);
			assert.equal(fallback.advance, false, `approval block must never fall back to another model: ${observed.raised}`);
		});
	}

	test("a denial wrapped in runtime-failure text still reads as a block, not as retryable infrastructure", () => {
		for (const wrapped of [
			"ACPX worker failed: Permission denied for terminal/create",
			"terminal=failed permission_denied",
			"Permission request denied or cancelled",
		]) {
			assert.equal(classifyFailure(wrapped).kind, "permanent", wrapped);
			assert.equal(selectModelFallback(CHAIN, 0, wrapped).advance, false, wrapped);
		}
	});

	test("both classifiers refuse a denial even when the provider marks it retryable", () => {
		// Worker-settlement classification and provider failover are separate lanes; this pins that they
		// do not disagree, so a refused command is never replayed on a model further down the chain.
		for (const denial of [
			"worker approval block: permission_denied exit=5 terminal=completed",
			"terminal=failed permission_denied",
			"Permission request denied or cancelled",
			"ACPX worker failed: Permission denied for terminal/create",
		]) {
			assert.equal(classifyFailure(denial).kind, "permanent", denial);
			const message = { role: "assistant", stopReason: "error", errorMessage: denial };
			assert.equal(classifyFailoverError(message, { isRetryableAssistantError: () => true }).kind, "terminal", denial);
		}
	});

	test("a genuine transport fault stays retryable in both classifiers", () => {
		const transport = "QUEUE_RUNTIME_PROMPT_FAILED connection reset by peer";
		assert.equal(classifyFailure(transport).kind, "transient", transport);
		const message = { role: "assistant", stopReason: "error", errorMessage: transport };
		assert.equal(classifyFailoverError(message, { isRetryableAssistantError: () => true }).kind, "ordinary", transport);
	});

	test("genuine infrastructure failures stay retryable and still advance the chain", () => {
		const observed = observe("genuine-runtime-failure");
		assert.ok(observed.raised !== null);
		assert.equal(classifyFailure(observed.raised).kind, "transient", observed.raised);
		assert.equal(selectModelFallback(CHAIN, 0, observed.raised).advance, true, observed.raised);
		for (const transient of ["HTTP 429 Too Many Requests", "HTTP 503 Service Unavailable", "quota exceeded", "ETIMEDOUT", "connection reset by peer", "timed out after 60s"]) {
			assert.equal(classifyFailure(transient).kind, "transient", transient);
		}
	});

	test("an exact model lock never advances even for a transient failure", () => {
		assert.equal(selectModelFallback(CHAIN, 0, "ACPX worker failed: exit=1 terminal=failed", { exactLock: true }).advance, false);
	});

	test("a block the author reports in prose with a clean terminal is not turned into a failed attempt", () => {
		assert.equal(observe("denied-author-reported").raised, null);
	});

	test("the worker names a denial where it is produced instead of leaving only an exit code", () => {
		// Both denial shapes as the installed acpx CLI reports them, plus a real transport fault that must stay transient.
		assert.equal(detectApprovalBlock(5, "PERMISSION_DENIED runtime Permission request denied or cancelled\n"), true);
		assert.equal(detectApprovalBlock(1, "Permission denied for terminal/create\n"), true);
		assert.equal(detectApprovalBlock(1, "QUEUE_RUNTIME_PROMPT_FAILED connection reset by peer\n"), false);
		assert.equal(detectApprovalBlock(0, ""), false);
	});
});