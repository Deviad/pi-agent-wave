#!/usr/bin/env -S node --experimental-strip-types
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DB_PATH } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { parseRuntimeCandidate, parseRuntimeObservation, parseRuntimeOutcome, type RuntimeCandidate, type RuntimeCheckpoint, type RuntimeContent, type RuntimeObservation, type RuntimeOutcome } from "../lib/runtime-results.ts";
import { isAbsolute, relative } from "node:path";

/**
 * Turns one finished runtime-v1 worker into retained content plus a settlement record, before any
 * session close, provider check or cleanup can discard the attempt directory. It reads no report and
 * decides nothing: the outcome is the recorded process outcome, the candidate is whatever public
 * answer and audited file changes exist, and acceptance stays with the caller.
 */
export interface RuntimeSettleConfig {
	readonly schemaVersion: 1;
	readonly attemptKey: string;
	readonly workerResultPath: string;
	readonly kind: "coding" | "research" | "operational";
	readonly baseDir: string;
	/** Operational sources: the checkpoint file the source script writes, relative to baseDir or absolute under it. */
	readonly checkpointPath: string | null;
	readonly baseRevision: string;
	readonly ownedPaths: readonly string[];
	readonly readOnly: boolean;
	readonly snapshotPath: string | null;
	readonly agentFsExecutable: string;
	readonly evidencePath: string;
	readonly dbPath?: string;
}

export interface RuntimeSettlementEvidence {
	readonly schemaVersion: 1;
	readonly resultContract: "runtime-v1";
	readonly attemptKey: string;
	readonly outcome: RuntimeOutcome;
	readonly candidate: RuntimeCandidate | null;
	readonly observation: RuntimeObservation;
	readonly answer: RuntimeContent | null;
	readonly stagedFiles: number;
	readonly diagnostics: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`runtime settle config requires ${name}`); return value; }

export function parseRuntimeSettleConfig(value: unknown): RuntimeSettleConfig {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid runtime settle config schema");
	if (value.kind !== "coding" && value.kind !== "research" && value.kind !== "operational") throw new Error("runtime settle config requires kind coding, research or operational");
	if (value.checkpointPath !== undefined && value.checkpointPath !== null && typeof value.checkpointPath !== "string") throw new Error("runtime settle config checkpointPath must be a path or null");
	if (value.kind !== "operational" && value.checkpointPath) throw new Error("checkpointPath is only valid for operational settlement");
	if (typeof value.readOnly !== "boolean") throw new Error("runtime settle config requires readOnly");
	if (!Array.isArray(value.ownedPaths) || !value.ownedPaths.every((path) => typeof path === "string" && path.trim())) throw new Error("runtime settle config requires ownedPaths");
	if (value.snapshotPath !== null && typeof value.snapshotPath !== "string") throw new Error("runtime settle config snapshotPath must be a path or null");
	if ((value.kind === "coding" || value.kind === "operational") && (value.readOnly || value.snapshotPath === null)) throw new Error(`${value.kind} settlement requires an owned-write AgentFS snapshot`);
	if (value.dbPath !== undefined && typeof value.dbPath !== "string") throw new Error("runtime settle config dbPath must be a string");
	return {
		schemaVersion: 1, attemptKey: text(value.attemptKey, "attemptKey"), workerResultPath: resolve(text(value.workerResultPath, "workerResultPath")), kind: value.kind,
		baseDir: resolve(text(value.baseDir, "baseDir")), baseRevision: text(value.baseRevision, "baseRevision"), ownedPaths: value.ownedPaths.map(String), readOnly: value.readOnly,
		checkpointPath: typeof value.checkpointPath === "string" && value.checkpointPath.trim() ? value.checkpointPath : null,
		snapshotPath: value.snapshotPath === null ? null : resolve(value.snapshotPath), agentFsExecutable: text(value.agentFsExecutable, "agentFsExecutable"),
		evidencePath: resolve(text(value.evidencePath, "evidencePath")), dbPath: value.dbPath === undefined ? undefined : resolve(value.dbPath),
	};
}

/** The checkpoint is a staged owned file written by the source script; only its integer `jobsSaved` and string `status` are read. */
function observeCheckpoint(content: RuntimeContentStore, changes: readonly { readonly path: string; readonly after: RuntimeContent | null }[], baseDir: string, checkpointPath: string): RuntimeCheckpoint | null {
	const target = isAbsolute(checkpointPath) ? relative(baseDir, checkpointPath) : checkpointPath;
	if (!target || target.startsWith("..") || isAbsolute(target)) throw new Error("operational checkpoint path must lie under the working directory");
	const change = changes.find((item) => item.path === target);
	if (!change?.after) {
		// A checkpoint that exists on the host with no overlay change was written outside the sandbox (an absolute host
		// path bypasses the AgentFS overlay on this host); the attempt cannot be settled as audited work.
		if (existsSync(join(baseDir, target))) throw new Error(`operational checkpoint ${target} exists on the host but was not written through the sandbox overlay; the worker bypassed the audited workspace`);
		return null;
	}
	let parsed: unknown = null;
	try { parsed = JSON.parse(content.read(change.after, 16 * 1024 * 1024).toString("utf8")); } catch { parsed = null; }
	const value = isRecord(parsed) ? parsed : {};
	const jobsSaved = typeof value.jobsSaved === "number" && Number.isSafeInteger(value.jobsSaved) && value.jobsSaved >= 0 ? value.jobsSaved : null;
	const status = typeof value.status === "string" && value.status.trim() ? value.status : null;
	return { path: target, content: change.after, jobsSaved, status };
}

