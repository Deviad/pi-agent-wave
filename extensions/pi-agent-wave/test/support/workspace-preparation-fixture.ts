import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { approveWorkspaceRecipe, prepareWorkspace, type PreparationCommand, type WorkspaceRecipe } from "../../lib/workspace-preparation.ts";

export function preparationFixture(parent = tmpdir()) {
	const root = realpathSync(mkdtempSync(join(parent, "workspace-preparation-")));
	const workspace = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(workspace); mkdirSync(agentDir);
	const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
	const npm = execFileSync("/bin/sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
	const node = (code: string): PreparationCommand => ({ executable: process.execPath, args: ["-e", code] });
	mkdirSync(join(workspace, "local-package"));
	writeFileSync(join(workspace, "local-package", "package.json"), JSON.stringify({ name: "preparation-local", version: "1.0.0", main: "index.cjs" }));
	writeFileSync(join(workspace, "local-package", "index.cjs"), "module.exports = 'loaded-real-package';\n");
	writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "preparation-local": "file:./local-package" } }));
	writeFileSync(join(workspace, ".gitignore"), "node_modules/\n.preparation-scratch/\n");
	writeFileSync(join(workspace, "source.ts"), "operator source\n");
	mkdirSync(join(workspace, ".preparation-scratch"));
	const npmArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--cache", ".preparation-scratch/cache"];
	execFileSync(npm, [...npmArgs, "--package-lock-only"], { cwd: workspace, stdio: "pipe", timeout: 30_000 });
	git("init", "-q"); git("add", "."); git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "base");
	let recipe: WorkspaceRecipe = {
		workspace, install: [{ executable: npm, args: ["ci", ...npmArgs.slice(1)] }, node("require('fs').appendFileSync('.preparation-scratch/events', 'install\\n')")],
		baseline: [node("require('assert').equal(require('preparation-local'), 'loaded-real-package'); require('fs').appendFileSync('.preparation-scratch/events', 'baseline\\n')")],
		readiness: node("require('assert').equal(require('preparation-local'), 'loaded-real-package')"),
		dependencyInputs: ["package.json", "package-lock.json", "local-package/package.json", "local-package/index.cjs"],
		scriptInputs: [], writePaths: ["node_modules", ".preparation-scratch"], timeoutMs: 30_000,
	};
	const registry = join(agentDir, "workspace-preparation.jsonc");
	const save = (replacement = recipe) => { recipe = replacement; writeFileSync(registry, JSON.stringify({ workspaces: [recipe] }), { mode: 0o600 }); chmodSync(registry, 0o600); };
	save();
	const prepare = (overrides: Partial<Parameters<typeof prepareWorkspace>[0]> = {}) => prepareWorkspace({ workspace, agentDir, dbPath: join(root, "graph.db"), runId: "run-one", operationId: "op-one", ...overrides });
	const approve = () => approveWorkspaceRecipe(agentDir, workspace, true);
	const events = () => { try { return readFileSync(join(workspace, ".preparation-scratch/events"), "utf8").trim().split("\n"); } catch { return []; } };
	return { root, workspace, agentDir, git, npm, node, get recipe() { return recipe; }, save, prepare, approve, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function prepared(fx: ReturnType<typeof preparationFixture>, overrides: Partial<Parameters<typeof prepareWorkspace>[0]> = {}) {
	const guard = await fx.prepare(overrides);
	try { assert.equal(guard.result.status, "ready"); return guard.result; } finally { guard.release(); }
}
