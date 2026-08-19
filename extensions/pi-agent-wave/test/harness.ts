import assert from "node:assert/strict";
export { afterEach, describe, test } from "node:test";

const ARRAY_CONTAINING = Symbol("array-containing");
interface ArrayContaining {
	[ARRAY_CONTAINING]: unknown[];
}

function isArrayContaining(value: unknown): value is ArrayContaining {
	return Boolean(value && typeof value === "object" && ARRAY_CONTAINING in value);
}

interface Expectation {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toContain(expected: unknown): void;
	toHaveLength(expected: number): void;
	toThrow(expected?: string | RegExp): void;
}

/** Minimal assertion vocabulary shared by the Node test files. */
export function expect(actual: unknown): Expectation {
	return {
		toBe: (expected) => assert.strictEqual(actual, expected),
		toEqual: (expected) => {
			if (isArrayContaining(expected)) {
				assert.ok(Array.isArray(actual), "actual value must be an array");
				for (const item of expected[ARRAY_CONTAINING]) assert.ok(actual.includes(item), `missing array item ${String(item)}`);
				return;
			}
			assert.deepStrictEqual(actual, expected);
		},
		toContain: (expected) => {
			if (typeof actual === "string") assert.ok(actual.includes(String(expected)), `expected string to contain ${String(expected)}`);
			else if (Array.isArray(actual)) assert.ok(actual.includes(expected), `expected array to contain ${String(expected)}`);
			else throw new Error("toContain requires a string or array");
		},
		toHaveLength: (expected) => {
			if (!actual || typeof (actual as { length?: unknown }).length !== "number") throw new Error("toHaveLength requires a length property");
			assert.strictEqual((actual as { length: number }).length, expected);
		},
		toThrow: (expected) => {
			assert.equal(typeof actual, "function", "toThrow requires a function");
			assert.throws(actual as () => unknown, expected ? (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				return typeof expected === "string" ? message.includes(expected) : expected.test(message);
			} : undefined);
		},
	};
}

expect.arrayContaining = (items: unknown[]): ArrayContaining => ({ [ARRAY_CONTAINING]: items });