export function settleRuntimeWorker(config: RuntimeSettleConfig): RuntimeSettlementEvidence {
	const result: unknown = JSON.parse(readFileSync(config.workerResultPath, "utf8"));
	if (!isRecord(result) || result.schemaVersion !== 2 || result.resultContract !== "runtime-v1") throw new Error("runtime settlement requires a schema 2 runtime-v1 worker result");
	if (result.attemptKey !== config.attemptKey) throw new Error("worker result attempt does not match the settling attempt");
	const output = isRecord(result.output) ? result.output : null;
	const capture = output && isRecord(output.capture) ? output.capture : null;
	if (!output || !capture || typeof result.outputDir !== "string") throw new Error("worker result lacks runtime output");
	const outcome = parseRuntimeOutcome(output.outcome);
	const content = new RuntimeContentStore(config.dbPath ?? process.env.DELEGATE_GRAPH_DB ?? DEFAULT_DB_PATH);
	const diagnostics = Array.isArray(capture.diagnostics) ? capture.diagnostics.filter((item): item is string => typeof item === "string") : [];
	const answerBytes = readFileSync(join(result.outputDir, "public-answer.txt"));
	const answer = answerBytes.length ? content.retain(answerBytes) : null;
	let manifest: RuntimeContent | null = null;
	let files: readonly RuntimeContent[] = [];
	let checkpoint: RuntimeCheckpoint | null = null;
	if (config.kind === "coding" || config.kind === "operational") {
		if (config.snapshotPath === null) throw new Error(`${config.kind} settlement requires an AgentFS snapshot`);
		const staged = stageRuntimeAgentFs({ agentFsExecutable: config.agentFsExecutable, snapshotPath: config.snapshotPath, baseDir: config.baseDir, baseRevision: config.baseRevision, attemptKey: config.attemptKey, ownedPaths: config.ownedPaths, readOnly: false }, content);
		manifest = staged.manifest; files = staged.files;
		if (config.kind === "operational" && config.checkpointPath) checkpoint = observeCheckpoint(content, staged.changes, config.baseDir, config.checkpointPath);
	}
	const observation = parseRuntimeObservation({
		sessionId: typeof capture.sessionId === "string" ? capture.sessionId : typeof output.sessionId === "string" ? output.sessionId : "",
		requestId: typeof capture.requestId === "string" ? capture.requestId : null,
		sessionOrigin: capture.sessionOrigin ?? null,
		captureStatus: capture.captureStatus,
		manifest,
	});
	const candidate: RuntimeCandidate | null = config.kind === "coding" && manifest
		? parseRuntimeCandidate({ kind: "coding", answer, artifacts: [manifest, ...files], baseRevision: config.baseRevision })
		: config.kind === "operational" && manifest && answer
			? parseRuntimeCandidate({ kind: "operational", answer, artifacts: [manifest, ...files], baseRevision: config.baseRevision, checkpoint })
			: config.kind === "research" && answer ? parseRuntimeCandidate({ kind: "research", answer, sources: [] }) : null;
	const evidence: RuntimeSettlementEvidence = { schemaVersion: 1, resultContract: "runtime-v1", attemptKey: config.attemptKey, outcome, candidate, observation, answer, stagedFiles: files.length, diagnostics };
	publishEvidence(config.evidencePath, evidence);
	return evidence;
}

/**
 * The evidence file either exists complete or not at all. It is written and fsynced under a private
 * temporary name, then linked into place exclusively, so a crash at any point leaves a replayable
 * absence rather than a truncated record; a retained answer or staged file is content-addressed and
 * simply re-retained on replay. An existing complete record for the same attempt is left untouched.
 */
function publishEvidence(evidencePath: string, evidence: RuntimeSettlementEvidence): void {
	const dir = dirname(evidencePath);
	const stalePrefix = `${basename(evidencePath)}.tmp-`;
	for (const entry of readdirSync(dir)) if (entry.startsWith(stalePrefix)) unlinkSync(join(dir, entry));
	const temporary = join(dir, `${stalePrefix}${process.pid}`);
	const fd = openSync(temporary, "wx", 0o600);
	try { writeFileSync(fd, JSON.stringify(evidence, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
	try {
		linkSync(temporary, evidencePath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		const existing: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
		if (!isRecord(existing) || existing.attemptKey !== evidence.attemptKey) throw new Error("a settlement record for another attempt already occupies the evidence path");
	} finally {
		unlinkSync(temporary);
	}
	chmodSync(evidencePath, 0o600);
	const directory = openSync(dir, "r");
	try { fsyncSync(directory); } finally { closeSync(directory); }
	if (!existsSync(evidencePath)) throw new Error("settlement evidence was not published");
}

function main(): void {
	const configPath = process.env.PI_RUNTIME_SETTLE_CONFIG;
	if (!configPath) throw new Error("PI_RUNTIME_SETTLE_CONFIG is required");
	const evidence = settleRuntimeWorker(parseRuntimeSettleConfig(JSON.parse(readFileSync(resolve(configPath), "utf8"))));
	process.stdout.write(JSON.stringify({ action: "runtime_settled", attemptKey: evidence.attemptKey, outcome: evidence.outcome.kind, candidate: evidence.candidate?.kind ?? null, captureStatus: evidence.observation.captureStatus }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
