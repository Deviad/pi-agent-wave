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

export interface DelegateReport {
	schemaVersion: typeof REPORT_SCHEMA_VERSION;
	verdict: string;
	claims: ReportClaim[];
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

	for (const key of unknownKeys(value, ["schemaVersion", "verdict", "claims"])) {
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

	const report = errors.length === 0 ? value as unknown as DelegateReport : undefined;
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
		return validateReport(parsed, options.node);
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
