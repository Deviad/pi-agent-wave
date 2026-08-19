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
];

describe("transient failure policy", () => {
	for (const message of transient) {
		test(`classifies ${message}`, () => expect(classifyFailure(message).kind).toBe("transient"));
	}

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
