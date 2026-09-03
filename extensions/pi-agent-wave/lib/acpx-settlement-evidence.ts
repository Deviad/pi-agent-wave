export interface SettlementIdentityExpected {
	transport?: "headless" | "herdr";
	runId: string;
	operationId: string;
	agentName: string;
	herdrAgent?: string;
	tabId?: string;
	herdrPaneId?: string;
	acpxCancelScript: string;
	acpAgent: string;
	acpxRecordId: string;
	acpxSessionId: string;
	acpxAttemptKey: string;
	agentFsSessionId: string;
	agentFsDbPath: string;
	reportPath: string;
	reportSha256: string;
}

/** Rejects any transport settlement identity that differs from registered GraphStore/report evidence. */
export function validateSettlementIdentity(evidence: Readonly<Record<string, unknown>>, expected: SettlementIdentityExpected): void {
	const transport = expected.transport ?? "herdr";
	for (const [key, value] of Object.entries(expected)) {
		if (key !== "transport" && value !== undefined && evidence[key] !== value) throw new Error(`settlement evidence ${key} mismatch`);
	}
	if ((evidence.transport ?? "herdr") !== transport) throw new Error("settlement evidence transport mismatch");
	if (transport === "herdr") {
		for (const key of ["herdrAgent", "tabId", "herdrPaneId"] as const) {
			if (!expected[key]) throw new Error(`expected Herdr settlement ${key} is required`);
		}
		if (evidence.herdrVisible !== true) throw new Error("settlement evidence herdrVisible must be true");
	} else {
		for (const key of ["herdrAgent", "tabId", "herdrPaneId"] as const) {
			if (evidence[key] !== undefined && evidence[key] !== null) throw new Error(`headless settlement evidence ${key} must be absent`);
		}
		if (evidence.presentationVerified !== true) throw new Error("headless settlement presentation identity must be verified");
	}
	for (const key of ["identityMatches", "agentFsExported", "sessionClosed", "providerLinksVerified", "ledgerValid", "cleanupVerified"] as const) {
		if (evidence[key] !== true) throw new Error(`settlement evidence ${key} must be true`);
	}
	if (evidence.agentFsViolationCount !== 0) throw new Error("settlement evidence contains AgentFS violations");
	if (evidence.processExitCode !== 0) throw new Error("settlement evidence process exit is nonzero");
	if (evidence.terminalKind !== "completed") throw new Error("settlement evidence terminal is not completed");
}
