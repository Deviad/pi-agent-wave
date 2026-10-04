import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { renderStatus } from "../commands.ts";
import { classifyFailure } from "../retry.ts";
import { agentFsAuditErrorMessage, auditAgentFsChanges, buildAgentFsInvocation, expectedAgentFsDb, ownedRelativePaths } from "../lib/agentfs-sandbox.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function parsed(result: unknown): Record<string, any> { return JSON.parse((result as { content: { text: string }[] }).content[0].text); }

// A route with no credential anywhere: an operation that passes every precondition stops at the
// worker preflight, which is how a *successful* precondition is observed without spending a model.
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
	const { default: extension } = await import(`../index.ts?owned-path-precondition=${Date.now()}-${Math.random()}`);
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

function gitWorkspace(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	const workspace = join(dir, "repo");
	mkdirSync(join(workspace, "src"), { recursive: true });
	for (const args of [["init", "-q"], ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]]) {
		assert.equal(spawnSync("git", args, { cwd: workspace }).status, 0);
	}
	return workspace;
}

/** Accepts a one-slice plan whose declared ownership is exactly `ownedPaths`, leaving one pending `implement`. */
async function implementOperation(tool: Record<string, any>, ownedPaths: string[]): Promise<{ runId: string; operationId: string }> {
	const init = parsed(await tool.execute("init", { op: "init", story: "owned-path-precondition", graph: "build", task: "Plan the change" }, undefined, () => {}, {} as ExtensionContext));
	assert.equal(init.error, undefined, JSON.stringify(init));
	const runId: string = init.state.runId;
	const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
	try {
		const plan = store.next(runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: plan.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: DEAD_ROUTE, agent: selectAcpAgent(DEAD_ROUTE) });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-plan", requestId: null, policyDigest: store.policy(runId).digest });
		const answer = new RuntimeContentStore(store.dbPath).retain(Buffer.from("# Plan\n\nOne slice.\n"));
		store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "acp-1", requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
		store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "plan accepted", verdict: "READY", payload: { slices: [{ id: "edit", name: "edit", task: "Edit the slice", ownedPaths }] } });
		const implement = store.next(runId).operations.find((operation) => operation.node === "implement");
		assert.ok(implement, "the accepted plan must leave an implement operation");
		return { runId, operationId: implement.id };
	} finally { store.close(); }
}

/**
 * Run directories for one run only, under the run root beside this test's graph database
 * (scripts/delegate_core.py:run_root). The run's own identity keeps the question about *this* dispatch
 * even if other runs share the root.
 */
function privateRunDirsFor(runId: string): string[] {
	const token = runId.replace(/^run_/, "");
	const runRoot = join(dirname(process.env.DELEGATE_GRAPH_DB!), "runs");
	return existsSync(runRoot) ? readdirSync(runRoot).filter((name) => name.startsWith("delegate-graph-herdr-") && name.includes(token)) : [];
}

async function dispatchWith(ownedPaths: string[], workspace: string, invocations: { command: string; args: string[] }[], dir: string): Promise<{ result: Record<string, any>; runId: string; operationId: string }> {
	const tool = await toolIn(dir, invocations);
	const { runId, operationId } = await implementOperation(tool, ownedPaths);
	invocations.length = 0;
	const result = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless" }, undefined, () => {}, { cwd: workspace } as ExtensionContext));
	return { result, runId, operationId };
}

