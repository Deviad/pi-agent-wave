import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { auditAgentFsChanges } from "../lib/agentfs-sandbox.ts";

const DRIVER = join(import.meta.dirname, "support", "owned-path-normalization-driver.py");

// Containment is guaranteed in two layers and neither one is obvious from reading the other:
// delegate_core absolutizes owned paths against the attempt workspace, and the TypeScript audit
// refuses anything that lands outside the sandbox base. The first layer is what stops the audit's
// process-cwd-relative resolve from ever seeing a relative entry, so both halves are pinned here.
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "owned-paths-")));

test("relative owned paths reach the audit as absolute paths inside the attempt workspace", () => {
	const root = workspace();
	try {
		const result = spawnSync("python3", [DRIVER, root], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const { attempt, normalized } = JSON.parse(result.stdout.trim());
		assert.equal(attempt, root, "the driver normalizes the attempt workspace itself");
		assert.deepEqual(normalized, [
			join(root, "agent-output/result.json"),
			join(root, "absolute.txt"),
			resolve(join(root, "..", "escape/outside.txt")),
			join(root, "inside.txt"),
		], "relative entries must absolutize against the attempt workspace, not the launch directory");
		assert.ok(normalized.every((path: string) => path.startsWith("/")), "no relative entry survives normalization");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ownership separates an escaping path from a contained one before the delta is read", () => {
	const root = workspace();
	const failure = (ownedPath: string): string => {
		try {
			auditAgentFsChanges(join(root, "missing.db"), root, [ownedPath]);
			return "";
		} catch (error) {
			return (error as Error).message;
		}
	};
	try {
		// Absence of the containment message is the point: a contained path is allowed through to
		// the delta read, so the escape check is a real gate rather than a blanket refusal.
		assert.match(failure(join(root, "..", "outside.txt")), /escapes base directory/);
		assert.doesNotMatch(failure(join(root, "inside.txt")), /escapes base directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});