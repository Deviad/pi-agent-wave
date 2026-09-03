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
		for (const required of ["package.json", "README.md", "LICENSE", "index.ts", "questionnaire.ts", "cmux-session.ts", "model-failover.ts", "require-runtime.ts", "require-acpx.ts", "require-agentfs.ts", "lib/jsonc.mjs", "lib/model-routing.mjs", "lib/model-failover-native.mjs", "lib/model-failover-native.d.mts", "lib/acpx-types.ts", "lib/acpx-events.ts", "lib/acpx-select.ts", "lib/acpx-permissions.ts", "lib/acpx-settlement.ts", "lib/acpx-settlement-evidence.ts", "lib/agentfs-sandbox.ts", "lib/worker-transport.ts", "scripts/delegate_core.py", "scripts/headless_delegate.py", "scripts/headless_supervisor.py", "scripts/herdr_delegate.py", "scripts/acpx-worker.ts", "scripts/acpx-cancel.ts", "scripts/acpx-plan.ts", "scripts/agentfs-export.ts", "scripts/production-audit.ts", "scripts/production-review-bundle.ts", "scripts/production-secret-scan.ts", "scripts/production-cleanup-scan.ts", "scripts/production-token-cleanup.ts", "scripts/migrate.mjs", "scripts/policy-resolver.mjs", "scripts/resolve-model.mjs"]) {
			expect(packedFiles).toContain(required);
		}
		expect(packedFiles.includes("scripts/panel.ts")).toBe(false);
		expect(packedFiles.includes("require-herdr.ts")).toBe(false);
		expect(packedFiles.some((path) => path.includes("agentfs") && path.endsWith(".db"))).toBe(false);
		for (const path of packedFiles) {
			expect(path).not.toStartWith("test/");
			expect(path).not.toContain("herdr-agent-state");
			expect(path).not.toContain("node_modules/");
			expect(path).not.toContain("__pycache__");
			expect(path.endsWith(".pyc")).toBe(false);
		}
	});
});
