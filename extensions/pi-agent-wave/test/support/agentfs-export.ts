import { chmodSync, writeFileSync } from "node:fs";
import { agentFsAuditErrorMessage, auditAgentFsChanges, exportOwnedAgentFsChanges } from "../../lib/agentfs-sandbox.ts";

/**
 * Test harness only: audits a closed AgentFS delta against declared ownership and, when clean, exports the
 * owned files to the host the way the retired legacy launcher did. Production placement goes through the
 * runtime integration journal; this keeps the ownership-audit proofs runnable against a real mount.
 */
export interface ExportConfig {
	schemaVersion: 1;
	agentFsExecutable: string;
	dbPath: string;
	baseDir: string;
	ownedPaths: string[];
	ignoredPaths: string[];
	discardAllChanges: boolean;
	resultPath: string;
	ownWholeBase?: boolean;
}

export function runExport(config: ExportConfig): number {
	const audit = auditAgentFsChanges(config.dbPath, config.baseDir, config.ownedPaths, { ignoredPaths: config.ignoredPaths, agentFsExecutable: config.agentFsExecutable, ownWholeBase: config.ownWholeBase === true });
	const effective = config.discardAllChanges ? { changes: audit.changes, owned: [], ignored: audit.changes, violations: [] } : audit;
	const result = {
		schemaVersion: 1,
		changes: effective.changes,
		owned: effective.owned,
		ignored: effective.ignored,
		violations: effective.violations,
		errors: audit.errors,
		auditError: audit.errors.length ? agentFsAuditErrorMessage(audit.errors) : null,
		discardedReadOnlyChanges: config.discardAllChanges ? audit.changes.length : 0,
		exported: false,
	};
	if (!audit.errors.length && !effective.violations.length) {
		if (!config.discardAllChanges) exportOwnedAgentFsChanges(config.agentFsExecutable, config.dbPath, config.baseDir, audit);
		result.exported = true;
	}
	writeFileSync(config.resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
	chmodSync(config.resultPath, 0o600);
	return result.exported ? 0 : 2;
}
