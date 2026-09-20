import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GraphStore } from "../store.ts";
import { finalizeRunDirectory } from "../index.ts";
import { packageRoot } from "./support/repoRoot.ts";

/**
 * The candidate-less failure bundle, exercised rather than described: a real supervisor runs a real worker
 * that exits cleanly having captured nothing, the shipped settler diagnoses it, and the store then retains
 * both artifacts durably. US-001's criteria are what this pins.
 */

interface BundleReport {
	readonly valid: boolean;
	readonly supervisorExited: boolean;
	readonly settlementError: string | null;
	readonly postSettlementFailures: readonly string[];
	readonly diagnosticsPath: string | null;
	readonly captureRetainedPath: string | null;
	readonly runDir: string;
	readonly attemptDir: string;
	readonly eventWindow: number;
	readonly eventsEmitted: number;
	readonly bundleName: string;
	readonly bundleMode: string;
	readonly bundleInRunDir: boolean;
	readonly bundleReason: string;
	readonly bundleOperationId: string;
	readonly bundleCaptureStatus: string;
	readonly bundleStderrTail: string;
	readonly bundleRecentEventCount: number;
	readonly captureLines: number;
	readonly captureMode: string;
	readonly captureFirstSeq: number;
	readonly captureLastSeq: number;
}

function exercise(extraArgs: readonly string[] = []): BundleReport {
	const run = spawnSync("python3", [join(packageRoot, "test/support/failure-bundle-driver.py"), ...extraArgs], { encoding: "utf8", timeout: 180_000 });
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout) as BundleReport;
}

describe("candidate-less failure bundle, live", () => {
	test("a worker that settles with no candidate leaves a bundle and a bounded capture tail", () => {
		const report = exercise();
		assert.equal(report.supervisorExited, true, "the real supervisor ran the real worker");
		assert.equal(report.settlementError, null, `settlement must not fail: ${report.settlementError}`);
		assert.equal(report.valid, true);
		assert.deepEqual(report.postSettlementFailures, [], "a clean candidate-less settle has nothing to report afterwards");

		// US-001: the diagnosis no longer depends on the capture alone.
		assert.ok(report.diagnosticsPath, "a candidate-less settle must name a failure bundle");
		assert.equal(report.bundleName, "failure-op-candidate-less.json");
		assert.equal(report.bundleInRunDir, true, "the launcher writes it beside the run's other records");
		assert.equal(report.bundleMode, "0o600");
		assert.equal(report.bundleReason, "attempt settled without a candidate");
		assert.equal(report.bundleOperationId, "op-candidate-less");
		assert.equal(report.bundleCaptureStatus, "empty");
		assert.match(report.bundleStderrTail, /outside the prompt turn/, "the bundle carries the worker's stderr");
		assert.ok(report.bundleRecentEventCount > 0, `the bundle carries the worker's recent events, got ${report.bundleRecentEventCount}`);

		// The retained capture is the bounded tail the same window defines, not the stream.
		assert.ok(report.captureRetainedPath, "an incomplete capture retains a tail");
		assert.equal(report.captureMode, "0o600");
		assert.equal(report.captureLines, report.eventWindow, `the tail is one event window, got ${report.captureLines}`);
		assert.ok(report.eventsEmitted > report.captureLines, "the worker emitted more than the window keeps");
		assert.equal(report.captureLastSeq, report.eventsEmitted - 1, "the tail ends at the worker's final event");
		assert.equal(report.captureFirstSeq, report.eventsEmitted - report.eventWindow, "and starts one window back");

		rmSync(report.runDir, { recursive: true, force: true });
	});

	test("the store retains that bundle and tail durably, and the settle reports where they went", () => {
		const report = exercise();
		const store = new GraphStore({ dbPath: join(mkdtempSync(join(tmpdir(), "failure-bundle-store-")), "graph.db") });
		try {
			const runId = "run_failure_bundle_live";
			const result: Record<string, unknown> = { diagnosticsPath: report.diagnosticsPath, captureRetainedPath: report.captureRetainedPath };
			const originals = new Map(Object.keys(result).map((key) => [key, readFileSync(String(result[key]))]));

			finalizeRunDirectory(store, runId, report.runDir, result);

			assert.equal(existsSync(report.runDir), false, "a settled operation leaves no run directory");
			for (const key of ["diagnosticsPath", "captureRetainedPath"]) {
				const retained = String(result[key]);
				assert.ok(retained.includes(join("evidence", runId)), `${key} must name the durable home`);
				assert.equal(existsSync(retained), true, `${key} must survive the removal`);
				assert.deepEqual(readFileSync(retained), originals.get(key), `${key} must be retained byte-exact`);
				assert.equal(statSync(retained).mode & 0o777, 0o600, "retained evidence stays private");
			}
			assert.equal(basename(String(result.diagnosticsPath)), "failure-op-candidate-less.json", "the record keeps its name");
		} finally { store.close(); }
	});

	test("a post-settlement failure replaces the candidate-less reason in the bundle that reports it", () => {
		// Observed, and recorded rather than hidden: the abort path writes the same failure-<operationId>.json,
		// so when a later step fails the human-readable reason becomes the abort's. The candidate-less signal
		// survives in the bundle's workerResult.capture.captureStatus, which is what the assertion below pins.
		const report = exercise(["--with-post-settlement-failure"]);
		assert.ok(report.postSettlementFailures.length > 0, "the unpatched settle steps report their failures");
		assert.equal(report.bundleReason, "attempt aborted before cleanup", "the abort bundle is the one left at that path");
		assert.equal(report.bundleCaptureStatus, "empty", "and the candidate-less evidence is still inside it");
		assert.equal(report.bundleRecentEventCount, 20, "with the worker's recent events intact");
		rmSync(report.runDir, { recursive: true, force: true });
	});
});