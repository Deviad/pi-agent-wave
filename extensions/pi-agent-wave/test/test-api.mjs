import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const api = globalThis.Bun ? await import("bun:test") : await import("node:test");
export const { afterEach, beforeEach, describe, test } = api;

const ANY = Symbol("any");
const ARRAY_CONTAINING = Symbol("arrayContaining");

function matches(actual, expected) {
	if (expected?.[ANY]) {
		if (expected.constructorType === String) return typeof actual === "string";
		if (expected.constructorType === Number) return typeof actual === "number";
		if (expected.constructorType === Boolean) return typeof actual === "boolean";
		return actual instanceof expected.constructorType;
	}
	if (expected?.[ARRAY_CONTAINING]) return Array.isArray(actual) && expected.items.every((item) => actual.some((entry) => matches(entry, item)));
	if (expected && typeof expected === "object" && !Array.isArray(expected)) {
		return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
	}
	return isDeepStrictEqual(actual, expected);
}

function nodeExpect(received, message) {
	const check = (condition, fallback) => assert.ok(condition, message || fallback);
	const matchers = (inverted = false) => {
		const evaluate = (condition, fallback) => check(inverted ? !condition : condition, fallback);
		return {
			toBe(expected) { evaluate(Object.is(received, expected), `expected ${String(received)} ${inverted ? "not " : ""}to be ${String(expected)}`); },
			toEqual(expected) { evaluate(isDeepStrictEqual(received, expected), "values are not deeply equal"); },
			toMatchObject(expected) { evaluate(matches(received, expected), "value does not match object"); },
			toBeUndefined() { evaluate(received === undefined, "value is not undefined"); },
			toContain(expected) { evaluate(received?.includes?.(expected) === true, `value does not contain ${String(expected)}`); },
			toHaveLength(expected) { evaluate(received?.length === expected, `expected length ${expected}, got ${received?.length}`); },
			toStartWith(expected) { evaluate(typeof received === "string" && received.startsWith(expected), `value does not start with ${expected}`); },
			toMatch(expected) { evaluate(typeof received === "string" && expected.test(received), `value does not match ${expected}`); },
			toBeFalse() { evaluate(received === false, "value is not false"); },
			toBeTrue() { evaluate(received === true, "value is not true"); },
		};
	};
	return { ...matchers(), not: matchers(true) };
}

nodeExpect.any = (constructorType) => ({ [ANY]: true, constructorType });
nodeExpect.arrayContaining = (items) => ({ [ARRAY_CONTAINING]: true, items });

export const expect = globalThis.Bun ? api.expect : nodeExpect;