describe("dispatch requires owned paths inside the working directory", () => {
	test("an escaping owned path is refused before any worker, attempt or run directory exists", async () => {
		const workspace = gitWorkspace("owned-escape-");
		const outside = join(workspace, "..", "outside", "frozen.txt");
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		const dir = mkdtempSync(join(tmpdir(), "owned-escape-home-"));
		dirs.push(dir);
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const { result, runId, operationId } = await dispatchWith([outside], workspace, invocations, dir);
			const base = realpathSync(workspace);
			assert.equal(result.error, undefined, `dispatch must converge on a named refusal, got ${JSON.stringify(result)}`);
			assert.equal(result.dispatched, false);
			assert.equal(result.blocked, "precondition");
			assert.equal(result.baseDir, base);

			// AC3: everything the next agent needs to proceed is in the reason itself.
			const reason = String(result.reason);
			assert.match(reason, /^\[dispatch_precondition\] /);
			assert.match(reason, /AgentFS copy-on-write overlay/);
			assert.ok(reason.includes(base), "the refusal names the resolved base directory");
			assert.ok(reason.includes(resolve(base, outside)), `the refusal names the offending owned path, got ${reason}`);
			assert.match(reason, /declare owned paths under /);
			assert.match(reason, /dispatch this operation from the directory that contains/);
			assert.match(reason, /resolve this operation with retry, or abort the run/);

			// AC2: permanent, so the three-attempt transient budget is never spent on it.
			assert.deepEqual(classifyFailure(reason), { kind: "permanent", reason: "dispatch-precondition" });
			assert.equal(result.operation.status, "failed");
			assert.equal(result.operation.classifier_reason, "dispatch-precondition");
			assert.equal(result.state.status, "awaiting_user");

			// AC1: nothing was created.
			assert.equal(invocations.some((call) => call.args.includes("init") || call.args.includes("start")), false, "no launcher may run");
			assert.deepEqual(privateRunDirsFor(runId), [], "no attempt directory may be created for this run");
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			try {
				assert.equal(store.agents(runId).length, 0, "no agents row");
				assert.equal(store.runtimeAttemptByOperation(operationId), undefined, "no runtime_attempts row");
				assert.match(renderStatus(store, runId), new RegExp(`${operationId} \\| implement \\| failed .*blocker=\\[dispatch_precondition\\]`));
			} finally { store.close(); }
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});

	test("ownership of the whole working directory is refused with its own remedy", async () => {
		const workspace = gitWorkspace("owned-whole-base-");
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		const dir = mkdtempSync(join(tmpdir(), "owned-whole-base-home-"));
		dirs.push(dir);
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const { result } = await dispatchWith([workspace], workspace, invocations, dir);
			assert.equal(result.blocked, "precondition", JSON.stringify(result));
			const reason = String(result.reason);
			assert.match(reason, /cover the whole working directory/);
			assert.match(reason, /declare the specific files or subdirectories the slice writes/);
			assert.deepEqual(classifyFailure(reason), { kind: "permanent", reason: "dispatch-precondition" });
			assert.equal(invocations.some((call) => call.args.includes("start")), false, "no launcher may run");
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});

	test("contained owned paths, relative or absolute, still reach the launcher", async () => {
		const workspace = gitWorkspace("owned-contained-");
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		for (const owned of [["src/a.ts"], [join(workspace, "src", "a.ts")], ["src/a.ts", join(workspace, "src", "b.ts")]]) {
			const dir = mkdtempSync(join(tmpdir(), "owned-contained-home-"));
			dirs.push(dir);
			try {
				const invocations: { command: string; args: string[] }[] = [];
				const { result } = await dispatchWith(owned, workspace, invocations, dir);
				assert.equal(result.blocked, "preflight", `expected the credential preflight, not the precondition, for ${JSON.stringify(owned)}: ${JSON.stringify(result)}`);
				assert.ok(invocations.some((call) => call.args.includes("start")), "the launcher must be invoked");
			} finally {
				Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
			}
		}
	});

	// The build graph refuses an implement slice without ownership (store.ts:assertDisjointOwnership), so the
	// empty-ownership path is reached by a research operation, which dispatches read-only with no owned paths.
	test("an operation with no declared ownership is never blocked by the check", async () => {
		const workspace = gitWorkspace("owned-empty-");
		const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB };
		const dir = mkdtempSync(join(tmpdir(), "owned-empty-home-"));
		dirs.push(dir);
		try {
			const invocations: { command: string; args: string[] }[] = [];
			const tool = await toolIn(dir, invocations);
			const init = parsed(await tool.execute("init", { op: "init", story: "owned-path-empty", graph: "research", task: "Survey the field" }, undefined, () => {}, {} as ExtensionContext));
			assert.equal(init.error, undefined, JSON.stringify(init));
			const runId: string = init.state.runId;
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			let operationId: string;
			try {
				const pending = store.next(runId).operations[0];
				assert.equal(pending.owned_paths_json, "[]", "a research operation declares no ownership");
				operationId = pending.id;
			} finally { store.close(); }
			const result = parsed(await tool.execute("dispatch", { op: "dispatch", runId, operationId, transport: "headless" }, undefined, () => {}, { cwd: workspace } as ExtensionContext));
			assert.notEqual(result.blocked, "precondition", JSON.stringify(result));
		} finally {
			Object.assign(process.env, { PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db });
		}
	});
});

