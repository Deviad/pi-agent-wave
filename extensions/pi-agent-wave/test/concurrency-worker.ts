import { GraphStore } from "../store.ts";

const [, , dbPath, runId, operationId] = process.argv;
if (!dbPath || !runId || !operationId) throw new Error("usage: concurrency-worker.ts <db> <run> <operation>");
const store = new GraphStore({ dbPath });
try {
	store.record({ runId, operationId, status: "completed", verdict: "PASS" });
} finally {
	store.close();
}
