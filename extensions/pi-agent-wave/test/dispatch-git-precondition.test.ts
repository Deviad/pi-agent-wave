import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { RuntimeIntegration } from "../lib/runtime-integration.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { renderStatus } from "../commands.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

// The route's provider has no credential anywhere, so a dispatch that passes the Git check stops at the
// worker preflight and never launches a model.
const DEAD_ROUTE = "nosuchproviderxyz/dead-route";
const ROLES = ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"];

async function toolIn(dir: string, invocations: { command: string; args: string[] }[]): Promise<Record<string, any>> {
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	process.env.DELEGATE_GRAPH_DB = join(dir, "graph.db");
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
		default_tier: "tools",
		tiers: { tools: { models: [DEAD_ROUTE], thinking: "off", session: true } },
		roles: Object.fromEntries(ROLES.map((role) => [role, { tier: "tools" }])),
	}));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
	const { default: extension } = await import(`../index.ts?git-precondition=${Date.now()}`);
	let tool: Record<string, any> = {};
	extension({
		registerCommand() {},
		registerTool(definition: Record<string, any>) { tool = definition; },
		on() {},
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			invocations.push({ command, args: [...args] });
			const result = spawnSync(command, args, { encoding: "utf8", cwd: options?.cwd });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);
	return tool;
}

/** Initializes a build run and accepts a one-slice plan, leaving one pending `implement` operation. */
async function implementOperation(tool: Record<string, any>, root: string, ownedPaths = [join(root, "src", "a.ts")]): Promise<{ runId: string; operationId: string }> {
	const init = parsed(await tool.execute("init", { op: "init", story: "git-precondition", graph: "build", task: "Plan the change" }, undefined, () => {}, { cwd: root } as ExtensionContext));
	assert.equal(init.error, undefined, JSON.stringify(init));
	const runId: string = init.state.runId;
	const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
	try {
		const plan = store.next(runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: plan.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: DEAD_ROUTE, agent: selectAcpAgent(DEAD_ROUTE) });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-plan", requestId: null, policyDigest: store.policy(runId).digest });
		const answer = new RuntimeContentStore(store.dbPath).retain(Buffer.from("# Plan\n\nOne slice.\n"));
		store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "acp-1", requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
		store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "plan accepted", verdict: "READY", payload: { slices: [{ id: "edit", name: "edit", task: "Edit src/a.ts", ownedPaths }] } });
		const implement = store.next(runId).operations.find((operation) => operation.node === "implement");
		assert.ok(implement, "the accepted plan must leave an implement operation");
		return { runId, operationId: implement.id };
	} finally { store.close(); }
}

/** Run directories under the run root beside this test's graph database (scripts/delegate_core.py:run_root). */
function privateRunDirs(): string[] {
	const runRoot = join(dirname(process.env.DELEGATE_GRAPH_DB!), "runs");
	return existsSync(runRoot) ? readdirSync(runRoot).filter((name) => name.startsWith("delegate-graph-herdr-")) : [];
}

describe("coding dispatch requires a Git working directory", () => {
	test("a non-Git working directory is refused before any worker, attempt or run directory exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "git-precondition-"));
		dirs.push(dir);
		const workspace = join(dir, "not-a-repo");
		mkdirSync(workspace);
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const tool = await toolIn(dir, invocations);
			const { runId, operationId } = await implementOperation(tool, workspace);
			const before = new Set(privateRunDirs());
			invocations.length = 0;
			const refused = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless" }, undefined, () => {}, { cwd: workspace } as ExtensionContext));
			assert.equal(refused.error, undefined, `dispatch must converge on a named refusal, got ${JSON.stringify(refused)}`);
			assert.equal(refused.dispatched, false);
			assert.equal(refused.blocked, "precondition");
			assert.equal(refused.baseDir, realpathSync(workspace));
			assert.match(String(refused.reason), /\[dispatch_precondition\] coding operation requires a Git working directory with a HEAD revision/);
			assert.ok(String(refused.reason).includes(realpathSync(workspace)), "the refusal names the resolved base directory");
			assert.match(String(refused.reason), /start the Pi session in the Git repository being edited/);
			assert.equal(refused.operation.status, "failed");
			assert.equal(refused.operation.classifier_reason, "dispatch-precondition");
			assert.equal(refused.state.status, "awaiting_user");
			assert.equal(invocations.some((call) => call.args.includes("init") || call.args.includes("start")), false, "no launcher may run");
			assert.deepEqual(privateRunDirs().filter((name) => !before.has(name)), [], "no attempt directory may be created");
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			try {
				assert.equal(store.agents(runId).length, 0, "no agents row");
				assert.equal(store.runtimeAttemptByOperation(operationId), undefined, "no runtime_attempts row");
				const status = renderStatus(store, runId);
				assert.match(status, /status=awaiting_user/);
				assert.match(status, new RegExp(`${operationId} \\| implement \\| failed .*blocker=\\[dispatch_precondition\\]`));
			} finally { store.close(); }
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});

	test("a Git working directory passes the check and reaches the launcher as before", async () => {
		const dir = mkdtempSync(join(tmpdir(), "git-precondition-repo-"));
		dirs.push(dir);
		const workspace = join(dir, "repo");
		mkdirSync(workspace);
		for (const args of [["init", "-q"], ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]]) {
			assert.equal(spawnSync("git", args, { cwd: workspace }).status, 0);
		}
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const tool = await toolIn(dir, invocations);
			const { runId, operationId } = await implementOperation(tool, workspace);
			const result = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless" }, undefined, () => {}, { cwd: workspace } as ExtensionContext));
			assert.equal(result.blocked, "preflight", `expected the credential preflight, not the Git check, got ${JSON.stringify(result)}`);
			assert.ok(invocations.some((call) => call.args.includes("start")), "the launcher must be invoked");
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});
});

