import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateReport } from "../scripts/report-audit.ts";
import { productionSourceDigest } from "../scripts/production-audit.ts";

const ROOT = join(process.cwd(), "agent-output", "production-acpx-worker-backend");

describe("durable real ACPX report matrix evidence", () => {
	test("validates Pi, Codex, and Claude reports and final lifecycle status", () => {
		const reports = ["real-matrix-pi-report.json", "real-matrix-codex-report.json", "real-matrix-claude-report.json"];
		for (const name of reports) {
			const audit = validateReport(JSON.parse(readFileSync(join(ROOT, name), "utf8")), "audit");
			assert.equal(audit.valid, true, `${name}: ${JSON.stringify(audit.errors)}`);
			assert.equal(audit.verdict, "PASS");
		}
		const status = JSON.parse(readFileSync(join(ROOT, "real-matrix-status.json"), "utf8"));
		assert.equal(status.status, "passed");
		for (const agent of ["pi", "codex", "claude"]) {
			assert.deepEqual(status[agent].lifecycle, { ensure: true, queue: true, activeCancellation: true, reconnect: true, close: true });
			assert.deepEqual(status[agent].agentFs, { owned: 0, violations: 0 });
		}
		assert.match(JSON.stringify(JSON.parse(readFileSync(join(ROOT, "real-matrix-pi-report.json"), "utf8"))), /Supervisor projection/);
		assert.equal(status.finalMatrixEvidence.tokenFileDeleted, true);
		const sourceSha256 = productionSourceDigest(process.cwd());
		for (const agent of ["pi", "codex", "claude"]) {
			const path = join(ROOT, "final-matrix", `${agent}.json`);
			const evidence = JSON.parse(readFileSync(path, "utf8"));
			assert.equal(statSync(path).mode & 0o777, 0o600);
			assert.equal(evidence.productionSourceSha256, sourceSha256);
			assert.deepEqual(evidence.lifecycle, { ensured: true, queued: true, cancelled: true, reconnected: true, closed: true });
			assert.equal(evidence.agentFs.violations, 0);
			assert.equal(evidence.credentialBoundary.valuePersisted, false);
			const production = JSON.parse(readFileSync(join(ROOT, "final-matrix", `${agent}-production.json`), "utf8"));
			assert.equal(production.productionSourceSha256, sourceSha256);
			for (const field of ["tabAbsent", "paneAbsent", "agentAbsent", "queueOwnerAbsent", "acpxSessionFilesAbsent", "agentFsMountAbsent", "agentFsServerAbsent", "agentFsDatabaseAbsent", "agentFsHomeAbsent", "providerLinksAbsent", "reportRepairChildAbsent", "attemptDirectoryAbsent", "ownedProcessesAbsent", "sessionClosed"]) assert.equal(production.cleanup[field], true, `${agent}.${field}`);
		}
	});

	test("contains no persisted credential material", () => {
		const evidence = ["real-matrix-status.json", "real-matrix-report.json", "real-matrix-pi-report.json", "real-matrix-codex-report.json", "real-matrix-claude-report.json"].map((name) => readFileSync(join(ROOT, name), "utf8")).join("\n");
		assert.doesNotMatch(evidence, /\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
	});
});
