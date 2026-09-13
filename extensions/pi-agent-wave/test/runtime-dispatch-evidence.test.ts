import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { materializeRuntimeEvidence } from "../index.ts";

const policy = { input: { kind: "model" as const, model: "openai-codex/gpt-5.6-sol", reason: "test" }, routes: ["thinker", "implementer", "reviewer", "tester", "auditor"].map((role) => ({ role, tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null })) };

test("a runtime-v1 dispatch materializes the derived ledger and every accepted answer, read-only, into the private run directory", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-dispatch-evidence-"));
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	try {
		const run = store.initRun("evidence", "build", "Implement the change", policy as never, undefined, "runtime-v1");
		const before = materializeRuntimeEvidence(store, run.runId, join(root, "run-plan"));
		assert.deepEqual(before.answers, []);
		assert.match(before.taskSuffix, /accepted answers of completed operations are none yet/);
		assert.equal(JSON.parse(readFileSync(before.ledgerPath, "utf8")).runId, run.runId);

		const plan = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: plan.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-plan", requestId: null, policyDigest: store.policy(run.runId).digest });
		const content = new RuntimeContentStore(store.dbPath);
		const planText = "# Plan\n\nOne slice: make bulkImport invalidate every imported key.\n";
		const answer = content.retain(Buffer.from(planText));
		store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "acp-1", requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
		store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "plan accepted", verdict: "READY", payload: { slices: [{ id: "import-invalidation", name: "import-invalidation", task: "Edit src/import.ts", ownedPaths: [join(root, "src", "import.ts")] }] } });
		assert.equal(store.getState(run.runId).currentNode, "implement");

		const privateRunDir = join(root, "run-implement");
		const evidence = materializeRuntimeEvidence(store, run.runId, privateRunDir);
		assert.equal(evidence.ledgerPath, join(privateRunDir, "runtime-evidence", "ledger.json"));
		assert.deepEqual(evidence.answers.map((item) => item.node), ["thinker_plan"]);
		assert.equal(readFileSync(evidence.answers[0].path, "utf8"), planText);
		assert.deepEqual(readdirSync(join(privateRunDir, "runtime-evidence", "answers")), ["thinker_plan-round1-fix0.md"]);
		for (const path of [evidence.ledgerPath, evidence.answers[0].path]) assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(statSync(join(privateRunDir, "runtime-evidence")).mode & 0o777, 0o700);
		const ledger = JSON.parse(readFileSync(evidence.ledgerPath, "utf8"));
		assert.equal(ledger.derived, true);
		assert.equal(ledger.operations.find((item: { node: string }) => item.node === "thinker_plan").attempts[0].decision.decision, "accepted");
		assert.match(evidence.taskSuffix, /the run ledger is .*ledger\.json; the accepted answers of completed operations are thinker_plan: .*thinker_plan-round1-fix0\.md\./);
		assert.match(evidence.taskSuffix, /never modify these files/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
