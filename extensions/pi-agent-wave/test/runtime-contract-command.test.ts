import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelegateArgs } from "../index.ts";

test("/delegate takes only --policy before the task text; result contracts are no longer a flag", () => {
	const expected = { policy: { kind: "preset", preset: "strong" }, task: "research sources\nKeep --policy inside task" };
	assert.deepEqual(parseDelegateArgs("--policy strong research sources\nKeep --policy inside task"), expected);
	assert.deepEqual(parseDelegateArgs("Implement --result-contract legacy-v1 literally"), { policy: null, task: "Implement --result-contract legacy-v1 literally" });
	assert.deepEqual(parseDelegateArgs("--result-contract runtime-v1 task"), { policy: null, task: "--result-contract runtime-v1 task" });
	for (const input of ["--policy", "--policy strong --policy strong task"]) assert.throws(() => parseDelegateArgs(input));
});