for (const scenario of ["directory", "deletion", "committed", "committed-then-operator-dirt", "disjoint", "operator-dirt"] as const) {
	test(`dispatch integration sequencing: ${scenario}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "dispatch-journal-"));
		dirs.push(dir);
		const workspace = join(dir, "repo");
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "a.ts"), "before\n");
		const git = (...args: string[]) => {
			const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		git("init", "-q"); git("add", ".");
		git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "base");
		const saved = { ...process.env };
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const tool = await toolIn(dir, invocations);
			const ownership = scenario === "directory" ? [join(workspace, "src")]
				: scenario === "disjoint" ? [join(workspace, "src", "b.ts")] : [join(workspace, "src", "a.ts")];
			const { runId, operationId } = await implementOperation(tool, workspace, ownership);
			if (scenario === "operator-dirt") writeFileSync(join(workspace, "src", "a.ts"), "operator edit\n");
			else {
				const journal = new RuntimeIntegration(process.env.DELEGATE_GRAPH_DB!);
				try {
					const content = new RuntimeContentStore(process.env.DELEGATE_GRAPH_DB!).retain(Buffer.from("integrated\n"));
					const prepared = journal.prepare({ workspace, baseRevision: git("rev-parse", "HEAD"), candidateId: "earlier-candidate", ownedPaths: ["src"], changes: [{ path: "src/a.ts", after: scenario === "deletion" ? null : content, mode: 0o644 }] });
					let applied = journal.advance(prepared.id, "apply");
					while (applied.state === "applying") applied = journal.advance(prepared.id, "apply");
					assert.equal(applied.state, "applied");
				} finally { journal.close(); }
				if (scenario === "committed" || scenario === "committed-then-operator-dirt") { git("add", "."); git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "integrated"); }
				if (scenario === "committed-then-operator-dirt") writeFileSync(join(workspace, "src", "a.ts"), "operator edit after commit\n");
			}
			invocations.length = 0;
			const result = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless" }, undefined, () => {}, { cwd: workspace } as ExtensionContext));
			if (scenario === "directory" || scenario === "deletion") {
				assert.equal(result.blocked, "integration", JSON.stringify(result));
				assert.equal(result.dispatched, false);
				assert.match(result.reason, /authorized commit.*replacement worker/);
				assert.ok(result.reason.includes(realpathSync(workspace)));
				assert.deepEqual(result.paths, ["src/a.ts"]);
				assert.equal(invocations.length, 1, "only the Git HEAD check executes; no preparation or launcher");
				assert.deepEqual(privateRunDirs(), []);
				const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
				try {
					assert.equal(store.runtimeAttemptByOperation(operationId), undefined);
					assert.equal(store.agents(runId).length, 0);
					assert.equal(store.getOperation(operationId).status, "pending");
					assert.equal(store.getOperation(operationId).transient_attempts, 0);
				} finally { store.close(); }
			} else assert.equal(result.blocked, "preflight", JSON.stringify(result));
			assert.equal(git("status", "--porcelain").length > 0, scenario !== "committed");
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
}
