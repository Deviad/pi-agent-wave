import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { RuntimeIntegration } from "../lib/runtime-integration.ts";
import { stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";

/**
 * Integrating one slice while a sibling slice's worker is still running used to destroy that sibling: the
 * integration writes into the host workspace, and the running worker's settlement audit reads the same
 * tree, sees a file it does not own, and fails permanently. These prove the refusal, the recorded
 * override, and that a genuine unowned write is still caught.
 */

const MODEL = "openai-codex/gpt-5.6-sol";
const POLICY = {
	input: { kind: "model" as const, model: MODEL, reason: "test" },
	routes: [
		{ role: "thinker", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null },
		{ role: "implementer", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "coding", selectionSource: "model", promoted: false, promotionReason: null },
		{ role: "reviewer", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "review", selectionSource: "model", promoted: false, promotionReason: null },
		{ role: "tester", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "testing", selectionSource: "model", promoted: false, promotionReason: null },
		{ role: "auditor", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "review", selectionSource: "model", promoted: false, promotionReason: null },
	],
};

interface Fixture {
	root: string;
	base: string;
	home: string;
	env: NodeJS.ProcessEnv;
	store: GraphStore;
	runId: string;
	baseRevision: string;
	git: (...args: string[]) => string;
}

function fixture(prefix: string): Fixture {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const base = join(root, "base"); mkdirSync(base);
	const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
	const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
	const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
	git("init");
	writeFileSync(join(base, "product.md"), "product before");
	writeFileSync(join(base, "specification.md"), "specification before");
	git("add", "product.md", "specification.md");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base");
	const store = new GraphStore({ dbPath: join(home, "graph.db") });
	const run = store.initRun("slices", "build", "Write both documents", POLICY as never, undefined, "runtime-v1");
	return { root, base, home, env, store, runId: run.runId, baseRevision: git("rev-parse", "HEAD"), git };
}

/** Drives the build graph to two parallel `implement` operations, exactly as a two-slice run produces them. */
function twoSlices(fx: Fixture): { id: string; slice: string }[] {
	const planning = fx.store.next(fx.runId).operations[0]!;
	const identity = createHeadlessAcpxAttemptIdentity({ runId: fx.runId, operationId: planning.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "codex" });
	fx.store.beginRuntimeAttempt({ identity, sessionId: "plan-session", requestId: null, policyDigest: fx.store.policy(fx.runId).digest });
	fx.store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer: fx.store.retainRuntimeContent(Buffer.from("two slices")), sources: [] }, observation: { sessionId: "plan-session", requestId: null, sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	fx.store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "plan accepted", payload: { slices: [
		{ id: "product", name: "product", task: "Write product.md", ownedPaths: ["product.md"] },
		{ id: "specification", name: "specification", task: "Write specification.md", ownedPaths: ["specification.md"] },
	] } });
	const operations = fx.store.next(fx.runId).operations.filter((operation) => operation.node === "implement");
	assert.equal(operations.length, 2, "the fixture needs two parallel implement operations");
	return operations.map((operation) => ({ id: operation.id, slice: operation.slice_id ?? "" }));
}

type Identity = ReturnType<typeof createHeadlessAcpxAttemptIdentity>;

/** Registers a worker for a slice and leaves it running, with no settled outcome: a live sibling. */
function dispatchSlice(fx: Fixture, operationId: string): Identity {
	const identity = createHeadlessAcpxAttemptIdentity({ runId: fx.runId, operationId, role: "implementer", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "codex" });
	fx.store.beginRuntimeAttempt({ identity, sessionId: `dg-live-${operationId.slice(-6)}`, requestId: null, policyDigest: fx.store.policy(fx.runId).digest });
	return identity;
}

/**
 * Stages a real AgentFS overlay write of one owned file and settles it as a coding candidate. A worker
 * already dispatched by `dispatchSlice` settles under that same identity, the way a real collect does.
 */
