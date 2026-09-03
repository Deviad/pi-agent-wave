import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProductionReviewBundle, REVIEW_PATHS } from "../scripts/production-review-bundle.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("production final review bundle", () => {
	test("builds a private self-contained path-and-hash indexed bundle", () => {
		const directory = mkdtempSync(join(tmpdir(), "production-review-bundle-"));
		directories.push(directory);
		const output = join(directory, "bundle.md");
		const result = buildProductionReviewBundle(process.cwd(), output);
		const bundle = readFileSync(output, "utf8");
		assert.equal(result.sections, REVIEW_PATHS.length);
		for (const requiredPath of ["extensions/pi-agent-wave/scripts/production-review-bundle.ts", "extensions/pi-agent-wave/test/production-review-bundle.test.ts", "extensions/pi-agent-wave/test/commands.test.ts"]) {
			assert.ok(REVIEW_PATHS.includes(requiredPath));
			assert.match(bundle, new RegExp(`${requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| \\d+ bytes \\| sha256 [a-f0-9]{64}`));
		}
		assert.equal(statSync(output).mode & 0o777, 0o600);
		for (const path of REVIEW_PATHS) {
			assert.match(bundle, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(bundle, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| \\d+ bytes \\| sha256 [a-f0-9]{64}`));
		}
		assert.doesNotMatch(bundle, /\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
	});
});