// What the precondition is and is not worth, pinned so neither half drifts. An escaping owned path
// reaching settlement was already permanent: `agentFsAuditErrorMessage` embeds the `[owned_path_escape]`
// token that `classifyFailure` matches ahead of the transient scan. So the refusal saves one worker turn
// and replaces a diagnosis-free `unclassified` with a named reason and a remedy; it does not save a retry
// budget. An unreadable overlay path must stay transient, because a re-read can genuinely succeed.
describe("settlement-side classification of the same defect", () => {
	test("an escaped owned path is permanent at settlement too, while an unreadable overlay path stays transient", () => {
		const escape = agentFsAuditErrorMessage([{ path: "/elsewhere/frozen.txt", kind: "owned_path_escape", detail: "owned path escapes base directory /work" }]);
		assert.match(escape, /\[owned_path_escape\]/, "the token classifyFailure matches must survive message formatting");
		assert.deepEqual(classifyFailure(escape), { kind: "permanent", reason: "unclassified" });
		const unreadable = agentFsAuditErrorMessage([{ path: "src/a.ts", kind: "audit_error", detail: "agentfs fs cat failed" }]);
		assert.deepEqual(classifyFailure(unreadable), { kind: "transient", reason: "agentfs-audit-error" });
	});
});

// AC6. The refusal is only worth anything if it agrees with the audit that would have run at
// settlement; a disagreement in either direction is a false block or a missed one. Both verdicts
// are read from a real AgentFS delta here rather than from a hand-built fixture.
describe("the dispatch precondition and the settlement audit classify containment identically", () => {
	test("the same path set produces the same escaping subset at dispatch and at audit", () => {
		const root = mkdtempSync(join(tmpdir(), "owned-agreement-"));
		dirs.push(root);
		const base = join(root, "base");
		const home = join(root, "home");
		const privateDir = join(root, "private");
		for (const path of [base, home, privateDir]) mkdirSync(path, { mode: 0o700 });
		writeFileSync(join(base, "owned.txt"), "original\n");
		const script = join(privateDir, "noop.sh");
		writeFileSync(script, "#!/bin/sh\n:\n", { mode: 0o700 });
		chmodSync(script, 0o700);
		const sessionId = "dg-owned-agreement";
		const invocation = buildAgentFsInvocation({ sessionId, baseDir: base, homeDir: home, privateDir, command: script, args: [] });
		const run = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
		assert.equal(run.status, 0, run.stderr);
		const db = expectedAgentFsDb(home, sessionId);
		const realBase = realpathSync(base);
		const candidates = [join(realBase, "owned.txt"), join(realBase, "nested", "deep.txt"), join(root, "outside.txt"), join(realBase, "..", "sibling.txt"), realBase];
		const dispatchErrors = ownedRelativePaths(realBase, candidates, "owned", false).errors.map((error) => error.path).sort();
		const auditErrors = auditAgentFsChanges(db, realBase, candidates).errors.filter((error) => error.kind === "owned_path_escape").map((error) => error.path).sort();
		assert.deepEqual(dispatchErrors, auditErrors, "dispatch must refuse exactly what settlement would refuse");
		assert.ok(dispatchErrors.length >= 3, "the fixture must exercise both the escape and the whole-base rule");
	});
});
