import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { finalizeRunDirectory } from "../index.ts";
import { GraphStore } from "../store.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): { root: string; runId: string; privateRunDir: string; store: GraphStore } {
	const root = mkdtempSync(join(tmpdir(), "run-finalize-"));
	directories.push(root);
	const privateRunDir = join(root, "run-private");
	mkdirSync(privateRunDir, { mode: 0o700 });
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	return { root, runId: "run_finalize", privateRunDir, store };
}

describe("run directory finalization", () => {
	test("a settled operation leaves no run directory and keeps its evidence", () => {
		const { runId, privateRunDir, store } = fixture();
		try {
			const records: Record<string, string> = {};
			const originals: Record<string, Buffer> = {};
			for (const name of ["runtime-settlement-worker.json", "cleanup-worker.json", "failure-op-1.json"]) {
				records[name] = join(privateRunDir, name);
				originals[name] = Buffer.from(`${JSON.stringify({ name })}\n`);
				writeFileSync(records[name], originals[name], { mode: 0o600 });
			}
			const capture = join(privateRunDir, "runtime-capture-worker.ndjson");
			const captureBytes = Buffer.from('{"jsonrpc":"2.0","method":"session/update"}\n{"jsonrpc":"2.0","result":{"stopReason":"end_turn"}}\n');
			writeFileSync(capture, captureBytes, { mode: 0o600 });

			const result: Record<string, unknown> = {
				settlementEvidencePath: records["runtime-settlement-worker.json"],
				cleanupEvidencePath: records["cleanup-worker.json"],
				diagnosticsPath: records["failure-op-1.json"],
				captureRetainedPath: capture,
			};
			finalizeRunDirectory(store, runId, privateRunDir, result);

			assert.equal(existsSync(privateRunDir), false, "a settled operation leaves no run directory");
			for (const name of Object.keys(records)) {
				const retained = String(result[name === "runtime-settlement-worker.json" ? "settlementEvidencePath" : name === "cleanup-worker.json" ? "cleanupEvidencePath" : "diagnosticsPath"]);
				assert.equal(basename(retained), basename(records[name]), "the record keeps its name");
				assert.ok(retained.includes(join("evidence", runId)), "the record names the durable home, not the removed directory");
				assert.equal(existsSync(retained), true, `${name} must survive the removal`);
				assert.deepEqual(readFileSync(retained), originals[name], `${name} must be retained byte-exact`);
				assert.equal(statSync(retained).mode & 0o777, 0o600, "retained evidence stays private");
			}
			// The capture stream is NDJSON read back as written: byte equality is the whole point of copying
			// bytes rather than re-serializing the record.
			const retainedCapture = String(result.captureRetainedPath);
			assert.deepEqual(readFileSync(retainedCapture), captureBytes, "the capture stream must be retained byte-exact");
		} finally { store.close(); }
	});

	test("an already-durable record is not copied onto itself", () => {
		const { runId, privateRunDir, store } = fixture();
		try {
			const durable = store.retainRunEvidence(runId, "failure-op-1.json", "{\"already\":\"retained\"}\n");
			const result: Record<string, unknown> = { diagnosticsPath: durable };
			finalizeRunDirectory(store, runId, privateRunDir, result);
			assert.equal(result.diagnosticsPath, durable, "a path outside the run directory is left alone");
			assert.equal(readFileSync(durable, "utf8"), "{\"already\":\"retained\"}\n");
		} finally { store.close(); }
	});

	test("finalizing an already-removed directory converges", () => {
		const { runId, privateRunDir, store } = fixture();
		try {
			rmSync(privateRunDir, { recursive: true, force: true });
			const result: Record<string, unknown> = { settlementEvidencePath: join(privateRunDir, "runtime-settlement-worker.json") };
			assert.doesNotThrow(() => finalizeRunDirectory(store, runId, privateRunDir, result));
			assert.equal(existsSync(privateRunDir), false);
		} finally { store.close(); }
	});
});