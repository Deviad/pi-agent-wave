#!/usr/bin/env -S node --experimental-strip-types
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeName } from "../types.ts";

export const REPORT_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_STATES = ["verified", "unverified", "unverified-recall"] as const;
export const EVIDENCE_KINDS = ["command", "file", "output", "inference"] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ReportEvidence {
	kind: EvidenceKind;
	source: string;
	detail: string;
}

export interface ReportClaim {
	statement: string;
	evidence: ReportEvidence[];
	verification: VerificationState;
}

export interface OperationalExecution {
	argv: string[];
	exitCode: number;
	source: string;
	runId: string;
	checkpointPath: string;
	checkpointStatus: string;
	resultsPath?: string;
	candidateCount: number;
	sourceStatus: "completed" | "budget-exhausted" | "blocked" | "preflight-failed" | "failed";
	blocker?: string;
	resumeArgv?: string[];
}

export interface DelegateReport {
	schemaVersion: typeof REPORT_SCHEMA_VERSION;
	verdict: string;
	claims: ReportClaim[];
	execution?: OperationalExecution;
}

export interface ReportDiagnostic {
	code: string;
	path: string;
	message: string;
}

export interface ReportAudit {
	valid: boolean;
	verdict?: string;
	report?: DelegateReport;
	errors: ReportDiagnostic[];
}

export interface AuditOptions {
	node?: NodeName;
	privateRoot?: string;
	ownedRoots?: string[];
	normalizePermissions?: boolean;
}

const ROLE_VERDICTS: Partial<Record<NodeName, readonly string[]>> = {
	thinker_plan: ["READY"],
	thinker_split: ["READY"],
	thinker_synthesize: ["DONE"],
	implement: ["DONE"],
	review: ["PASS", "FAIL"],
	test: ["GREEN", "NOT_OK"],
	audit: ["PASS", "FAIL"],
	search: ["DONE"],
	source_search: ["DONE", "BLOCKED"],
};