function settleSlice(fx: Fixture, operationId: string, path: string, text: string, dispatched?: Identity, suffix = ""): { attemptKey: string; manifest: ReturnType<RuntimeContentStore["retain"]> } {
	const session = `dg-${path.replace(/\W/g, "")}${suffix}`;
	const identity = dispatched ?? createHeadlessAcpxAttemptIdentity({ runId: fx.runId, operationId, role: "implementer", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "codex" });
	if (!dispatched) fx.store.beginRuntimeAttempt({ identity, sessionId: session, requestId: null, policyDigest: fx.store.policy(fx.runId).digest });
	execFileSync("agentfs", ["init", "--base", fx.base, session], { cwd: fx.root, env: fx.env, stdio: "pipe" });
	const source = join(fx.root, ".agentfs", `${session}.db`);
	const snapshotPath = join(fx.root, `${session}-closed.db`);
	execFileSync("agentfs", ["fs", source, "write", `/${path}`, text], { cwd: fx.root, env: fx.env, stdio: "pipe" });
	execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", source, snapshotPath]);
	const content = new RuntimeContentStore(fx.store.dbPath);
	const staged = stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: fx.base, baseRevision: fx.baseRevision, attemptKey: identity.attemptKey, ownedPaths: [path], readOnly: false }, content);
	fx.store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "coding", answer: content.retain(Buffer.from(`wrote ${path}`)), artifacts: [staged.manifest, ...staged.files], baseRevision: fx.baseRevision }, observation: { sessionId: session, requestId: null, sessionOrigin: "created", captureStatus: "complete", manifest: staged.manifest } });
	rmSync(snapshotPath); rmSync(join(fx.root, ".agentfs"), { recursive: true, force: true });
	return { attemptKey: identity.attemptKey, manifest: staged.manifest };
}

