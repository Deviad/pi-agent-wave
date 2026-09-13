import { describe, expect, test } from "./harness.ts";
import { classifyFailure, retryDelayMs } from "../retry.ts";

const transient = [
	"HTTP 429",
	"HTTP 500",
	"502 Bad Gateway",
	"503 service unavailable",
	"504 gateway timeout",
	"rate limit reached",
	"quota exhausted",
	"provider overloaded",
	"ETIMEDOUT",
	"ECONNRESET",
	"connection closed",
	"delegate report REPORT_UNAVAILABLE: worker ended without a report file",
	"headless worker exited before result: no diagnostic output",
	"ACPX worker result timed out: /tmp/attempt/worker-result.json",
	"ACPX prompt result timed out: /tmp/attempt/worker-repair-1-result.json",
	"runtime configuration snapshot changed: /tmp/attempt/runtime-config.json",
	"AgentFS export failed (exit 2): AgentFS audit error (1 total): src/a.ts [audit_error] agentfs fs cat exited 7",
];

describe("transient failure policy", () => {
	for (const message of transient) {
		test(`classifies ${message}`, () => expect(classifyFailure(message).kind).toBe("transient"));
	}

	test("names the new worker-settlement transient reasons", () => {
		expect(classifyFailure("REPORT_UNAVAILABLE").reason).toBe("worker-report-unavailable");
		expect(classifyFailure("headless worker exited before result").reason).toBe("worker-exited-before-result");
		expect(classifyFailure("ACPX worker result timed out").reason).toBe("timeout");
		expect(classifyFailure("runtime configuration snapshot changed").reason).toBe("runtime-snapshot-churn");
		expect(classifyFailure("AgentFS audit error (2 total)").reason).toBe("agentfs-audit-error");
	});

	test("a genuine unowned-changes export refusal stays permanent", () => {
		expect(classifyFailure("AgentFS export failed (exit 2): unowned changes (1 total): src/escape.ts")).toEqual({ kind: "permanent", reason: "unclassified" });
		expect(classifyFailure("AgentFS contains unowned changes: unowned.txt").kind).toBe("permanent");
		// A lower-case 'report unavailable' in prose is not the worker's REPORT_UNAVAILABLE code.
		expect(classifyFailure("the reviewer said the report unavailable claim was semantic").kind).toBe("permanent");
	});

	test("ownership failures never advance a model because of infrastructure words in paths", () => {
		for (const message of [
			"AgentFS audit error (1 total): /tmp/429 [owned_path_escape] owned path escapes base directory",
			"AgentFS contains unowned changes: quota/500.txt",
			"AgentFS export failed (exit 2): unowned changes (1 total): report-missing.ts",
		]) expect(classifyFailure(message).kind).toBe("permanent");
	});

	test("worker exit and snapshot timeout failures remain retryable", () => {
		expect(classifyFailure("ACPX worker result present but worker process 123 did not exit within 30000ms").kind).toBe("transient");
		expect(classifyFailure("AgentFS snapshot failed: database is locked").kind).toBe("transient");
	});

	test("semantic failures are permanent", () => {
		expect(classifyFailure("HTTP 504 text inside a reviewer report", true)).toEqual({ kind: "permanent", reason: "semantic-verdict" });
		expect(classifyFailure("compile error").kind).toBe("permanent");
	});

	test("uses deterministic full jitter with a five-minute ceiling", () => {
		expect(retryDelayMs(0, () => 0.5)).toBe(15_000);
		expect(retryDelayMs(1, () => 0.5)).toBe(30_000);
		expect(retryDelayMs(10, () => 1)).toBe(300_000);
	});
});
