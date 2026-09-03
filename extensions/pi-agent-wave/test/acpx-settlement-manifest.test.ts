import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateSettlementIdentity, type SettlementIdentityExpected } from "../lib/acpx-settlement-evidence.ts";

const expected: SettlementIdentityExpected = {
	runId: "run",
	operationId: "operation",
	agentName: "worker",
	herdrAgent: "herdr-worker",
	tabId: "tab",
	herdrPaneId: "pane",
	acpxCancelScript: "/tmp/cancel.sh",
	acpAgent: "codex",
	acpxRecordId: "record",
	acpxSessionId: "session",
	acpxAttemptKey: "attempt",
	agentFsSessionId: "agentfs",
	agentFsDbPath: "/tmp/delta.db",
	reportPath: "/tmp/report.json",
	reportSha256: "a".repeat(64),
};

const evidence = { ...expected, schemaVersion: 1, processExitCode: 0, terminalKind: "completed", acpxState: "alive", herdrVisible: true, identityMatches: true, agentFsExported: true, agentFsViolationCount: 0, sessionClosed: true, providerLinksVerified: true, ledgerValid: true, cleanupVerified: true, cleanupEvidencePath: "/tmp/cleanup.json" };

describe("settlement manifest tamper rejection", () => {
	test("accepts complete observed identity and lifecycle evidence", () => {
		assert.doesNotThrow(() => validateSettlementIdentity(evidence, expected));
	});

	for (const key of Object.keys(expected) as Array<keyof SettlementIdentityExpected>) {
		test(`rejects tampered ${key}`, () => {
			assert.throws(() => validateSettlementIdentity({ ...evidence, [key]: `${expected[key]}-tampered` }, expected), new RegExp(`${key} mismatch`));
		});
	}

	for (const key of ["herdrVisible", "identityMatches", "agentFsExported", "sessionClosed", "providerLinksVerified", "ledgerValid", "cleanupVerified"] as const) {
		test(`rejects false ${key}`, () => {
			assert.throws(() => validateSettlementIdentity({ ...evidence, [key]: false }, expected), new RegExp(`${key}`));
		});
	}

	test("accepts headless presentation proof and rejects synthetic Herdr identity", () => {
		const { herdrAgent: _agent, tabId: _tab, herdrPaneId: _pane, ...transportNeutral } = expected;
		const headlessExpected: SettlementIdentityExpected = { ...transportNeutral, transport: "headless" };
		const headlessEvidence = { ...transportNeutral, transport: "headless", schemaVersion: 1, processExitCode: 0, terminalKind: "completed", presentationVerified: true, identityMatches: true, agentFsExported: true, agentFsViolationCount: 0, sessionClosed: true, providerLinksVerified: true, ledgerValid: true, cleanupVerified: true };
		assert.doesNotThrow(() => validateSettlementIdentity(headlessEvidence, headlessExpected));
		assert.throws(() => validateSettlementIdentity({ ...headlessEvidence, herdrPaneId: "synthetic" }, headlessExpected), /must be absent/);
		assert.throws(() => validateSettlementIdentity({ ...headlessEvidence, presentationVerified: false }, headlessExpected), /must be verified/);
	});

	test("rejects process, terminal, and AgentFS violation tampering", () => {
		assert.throws(() => validateSettlementIdentity({ ...evidence, processExitCode: 1 }, expected), /process exit/);
		assert.throws(() => validateSettlementIdentity({ ...evidence, terminalKind: "failed" }, expected), /terminal/);
		assert.throws(() => validateSettlementIdentity({ ...evidence, agentFsViolationCount: 1 }, expected), /AgentFS violations/);
	});
});
