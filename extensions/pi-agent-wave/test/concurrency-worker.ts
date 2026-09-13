import { GraphStore, roleForNode } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";

const [, , dbPath, runId, operationId] = process.argv;
if (!dbPath || !runId || !operationId) throw new Error("usage: concurrency-worker.ts <db> <run> <operation>");
const store = new GraphStore({ dbPath });
try {
	const next = store.next(runId);
	const operation = next.operations.find((candidate) => candidate.id === operationId);
	if (!operation) throw new Error(`operation ${operationId} is not pending`);
	const selectedModel = operation.route?.chain[operation.model_attempt] ?? "openai-codex/gpt-5.6-sol";
	const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId, role: roleForNode(operation.node), modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel, agent: selectAcpAgent(selectedModel) });
	store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: next.policy.digest });
	const answer = store.retainRuntimeContent(Buffer.from(`answer for ${operationId}\n\nVERDICT: PASS\n`));
	store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: identity.sessionName, requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
	store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "concurrency worker", verdict: "PASS" });
} finally {
	store.close();
}
