#!/usr/bin/env -S node --experimental-strip-types
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditReport, validateReport, type DelegateReport, type ReportDiagnostic } from "./report-audit.ts";

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_OUTCOMES = ["accepted", "blocked", "failed"] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

export interface LedgerAggregate {
	name: string;
	numerator: number;
	denominator: number;
	percentage: number;
}

export interface LedgerEntry {
	schemaVersion: typeof LEDGER_SCHEMA_VERSION;
	sequence: number;
	operationId?: string;
	topic: string;
	routing: { runId: string; tier: string; model: string };
	outcome: LedgerOutcome;
	dispatchedAt: string;
	task: string;
	report?: DelegateReport;
	rejectedCandidate?: { raw: string; diagnostics: ReportDiagnostic[] };
	rejectionDiagnostics?: ReportDiagnostic[];
	aggregates?: LedgerAggregate[];
}

export interface LedgerFinding {
	file: string;
	code: string;
	message: string;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "entry";
}

function positiveVerdict(verdict: string): boolean {
	return ["PASS", "GREEN", "SUCCESS", "DONE", "READY"].includes(verdict.toUpperCase());
}

function rejectedCandidate(task: string): boolean {
	return /rejected candidate|candidate rejected/i.test(task);
}

async function nextSequence(directory: string): Promise<number> {
	const names = await readdir(directory).catch(() => [] as string[]);
	return names.reduce((max, name) => Math.max(max, Number.parseInt(name.match(/^(\d+)-/)?.[1] ?? "0", 10) || 0), 0) + 1;
}

async function acquireSequenceLock(directory: string): Promise<string> {
	const lock = join(directory, ".sequence-lock");
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			await mkdir(lock);
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		}
	}
	throw new Error("timed out acquiring ledger sequence lock");
}

export interface WriteLedgerOptions {
	story: string;
	topic: string;
	runId: string;
	tier: string;
	model: string;
	outcome: LedgerOutcome;
	task: string;
	reportPath: string;
	operationId?: string;
	allowInvalidReport?: boolean;
	base?: string;
	rejectionDiagnostics?: ReportDiagnostic[];
	now?: Date;
	aggregates?: LedgerAggregate[];
}

