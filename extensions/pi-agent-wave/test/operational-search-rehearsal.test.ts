import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegateInvocation } from "../scripts/delegate.ts";

const helper = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));

describe("operational search rehearsal", () => {
	test("executes a persisted harmless target with exact argv and exit propagation", () => {
		const dir = mkdtempSync(join(tmpdir(), "operational-rehearsal-"));
		try {
			const target = join(dir, "target.mjs");
			const evidence = join(dir, "evidence.json");
			writeFileSync(target, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), stdoutOpen: process.stdout.writable, stderrOpen: process.stderr.writable }));\nprocess.exit(7);\n`);
			chmodSync(target, 0o700);
			const argv = [evidence, "two words", "$literal", "quote'boundary"];
			const result = spawnSync(target, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			assert.equal(result.status, 7);
			assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), { argv: argv.slice(1), stdoutOpen: true, stderrOpen: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves one direct argv boundary and renders the exact command contract", () => {
		const command = { executable: "node", args: ["/tmp/search script.mjs", "--role", "AI Architect"], cwd: "/tmp/work dir" };
		const invocation = delegateInvocation("herdr", ["start", "/tmp/run", "searcher", "--node", "source_search", "--command-json", JSON.stringify(command)]);
		assert.equal(invocation.file, "python3");
		assert.deepEqual(invocation.args.slice(-4), ["--node", "source_search", "--command-json", JSON.stringify(command)]);
		assert.equal(JSON.stringify(invocation).includes("bash -lc"), false);
		const probe = "import runpy,sys; print(runpy.run_path(sys.argv[1])['operational_instruction'](sys.argv[2]))";
		const result = spawnSync("python3", ["-c", probe, helper, JSON.stringify(command)], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /first execution command/);
		assert.match(result.stdout, /\["node", "\/tmp\/search script\.mjs", "--role", "AI Architect"\]/);
		assert.doesNotMatch(result.stdout, /jh-doctor|cdp-preflight/);
	});
});
