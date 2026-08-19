import { describe, expect, test } from "./test-api.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function npmJson(args: string[]): any {
	const result = spawnSync("npm", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } });
	if (result.status !== 0) throw new Error(`${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(result.stdout);
}

function artifactFiles(result: any): string[] {
	const item = Array.isArray(result) ? result[0] : result;
	return (item.files ?? []).map((entry: any) => String(entry.path)).sort();
}

describe("npm package artifact", () => {
	test("pack and publish dry-runs expose only package-owned runtime files", () => {
		const packed = npmJson(["pack", "--dry-run", "--json", "--ignore-scripts"]);
		const published = npmJson(["publish", "--dry-run", "--json", "--ignore-scripts"]);
		const packedFiles = artifactFiles(packed);
		const publishedFiles = artifactFiles(published);
		expect(packedFiles).toEqual(publishedFiles);
		for (const required of ["package.json", "README.md", "LICENSE", "index.ts", "questionnaire.ts", "cmux-session.ts", "model-failover.ts", "lib/jsonc.mjs", "lib/model-routing.mjs", "lib/model-failover-native.mjs", "lib/model-failover-native.d.mts", "scripts/migrate.mjs", "scripts/policy-resolver.mjs", "scripts/resolve-model.mjs"]) {
			expect(packedFiles).toContain(required);
		}
		for (const path of packedFiles) {
			expect(path).not.toStartWith("test/");
			expect(path).not.toContain("herdr-agent-state");
			expect(path).not.toContain("node_modules/");
		}
	});
});