/** Append one private JSON ledger entry without overwriting a concurrent writer. */
export async function writeLedgerEntry(options: WriteLedgerOptions): Promise<string> {
	if (!LEDGER_OUTCOMES.includes(options.outcome)) throw new Error(`unsupported ledger outcome ${options.outcome}`);
	const audit = await auditReport(options.reportPath, { privateRoot: dirname(resolve(options.reportPath)) });
	const preservesRejectedCandidate = !audit.valid && options.outcome === "failed" && (rejectedCandidate(options.task) || options.allowInvalidReport === true);
	if (!audit.report && !preservesRejectedCandidate) throw new Error(`cannot ledger an invalid report without failed rejected-candidate marking: ${JSON.stringify(audit.errors)}`);
	if (options.outcome !== "accepted" && audit.report && positiveVerdict(audit.report.verdict) && !rejectedCandidate(options.task) && !options.allowInvalidReport) {
		throw new Error("failed or blocked positive verdict requires a rejected candidate task marker");
	}
	let rawRejected = "";
	if (preservesRejectedCandidate) rawRejected = await readFile(options.reportPath, "utf8").catch(() => "");
	const directory = join(options.base ?? join(process.cwd(), "agent-output"), options.story, "delegate-ledger");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lock = await acquireSequenceLock(directory);
	try {
		let replacement: { path: string; sequence: number } | undefined;
		if (options.operationId) {
			for (const name of await readdir(directory).catch(() => [] as string[])) {
				if (!name.endsWith(".json")) continue;
				const existingPath = join(directory, name);
				const existing = JSON.parse(await readFile(existingPath, "utf8").catch(() => "null")) as Partial<LedgerEntry> | null;
				if (existing?.operationId !== options.operationId) continue;
				if (existing.outcome === options.outcome) return existingPath;
				if (existing.outcome !== "failed" || !Number.isInteger(existing.sequence)) throw new Error(`operation ${options.operationId} already has settled ${existing.outcome ?? "unknown"} ledger outcome`);
				replacement = { path: existingPath, sequence: existing.sequence as number };
				break;
			}
		}
		const sequence = replacement?.sequence ?? await nextSequence(directory);
		const path = replacement?.path ?? join(directory, `${String(sequence).padStart(2, "0")}-${slug(options.topic)}.json`);
		const entry: LedgerEntry = {
			schemaVersion: LEDGER_SCHEMA_VERSION,
			sequence,
			...(options.operationId ? { operationId: options.operationId } : {}),
			topic: options.topic,
			routing: { runId: options.runId, tier: options.tier, model: options.model },
			outcome: options.outcome,
			dispatchedAt: (options.now ?? new Date()).toISOString(),
			task: options.task,
			...(audit.report ? { report: audit.report } : { rejectedCandidate: { raw: rawRejected, diagnostics: options.rejectionDiagnostics?.length ? options.rejectionDiagnostics : audit.errors } }),
			...(options.rejectionDiagnostics?.length ? { rejectionDiagnostics: options.rejectionDiagnostics } : {}),
			...(options.aggregates?.length ? { aggregates: options.aggregates } : {}),
		};
		const serialized = `${JSON.stringify(entry, null, 2)}\n`;
		if (replacement) {
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} else {
			await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
		}
		await chmod(path, 0o600);
		return path;
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

function validateEntry(value: unknown, file: string): LedgerFinding[] {
	const findings: LedgerFinding[] = [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return [{ file, code: "ENTRY_OBJECT", message: "ledger entry must be an object" }];
	const entry = value as Partial<LedgerEntry>;
	if (entry.schemaVersion !== LEDGER_SCHEMA_VERSION) findings.push({ file, code: "ENTRY_SCHEMA", message: `schemaVersion must equal ${LEDGER_SCHEMA_VERSION}` });
	if (!Number.isInteger(entry.sequence) || Number(entry.sequence) <= 0) findings.push({ file, code: "ENTRY_SEQUENCE", message: "sequence must be a positive integer" });
	if (!entry.topic?.trim()) findings.push({ file, code: "ENTRY_TOPIC", message: "topic must be non-empty" });
	if (!entry.routing?.runId || !entry.routing.tier || !entry.routing.model) findings.push({ file, code: "ENTRY_ROUTING", message: "routing metadata is incomplete" });
	if (!entry.outcome || !LEDGER_OUTCOMES.includes(entry.outcome)) findings.push({ file, code: "ENTRY_OUTCOME", message: "outcome is invalid" });
	if (!entry.task?.trim()) findings.push({ file, code: "ENTRY_TASK", message: "task must be non-empty" });
	const report = entry.report ? validateReport(entry.report) : { valid: false, errors: [], verdict: undefined };
	if (entry.report) for (const error of report.errors) findings.push({ file, code: error.code, message: `${error.path}: ${error.message}` });
	else if (entry.outcome !== "failed" || (!rejectedCandidate(entry.task ?? "") && !entry.operationId) || !entry.rejectedCandidate?.diagnostics?.length) {
		findings.push({ file, code: "REJECTED_CANDIDATE", message: "missing validated report without a complete failed rejected-candidate record" });
	}
	if (entry.outcome && entry.outcome !== "accepted" && report.verdict && positiveVerdict(report.verdict) && !rejectedCandidate(entry.task ?? "")) {
		findings.push({ file, code: "OUTCOME_VERDICT", message: "failed or blocked positive verdict lacks rejected candidate task marker" });
	}
	for (const [index, aggregate] of (entry.aggregates ?? []).entries()) {
		if (!aggregate.name?.trim() || !Number.isFinite(aggregate.numerator) || !Number.isFinite(aggregate.denominator) || aggregate.denominator === 0 || !Number.isFinite(aggregate.percentage)) {
			findings.push({ file, code: "AGGREGATE_INVALID", message: `aggregate ${index + 1} is incomplete or has a zero denominator` });
			continue;
		}
		const expected = aggregate.numerator / aggregate.denominator * 100;
		if (Math.abs(expected - aggregate.percentage) > 1e-9) findings.push({ file, code: "AGGREGATE_MISMATCH", message: `${aggregate.name} percentage ${aggregate.percentage} does not equal ${expected}` });
	}
	return findings;
}

function auditLegacyMarkdown(text: string, file: string): LedgerFinding[] {
	const findings: LedgerFinding[] = [];
	if (!/^Run: /m.test(text)) findings.push({ file, code: "LEGACY_RUN", message: "missing Run header" });
	const claims = text.split(/^## Claim:/m).slice(1);
	if (!claims.length) findings.push({ file, code: "LEGACY_CLAIMS", message: "no Claim blocks" });
	claims.forEach((claim, index) => {
		const lines = claim.split(/\r?\n/);
		const evidenceIndex = lines.findIndex((line) => /^Evidence(?::|,)/.test(line));
		const verifiedIndex = lines.findIndex((line) => /^Verified: (yes|no|unverified-recall)$/.test(line));
		if (evidenceIndex < 0) findings.push({ file, code: "LEGACY_EVIDENCE", message: `claim ${index + 1} lacks Evidence` });
		else {
			const inline = lines[evidenceIndex].replace(/^Evidence(?::|,)\s*/, "").trim();
			const continuation = lines.slice(evidenceIndex + 1, verifiedIndex < 0 ? undefined : verifiedIndex).some((line) => line.trim() && !line.startsWith("## "));
			if (!inline && !continuation) findings.push({ file, code: "LEGACY_EVIDENCE", message: `claim ${index + 1} has empty Evidence` });
		}
		if (verifiedIndex < 0) findings.push({ file, code: "LEGACY_VERIFIED", message: `claim ${index + 1} lacks canonical Verified marker` });
	});
	const outcome = text.match(/^Run: .*Outcome: (accepted|blocked|failed)$/m)?.[1];
	const task = text.match(/^Dispatched: .*Task: (.*)$/m)?.[1] ?? "";
	const inlineVerdict = text.match(/^## Verdict:\s*(PASS|GREEN|SUCCESS|DONE)\s*$/m)?.[1];
	const blockVerdict = text.match(/^## Verdict\s*\n\s*(PASS|GREEN|SUCCESS|DONE)\s*$/m)?.[1];
	if ((outcome === "blocked" || outcome === "failed") && (inlineVerdict || blockVerdict) && !(outcome === "failed" && rejectedCandidate(task))) {
		findings.push({ file, code: "LEGACY_OUTCOME_VERDICT", message: "blocked or failed entry carries a standalone success verdict" });
	}
	return findings;
}

/** Audit JSON v1 entries and historical Markdown entries without rewriting either. */
export async function auditLedger(story: string, base = join(process.cwd(), "agent-output")): Promise<{ valid: boolean; findings: LedgerFinding[]; files: number; summary: string }> {
	const directory = join(base, story, "delegate-ledger");
	const names = (await readdir(directory)).filter((name) => name.endsWith(".json") || name.endsWith(".md")).sort();
	const findings: LedgerFinding[] = [];
	if (!names.length) findings.push({ file: directory, code: "LEDGER_EMPTY", message: "ledger directory is empty" });
	for (const name of names) {
		const path = join(directory, name);
		const mode = (await stat(path)).mode & 0o777;
		if (mode !== 0o600) findings.push({ file: name, code: "LEDGER_MODE", message: `mode is ${mode.toString(8)}, expected 600` });
		const text = await readFile(path, "utf8");
		if (name.endsWith(".md")) findings.push(...auditLegacyMarkdown(text, name));
		else {
			try { findings.push(...validateEntry(JSON.parse(text), name)); }
			catch (error) { findings.push({ file: name, code: "LEDGER_JSON", message: error instanceof Error ? error.message : String(error) }); }
		}
	}
	const valid = findings.length === 0;
	return { valid, findings, files: names.length, summary: valid ? `PASS: audited ${names.length} ledger files` : `FAIL: ${findings.length} findings across ${names.length} ledger files` };
}

function parseArgs(argv: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg.startsWith("--")) values[arg.slice(2)] = argv[++index] ?? "";
		else if (!values._command) values._command = arg;
		else if (!values.story) values.story = arg;
		else if (!values.topic) values.topic = arg;
		else throw new Error(`unexpected argument ${arg}`);
	}
	return values;
}

async function main(): Promise<void> {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args._command === "write") {
			const path = await writeLedgerEntry({
				story: args.story, topic: args.topic, runId: args.run, tier: args.tier, model: args.model,
				outcome: args.outcome as LedgerOutcome, task: args.task, reportPath: args.report,
				base: args.base, rejectionDiagnostics: args["diagnostics-json"] ? JSON.parse(args["diagnostics-json"]) : undefined,
				aggregates: args["aggregates-json"] ? JSON.parse(args["aggregates-json"]) : undefined,
			});
			console.log(path);
		} else if (args._command === "audit") {
			const result = await auditLedger(args.story, args.base);
			console.log(JSON.stringify(result, null, 2));
			if (!result.valid) process.exitCode = 1;
		} else throw new Error("usage: ledger.ts <write|audit> <story> [topic] [options]");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