function diagnostic(code: string, path: string, message: string): ReportDiagnostic {
	return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** Validate one parsed JSON report without repairing semantic content. */
export function validateReport(value: unknown, node?: NodeName): ReportAudit {
	const errors: ReportDiagnostic[] = [];
	if (!isRecord(value)) return { valid: false, errors: [diagnostic("REPORT_OBJECT_REQUIRED", "$", "report must be a JSON object")] };

	for (const key of unknownKeys(value, ["schemaVersion", "verdict", "claims", "execution"])) {
		errors.push(diagnostic("UNKNOWN_FIELD", `$.${key}`, `unknown report field '${key}'`));
	}
	if (value.schemaVersion !== REPORT_SCHEMA_VERSION) {
		errors.push(diagnostic("SCHEMA_VERSION", "$.schemaVersion", `schemaVersion must equal ${REPORT_SCHEMA_VERSION}`));
	}
	const verdict = nonEmptyString(value.verdict) ? value.verdict.trim().toUpperCase() : undefined;
	if (!verdict || !/^[A-Z][A-Z0-9_]*$/.test(verdict)) {
		errors.push(diagnostic("VERDICT_INVALID", "$.verdict", "verdict must be a non-empty uppercase identifier"));
	} else if (node && ROLE_VERDICTS[node] && !ROLE_VERDICTS[node]!.includes(verdict)) {
		errors.push(diagnostic("VERDICT_FOR_NODE", "$.verdict", `${node} verdict must be one of ${ROLE_VERDICTS[node]!.join(", ")}`));
	}
	if (!Array.isArray(value.claims) || value.claims.length === 0) {
		errors.push(diagnostic("CLAIMS_REQUIRED", "$.claims", "claims must be a non-empty array"));
	} else {
		value.claims.forEach((claim, claimIndex) => {
			const claimPath = `$.claims[${claimIndex}]`;
			if (!isRecord(claim)) {
				errors.push(diagnostic("CLAIM_OBJECT_REQUIRED", claimPath, "claim must be an object"));
				return;
			}
			for (const key of unknownKeys(claim, ["statement", "evidence", "verification"])) {
				errors.push(diagnostic("UNKNOWN_FIELD", `${claimPath}.${key}`, `unknown claim field '${key}'`));
			}
			if (!nonEmptyString(claim.statement)) errors.push(diagnostic("CLAIM_STATEMENT", `${claimPath}.statement`, "statement must be non-empty"));
			if (!VERIFICATION_STATES.includes(claim.verification as VerificationState)) {
				errors.push(diagnostic("VERIFICATION_STATE", `${claimPath}.verification`, `verification must be one of ${VERIFICATION_STATES.join(", ")}`));
			}
			if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
				errors.push(diagnostic("EVIDENCE_REQUIRED", `${claimPath}.evidence`, "evidence must be a non-empty array"));
				return;
			}
			claim.evidence.forEach((entry, evidenceIndex) => {
				const evidencePath = `${claimPath}.evidence[${evidenceIndex}]`;
				if (!isRecord(entry)) {
					errors.push(diagnostic("EVIDENCE_OBJECT_REQUIRED", evidencePath, "evidence item must be an object"));
					return;
				}
				for (const key of unknownKeys(entry, ["kind", "source", "detail"])) {
					errors.push(diagnostic("UNKNOWN_FIELD", `${evidencePath}.${key}`, `unknown evidence field '${key}'`));
				}
				if (!EVIDENCE_KINDS.includes(entry.kind as EvidenceKind)) errors.push(diagnostic("EVIDENCE_KIND", `${evidencePath}.kind`, `kind must be one of ${EVIDENCE_KINDS.join(", ")}`));
				if (!nonEmptyString(entry.source)) errors.push(diagnostic("EVIDENCE_SOURCE", `${evidencePath}.source`, "source must be non-empty"));
				if (!nonEmptyString(entry.detail)) errors.push(diagnostic("EVIDENCE_DETAIL", `${evidencePath}.detail`, "detail must be non-empty"));
			});
		});
	}

	let execution: OperationalExecution | undefined;
	if (node === "source_search") {
		const candidate = isRecord(value.execution) ? value.execution : undefined;
		if (!candidate) {
			errors.push(diagnostic("EXECUTION_REQUIRED", "$.execution", "source_search requires task-specific execution proof"));
		} else {
			for (const key of unknownKeys(candidate, ["argv", "exitCode", "source", "runId", "checkpointPath", "checkpointStatus", "resultsPath", "candidateCount", "sourceStatus", "blocker", "resumeArgv"])) {
				errors.push(diagnostic("EXECUTION_FIELD", `$.execution.${key}`, "unknown execution field"));
			}
			for (const field of ["source", "runId", "checkpointPath", "checkpointStatus", "sourceStatus"] as const) {
				if (!nonEmptyString(candidate[field])) errors.push(diagnostic("EXECUTION_FIELD", `$.execution.${field}`, "must be a non-empty string"));
			}
			if (candidate.resultsPath !== undefined && !nonEmptyString(candidate.resultsPath)) errors.push(diagnostic("EXECUTION_FIELD", "$.execution.resultsPath", "must be a non-empty string when provided"));
			if (!Array.isArray(candidate.argv) || !candidate.argv.length || candidate.argv.some((item) => !nonEmptyString(item))) errors.push(diagnostic("EXECUTION_ARGV", "$.execution.argv", "must be a non-empty argv string array"));
			if (!Number.isInteger(candidate.exitCode)) errors.push(diagnostic("EXECUTION_EXIT", "$.execution.exitCode", "must be an integer"));
			if (!Number.isInteger(candidate.candidateCount) || Number(candidate.candidateCount) < 0) errors.push(diagnostic("EXECUTION_COUNT", "$.execution.candidateCount", "must be a non-negative integer"));
			if (Number(candidate.candidateCount) > 0 && !nonEmptyString(candidate.resultsPath)) errors.push(diagnostic("EXECUTION_RESULTS", "$.execution.resultsPath", "candidate-producing execution requires a results path"));
			const sourceStatus = String(candidate.sourceStatus ?? "");
			if (!["completed", "budget-exhausted", "blocked", "preflight-failed", "failed"].includes(sourceStatus)) errors.push(diagnostic("EXECUTION_STATUS", "$.execution.sourceStatus", "unsupported source status"));
			if (verdict === "DONE" && (candidate.exitCode !== 0 || sourceStatus !== "completed")) errors.push(diagnostic("EXECUTION_DONE", "$.execution", "DONE requires exit 0 and completed source status"));
			if (verdict === "BLOCKED") {
				if (!nonEmptyString(candidate.blocker) || !String(candidate.blocker).toLowerCase().includes(String(candidate.source ?? "").toLowerCase())) errors.push(diagnostic("EXECUTION_BLOCKER", "$.execution.blocker", "BLOCKED requires blocker evidence naming the source"));
				if (sourceStatus === "budget-exhausted" && (!Array.isArray(candidate.resumeArgv) || !candidate.resumeArgv.length || candidate.resumeArgv.some((item) => !nonEmptyString(item)))) errors.push(diagnostic("EXECUTION_RESUME", "$.execution.resumeArgv", "budget exhaustion requires resume argv"));
			}
			if (!errors.some((error) => error.path.startsWith("$.execution"))) execution = candidate as unknown as OperationalExecution;
		}
	} else if (node !== undefined && value.execution !== undefined) {
		errors.push(diagnostic("EXECUTION_UNEXPECTED", "$.execution", "execution proof is only valid for source_search"));
	}

	const report = errors.length === 0 ? { ...(value as unknown as DelegateReport), ...(execution ? { execution } : {}) } : undefined;
	return { valid: errors.length === 0, verdict, report, errors };
}

