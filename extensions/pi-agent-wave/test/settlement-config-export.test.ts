import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildAgentFsInvocation } from "../lib/agentfs-sandbox.ts";

function driver(mode: string, root: string): string {
	const result = spawnSync("python3", [join(import.meta.dirname, "support/settlement-config-driver.py"), mode, root], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

for (const mode of ["tampered", "identity", "valid"]) {
	test(`${mode} private configuration is checked before actual AgentFS export`, () => {
		const root = mkdtempSync(join(realpathSync("/tmp"), "delegate-graph-herdr-config-proof-"));
		try {
			const resource: { agentfs_session: string; agentfs_home: string; attempt_dir: string } = JSON.parse(driver("prepare", root));
			const script = join(resource.attempt_dir, "candidate.sh");
			writeFileSync(script, "#!/bin/sh\nprintf 'candidate\\n' > owned.txt\n", { mode: 0o700 });
			chmodSync(script, 0o700);
			const invocation = buildAgentFsInvocation({ sessionId: resource.agentfs_session, baseDir: join(root, "base"), homeDir: resource.agentfs_home, privateDir: resource.attempt_dir, command: script, args: [] });
			const created = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8" });
			assert.equal(created.status, 0, created.stderr);
			const result: { exported: boolean; error: string | null; hostBytes: string } = JSON.parse(driver(mode, root));
			assert.equal(result.hostBytes, mode === "valid" ? "candidate\n" : "original\n");
			assert.equal(result.exported, mode === "valid");
			if (mode === "tampered") assert.match(result.error ?? "", /snapshot changed/);
			else if (mode === "identity") assert.match(result.error ?? "", /presentation identity/);
			else assert.equal(result.error, null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
