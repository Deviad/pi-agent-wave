import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { RuntimeIntegration } from "../lib/runtime-integration.ts";
import { parseRuntimeStagingManifest, stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";

for (const scenario of ["recovery", "retry-fence", "wrong-attempt", "wrong-base", "read-only", "missing-file", "unowned", "escape", "research"]) test(`stored AgentFS candidate integration: ${scenario}`, () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-candidate-"));
	const stores: GraphStore[] = [];
	let journal: RuntimeIntegration | undefined;
	try {
		const base = join(root, "base"); mkdirSync(base);
		const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
		git("init"); writeFileSync(join(base, "note.txt"), "before"); git("add", "note.txt");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base");
		const baseRevision = git("rev-parse", "HEAD");
		const store = new GraphStore({ dbPath: join(home, "graph.db") }); stores.push(store);
		const run = store.initRun("candidate", "build", "Implement", {
			input: { kind: "model", model: "openai-codex/gpt-5.6-sol", reason: "test" },
			routes: [{ role: "thinker", tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }],
		}, undefined, "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "session", requestId: "request", policyDigest: store.policy(run.runId).digest });
		execFileSync("agentfs", ["init", "--base", base, "candidate"], { cwd: root, env, stdio: "pipe" });
		const source = join(root, ".agentfs", "candidate.db"); const snapshotPath = join(root, "closed.db");
		execFileSync("agentfs", ["fs", source, "write", "/note.txt", "after"], { cwd: root, env, stdio: "pipe" });
		execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", source, snapshotPath]);
		const content = new RuntimeContentStore(store.dbPath);
		let staged = stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: base, baseRevision, attemptKey: identity.attemptKey, ownedPaths: ["note.txt"], readOnly: false }, content);
		assert.throws(() => store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), /settled coding or operational candidate/);
		if (scenario !== "recovery" && scenario !== "retry-fence" && scenario !== "research") {
			let changed = parseRuntimeStagingManifest(JSON.parse(content.read(staged.manifest, 16 * 1024 * 1024).toString("utf8")));
			if (scenario === "wrong-attempt") changed = { ...changed, attemptKey: "another-attempt" };
			if (scenario === "wrong-base") changed = { ...changed, baseRevision: "another-base" };
			if (scenario === "read-only") changed = { ...changed, readOnly: true, changes: [] };
			if (scenario === "unowned") changed = { ...changed, ownedPaths: ["other.txt"] };
			if (scenario === "escape") changed = { ...changed, changes: [{ ...changed.changes[0], path: "../escape.txt" }] };
			staged = { ...staged, manifest: content.retain(Buffer.from(JSON.stringify(changed))) };
		}
		const settled = store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: scenario === "retry-fence" ? { kind: "failed", exitCode: 1, error: "ACPX worker failed after staging" } : { kind: "exited", exitCode: 0 }, candidate: scenario === "research"
			? { kind: "research", answer: content.retain(Buffer.from("Research findings")), sources: [] }
			: { kind: "coding", answer: null, artifacts: [staged.manifest, ...(scenario === "missing-file" ? [] : staged.files)], baseRevision } });
		rmSync(snapshotPath); rmSync(join(root, ".agentfs"), { recursive: true });
		if (scenario === "retry-fence") {
			// A failed attempt whose partial candidate was prepared cannot be replaced until that integration is rolled back.
			const prepared = store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest);
			assert.equal(prepared.state, "prepared");
			assert.throws(() => store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id }), /integration is prepared; roll it back first/);
			assert.equal(store.applyRuntimeIntegration(identity.attemptKey, staged.manifest, "rollback").state, "rolled_back");
			assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
			const retried = store.retryRuntimeAttempt({ runId: run.runId, operationId: operation.id });
			assert.ok(retried.previousAttempt?.supersededAt);
			// The superseded candidate can never be applied; the historical rollback route stays open and is idempotent.
			assert.throws(() => store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), /superseded/);
			assert.throws(() => store.applyRuntimeIntegration(identity.attemptKey, staged.manifest, "apply"), /superseded/);
			assert.equal(store.applyRuntimeIntegration(identity.attemptKey, staged.manifest, "rollback").state, "rolled_back");
			assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
			return;
		}
		if (scenario !== "recovery") {
			assert.throws(() => store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), /candidate identity|retain staged file|unowned|invalid integration path|settled coding or operational candidate/);
			assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
			return;
		}
		assert.throws(() => store.prepareRuntimeIntegration(identity.attemptKey, content.retain(Buffer.from("substituted"))), /candidate.*manifest/);
		const manifestPath = content.path(staged.manifest); const original = readFileSync(manifestPath);
		writeFileSync(manifestPath, "tampered");
		assert.throws(() => store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), /digest mismatch/);
		writeFileSync(manifestPath, original);
		const prepared = store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest);
		assert.equal(prepared.state, "prepared"); assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
		assert.deepEqual(store.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), prepared);
		const reopened = new GraphStore({ dbPath: store.dbPath }); stores.push(reopened);
		assert.deepEqual(reopened.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), prepared);
		journal = new RuntimeIntegration(store.dbPath);
		let status = journal.advance(prepared.id, "apply");
		while (status.state === "applying") status = journal.advance(prepared.id, "apply");
		assert.equal(status.state, "applied"); assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "after");
		assert.deepEqual(reopened.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), status);
		assert.equal(reopened.runtimeAttempt(identity.attemptKey).candidateId, settled.candidateId);
		assert.equal(reopened.getOperation(operation.id).status, "running");
		reopened.record({ runId: run.runId, operationId: operation.id, status: "cancelled" });
		assert.throws(() => reopened.prepareRuntimeIntegration(identity.attemptKey, staged.manifest), /cancelled/);
	} finally { journal?.close(); for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});
