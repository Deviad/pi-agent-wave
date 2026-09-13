import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeProcess } from "../lib/runtime-process.ts";

test("a real child process settles clean exit, failure, timeout and cancellation independently of reports", async () => {
	for (const kind of ["exited", "failed", "timeout", "cancelled"] as const) {
		const root = mkdtempSync(join(tmpdir(), "runtime-process-"));
		try {
			const controller = new AbortController();
			const timer = kind === "cancelled" ? setTimeout(() => controller.abort(), 100) : undefined;
			const result = await runRuntimeProcess({ executable: process.execPath, args: ["-e", kind === "exited" ? "process.stdout.write('diagnostic\\n')" : kind === "failed" ? "process.exitCode=7" : "setInterval(()=>{}, 1000)"], cwd: root, env: process.env, outputDir: root, identity: { attemptKey: kind, sessionId: "session", requestId: null }, timeoutMs: kind === "timeout" ? 100 : 5000, signal: controller.signal });
			if (timer) clearTimeout(timer);
			assert.equal(result.outcome.kind, kind === "timeout" ? "failed" : kind);
			assert.notEqual(result.capture.captureStatus, "complete");
			assert.deepEqual(JSON.parse(readFileSync(join(root, "runtime-output.json"), "utf8")), result);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});

test("a missing executable and an already-aborted request produce durable outcomes", async () => {
	for (const cancelled of [false, true]) {
		const root = mkdtempSync(join(tmpdir(), "runtime-process-start-"));
		try {
			const controller = new AbortController(); if (cancelled) controller.abort();
			const result = await runRuntimeProcess({ executable: join(root, "absent"), args: [], cwd: root, env: process.env, outputDir: root, identity: { attemptKey: "attempt", sessionId: "session", requestId: null }, timeoutMs: 1000, signal: controller.signal });
			assert.equal(result.outcome.kind, cancelled ? "cancelled" : "failed");
		} finally { rmSync(root, { recursive: true, force: true }); }
	}
});
