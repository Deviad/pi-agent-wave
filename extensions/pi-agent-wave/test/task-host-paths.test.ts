import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskPathIssues } from "../lib/task-host-paths.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "task-paths-")));
	roots.push(root);
	mkdirSync(join(root, "workspace"));
	return join(root, "workspace");
}

test("addressing lint is useful and bounded", () => {
	const base = workspace();
	const external = join(base, "..", "outside");
	mkdirSync(external);
	symlinkSync(external, join(base, "link"));
	const task = 'Read ~/a/b, $HOME/a and ${HOME}/a. Check /tmp and /. Read "~/quoted name." and `~/code`. Use --file=/outside/a; then ../outside/b and ' + join(base, "link", "missing", "..", "c");
	const issues = taskPathIssues(task, base);
	assert.deepEqual(issues.map((issue) => issue.token), ["~/a/b", "$HOME/a", "${HOME}/a", "/tmp", "/", "~/quoted name.", "~/code", "/outside/a", "../outside/b", join(base, "link", "missing", "..", "c")]);
	assert.ok(issues.every((issue) => issue.workspace === base && issue.reason.length > 0));
	assert.deepEqual(taskPathIssues('/graph watch; /delegate research; /failover; https://example.com/a/b src/a.ts ./a.ts ' + join(base, "src", "a.ts"), base), []);
	assert.deepEqual(taskPathIssues("The value is 1/2 and https://example.com/?path=/tmp/a", base), []);
	assert.equal(taskPathIssues("Read /graph", base).length, 1, "a command name in file position is not exempt");
});