function pathInside(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** Audit one assigned report, normalizing only BOM, outer whitespace, and mode. */
export async function auditReport(path: string, options: AuditOptions = {}): Promise<ReportAudit> {
	const absolute = resolve(path);
	try {
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) return { valid: false, errors: [diagnostic("REPORT_SYMLINK", "$", "report must not be a symlink")] };
		if (!stat.isFile()) return { valid: false, errors: [diagnostic("REPORT_FILE", "$", "report is not a regular file")] };
		if (options.privateRoot) {
			const root = await realpath(options.privateRoot);
			const parent = await realpath(dirname(absolute));
			if (!pathInside(root, parent)) return { valid: false, errors: [diagnostic("REPORT_PATH", "$", "report is outside the assigned private root")] };
		}
		if (options.normalizePermissions !== false && (stat.mode & 0o777) !== 0o600) await chmod(absolute, 0o600);
		const text = (await readFile(absolute, "utf8")).replace(/^\uFEFF/, "").trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			return { valid: false, errors: [diagnostic("JSON_PARSE", "$", error instanceof Error ? error.message : String(error))] };
		}
		const validated = validateReport(parsed, options.node);
		if (validated.valid && validated.report?.execution && validated.verdict === "DONE" && options.ownedRoots?.length) {
			const errors = [...validated.errors];
			const roots = await Promise.all(options.ownedRoots.map(async (root) => realpath(resolve(root)).catch(() => resolve(root))));
			const artifacts: Array<["checkpointPath" | "resultsPath", string]> = [["checkpointPath", validated.report.execution.checkpointPath]];
			if (validated.report.execution.resultsPath) artifacts.push(["resultsPath", validated.report.execution.resultsPath]);
			for (const [field, candidate] of artifacts) {
				const metadata = await lstat(resolve(candidate)).catch(() => undefined);
				if (!metadata?.isFile()) {
					errors.push(diagnostic("EXECUTION_ARTIFACT", `$.execution.${field}`, "completed execution artifact does not exist as a regular file"));
					continue;
				}
				const physical = await realpath(resolve(candidate));
				if (!roots.some((root) => pathInside(root, physical))) errors.push(diagnostic("EXECUTION_PATH_OWNERSHIP", `$.execution.${field}`, "execution artifact is outside declared writable roots"));
			}
			if (!validated.report.execution.resultsPath && validated.report.execution.candidateCount === 0) {
				const checkpoint = JSON.parse(await readFile(validated.report.execution.checkpointPath, "utf8").catch(() => "null")) as { jobsSaved?: unknown } | null;
				if (checkpoint?.jobsSaved !== 0) errors.push(diagnostic("EXECUTION_RESULTS", "$.execution.resultsPath", "missing results path requires checkpoint jobsSaved equal to zero"));
			}
			if (errors.length) return { valid: false, errors };
		}
		return validated;
	} catch (error) {
		return { valid: false, errors: [diagnostic("REPORT_UNAVAILABLE", "$", error instanceof Error ? error.message : String(error))] };
	}
}

export function formatDiagnostics(errors: readonly ReportDiagnostic[]): string {
	return errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join("; ");
}

function parseCli(argv: string[]): { report: string; node?: NodeName; privateRoot?: string } {
	let report = "";
	let node: NodeName | undefined;
	let privateRoot: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--report") report = argv[++index] ?? "";
		else if (value === "--node") node = argv[++index] as NodeName;
		else if (value === "--private-root") privateRoot = argv[++index];
		else if (!value.startsWith("-") && !report) report = value;
		else throw new Error(`unknown argument ${value}`);
	}
	if (!report) throw new Error("usage: report-audit.ts --report <path> [--node <node>] [--private-root <dir>]");
	return { report, node, privateRoot };
}

async function main(): Promise<void> {
	try {
		const args = parseCli(process.argv.slice(2));
		const result = await auditReport(args.report, { node: args.node, privateRoot: args.privateRoot });
		console.log(JSON.stringify(result));
		if (!result.valid) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