test("integrating a slice while a sibling worker is still running is refused, and the sibling survives it", () => {
	const fx = fixture("sibling-race-");
	try {
		const [first, second] = twoSlices(fx);
		// The first slice finished and settled; the second worker is still running, exactly as in the incident.
		const firstSlice = first!.slice === "product" ? first! : second!;
		const runningSlice = firstSlice === first! ? second! : first!;
		const live = dispatchSlice(fx, runningSlice.id);
		const settled = settleSlice(fx, firstSlice.id, "product.md", "product after");
		assert.equal(fx.store.runtimeAttemptByOperation(runningSlice.id)?.outcome, null, "the sibling worker is genuinely still running");

		assert.throws(
			() => fx.store.applyRuntimeIntegration(settled.attemptKey, settled.manifest),
			(error: Error) => error.message.includes("live worker") && error.message.includes(runningSlice.id),
			"the refusal names the running sibling operations",
		);
		assert.equal(readFileSync(join(fx.base, "product.md"), "utf8"), "product before", "nothing was written into the workspace");

		// The sibling is unaffected: it settles its own candidate from the untouched tree and its audit passes.
		const sibling = settleSlice(fx, runningSlice.id, "specification.md", "specification after", live);
		const siblingAttempt = fx.store.runtimeAttempt(sibling.attemptKey);
		assert.equal(siblingAttempt.processState, "exited");
		assert.equal(siblingAttempt.candidate?.kind, "coding", "the sibling's candidate is intact");

		// With both settled, the integration that was refused now goes through.
		const journal = new RuntimeIntegration(fx.store.dbPath);
		try {
			const prepared = fx.store.prepareRuntimeIntegration(settled.attemptKey, settled.manifest);
			assert.equal(prepared.state, "prepared");
			assert.equal(prepared.overrideReason, null, "no override was needed");
			let status = journal.advance(prepared.id, "apply");
			while (status.state === "applying") status = journal.advance(prepared.id, "apply");
			assert.equal(status.state, "applied");
			assert.equal(readFileSync(join(fx.base, "product.md"), "utf8"), "product after");
		} finally { journal.close(); }
	} finally { fx.store.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("the override is explicit, requires a reason, and is recorded on the integration row", () => {
	const fx = fixture("sibling-override-");
	try {
		const [first, second] = twoSlices(fx);
		const firstSlice = first!.slice === "product" ? first! : second!;
		const runningSlice = firstSlice === first! ? second! : first!;
		dispatchSlice(fx, runningSlice.id);
		const settled = settleSlice(fx, firstSlice.id, "product.md", "product after");

		// An empty reason is not a reason: the override must be stated, never implied.
		assert.throws(() => fx.store.prepareRuntimeIntegration(settled.attemptKey, settled.manifest, "   "), /override requires a reason/);
		assert.throws(() => fx.store.prepareRuntimeIntegration(settled.attemptKey, settled.manifest), /live worker/);

		const reason = "the specification worker's process is confirmed dead";
		const prepared = fx.store.prepareRuntimeIntegration(settled.attemptKey, settled.manifest, reason);
		assert.equal(prepared.state, "prepared");
		assert.equal(prepared.overrideReason, reason, "the stated reason is recorded on the row");
		const reopened = new GraphStore({ dbPath: fx.store.dbPath });
		try { assert.equal(reopened.prepareRuntimeIntegration(settled.attemptKey, settled.manifest).overrideReason, reason, "and survives reopening the store"); }
		finally { reopened.close(); }
	} finally { fx.store.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("a rollback is never refused by a running sibling, because it is the way out of this state", () => {
	const fx = fixture("sibling-rollback-");
	try {
		const [first, second] = twoSlices(fx);
		const firstSlice = first!.slice === "product" ? first! : second!;
		const runningSlice = firstSlice === first! ? second! : first!;
		dispatchSlice(fx, runningSlice.id);
		const settled = settleSlice(fx, firstSlice.id, "product.md", "product after");
		const rolled = fx.store.applyRuntimeIntegration(settled.attemptKey, settled.manifest, "rollback");
		assert.equal(rolled.state, "rolled_back");
		assert.equal(readFileSync(join(fx.base, "product.md"), "utf8"), "product before");
	} finally { fx.store.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test("a candidate whose preimage is a previous round's uncommitted integration says to commit it", () => {
	const fx = fixture("round-commit-");
	try {
		const [first, second] = twoSlices(fx);
		const firstSlice = first!.slice === "product" ? first! : second!;
		const runningSlice = firstSlice === first! ? second! : first!;
		const round1 = settleSlice(fx, firstSlice.id, "product.md", "product after");
		const journal = new RuntimeIntegration(fx.store.dbPath);
		try {
			const prepared = fx.store.prepareRuntimeIntegration(round1.attemptKey, round1.manifest);
			let status = journal.advance(prepared.id, "apply");
			while (status.state === "applying") status = journal.advance(prepared.id, "apply");
			assert.equal(status.state, "applied");
		} finally { journal.close(); }
		assert.equal(readFileSync(join(fx.base, "product.md"), "utf8"), "product after");
		// Nobody committed it, so the tree is dirty at exactly the path a later round would modify.
		assert.ok(fx.git("status", "--porcelain", "--", "product.md").trim(), "the fixture leaves round 1's output uncommitted");

		// The next candidate to touch that same path must say why, not merely "dirty or untracked". It comes
		// from its own operation and its own worker, the way a later round's candidate does.
		const round2 = settleSlice(fx, runningSlice.id, "product.md", "product revised", undefined, "-r2");
		assert.throws(
			() => fx.store.prepareRuntimeIntegration(round2.attemptKey, round2.manifest),
			(error: Error) => /uncommitted output of an earlier applied integration/.test(error.message) && /commit the previous round/.test(error.message),
			"the refusal tells the operator to commit the previous round's integrated files",
		);
	} finally { fx.store.close(); rmSync(fx.root, { recursive: true, force: true }); }
});
