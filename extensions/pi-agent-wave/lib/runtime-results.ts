import { createHash } from "node:crypto";
import type { AcpxAttemptIdentity } from "./acpx-types.ts";
import type { RuntimeSessionOrigin } from "./runtime-capture.ts";
import type { OperationRow, RunState } from "../types.ts";

/** The only result contract. `legacy-v1` (worker-authored JSON reports) was removed on 2026-09-12. */
export type ResultContract = "runtime-v1";

export function parseResultContract(value: unknown): ResultContract {
	if (value === undefined || value === "runtime-v1") return "runtime-v1";
	if (value === "legacy-v1") throw new Error("legacy-v1 was removed on 2026-09-12; every run uses runtime-v1");
	throw new Error(`unsupported result contract: ${String(value)}`);
}

export interface RuntimeContent {
	readonly sha256: string;
	readonly bytes: number;
}

/** Facts read from the checkpoint file the source script itself wrote inside the overlay; never from the worker's prose. */
export interface RuntimeCheckpoint {
	readonly path: string;
	readonly content: RuntimeContent;
	readonly jobsSaved: number | null;
	readonly status: string | null;
}

export type RuntimeCandidate =
	| { readonly kind: "coding"; readonly answer: RuntimeContent | null; readonly artifacts: readonly RuntimeContent[]; readonly baseRevision: string }
	| { readonly kind: "research"; readonly answer: RuntimeContent; readonly sources: readonly RuntimeContent[] }
	| { readonly kind: "operational"; readonly answer: RuntimeContent; readonly artifacts: readonly RuntimeContent[]; readonly baseRevision: string; readonly checkpoint: RuntimeCheckpoint | null };

export type RuntimeOutcome =
	| { readonly kind: "exited"; readonly exitCode: number }
	| { readonly kind: "failed"; readonly exitCode: number | null; readonly error: string }
	| { readonly kind: "cancelled"; readonly signal: string | null }
	| { readonly kind: "interrupted"; readonly reason: string };

export interface RuntimeAttemptInput {
	readonly identity: AcpxAttemptIdentity;
	/** The acpx session name ensured for the attempt; the ACP session id is observed at settlement. */
	readonly sessionId: string;
	/** Null until the prompt binds inside the worker stream (2026-09-12 adapter evidence). */
	readonly requestId: string | null;
	readonly policyDigest: string;
	/** Registered worker agent row; excluded from attempt identity so a lost acknowledgement can re-register. */
	readonly agentId?: string;
}

/** What the exclusive prompt process actually observed; recorded, never inferred. */
export interface RuntimeObservation {
	readonly sessionId: string;
	readonly requestId: string | null;
	readonly sessionOrigin: RuntimeSessionOrigin | null;
	readonly captureStatus: "complete" | "incomplete" | "empty";
	/** Staging manifest retained among a coding candidate's artifacts, when one was produced. */
	readonly manifest: RuntimeContent | null;
}

export interface RuntimeSettlementInput {
	readonly attemptKey: string;
	readonly outcome: RuntimeOutcome;
	readonly candidate?: RuntimeCandidate;
	readonly observation?: RuntimeObservation;
}

export type RuntimeDecisionKind = "accepted" | "rejected";

export interface RuntimeDecision {
	readonly decision: RuntimeDecisionKind;
	readonly reason: string;
	readonly verdict: string | null;
	readonly integrationId: string | null;
	readonly decidedAt: string;
}

export interface RuntimeDecisionInput {
	readonly attemptKey: string;
	readonly decision: RuntimeDecisionKind;
	readonly reason: string;
	/** Verdict for review/test nodes, read by the caller from the candidate answer. */
	readonly verdict?: string;
	/** Graph payload such as planned slices, exactly as legacy completion accepts it. */
	readonly payload?: Record<string, unknown>;
}

export interface RuntimeAttempt {
	readonly attemptKey: string;
	readonly runId: string;
	readonly operationId: string;
	readonly agentId: string | null;
	readonly processState: "running" | RuntimeOutcome["kind"];
	readonly outcome: RuntimeOutcome | null;
	readonly candidate: RuntimeCandidate | null;
	readonly candidateId: string | null;
	readonly observation: RuntimeObservation | null;
	readonly decision: RuntimeDecision | null;
	readonly cleanup: "pending";
	readonly acceptance: "pending" | "accepted" | "rejected" | "unavailable";
	readonly startedAt: string;
	readonly finishedAt: string | null;
	/** Set when a fenced replacement attempt superseded this one; the row stays immutable and readable. */
	readonly supersededAt: string | null;
}

/** Derived read-only view of a runtime-v1 run; never an input to any gate. */
export interface RuntimeLedger {
	readonly schemaVersion: 1;
	readonly derived: true;
	readonly derivedAt: string;
	readonly runId: string;
	readonly story: string;
	readonly graph: string;
	readonly task: string;
	readonly resultContract: "runtime-v1";
	readonly status: string;
	readonly currentNode: string;
	readonly round: number;
	readonly fixIteration: number;
	readonly policyDigest: string;
	readonly operations: readonly RuntimeLedgerOperation[];
	readonly events: readonly { readonly id: number; readonly ts: string; readonly type: string; readonly node: string | null; readonly operationId: string | null; readonly agentId: string | null; readonly verdict: string | null; readonly payload: unknown }[];
}

export interface RuntimeLedgerOperation {
	readonly operationId: string;
	readonly node: string;
	readonly round: number;
	readonly fixIteration: number;
	readonly status: string;
	readonly modelAttempt: number;
	readonly transientAttempts: number;
	readonly selectedModel: string | null;
	readonly classifierReason: string | null;
	readonly retryReason: string | null;
	readonly fallbackReason: string | null;
	readonly lastError: string | null;
	readonly retryNotBefore: string | null;
	readonly attempts: readonly {
		readonly attemptKey: string; readonly modelAttempt: number | null; readonly transientAttempt: number | null; readonly selectedModel: string | null; readonly agent: string | null;
		readonly agentId: string | null; readonly startedAt: string; readonly finishedAt: string | null; readonly supersededAt: string | null;
		readonly processState: RuntimeAttempt["processState"]; readonly outcome: RuntimeOutcome | null; readonly candidateId: string | null; readonly candidateKind: RuntimeCandidate["kind"] | null; readonly checkpoint: RuntimeCheckpoint | null;
		readonly contents: readonly { readonly digest: string; readonly bytes: number }[];
		readonly observation: RuntimeObservation | null; readonly acceptance: RuntimeAttempt["acceptance"]; readonly decision: RuntimeDecision | null;
	}[];
}

export interface RuntimeRetryInput {
	readonly runId: string;
	readonly operationId: string;
	/** Launch or preflight failure text for an operation with no active attempt; refused when an attempt exists. */
	readonly error?: string;
	/** The counters the failed launch was dispatched with; a launch failure is fenced to exactly that identity. */
	readonly launched?: { readonly modelAttempt: number; readonly transientAttempt: number };
	readonly retryReason?: string;
	/** Operator-approved retry from awaiting_user; resets the same-model budget without classifying. */
	readonly approved?: boolean;
}

export interface RuntimeRetryResult {
	readonly state: RunState;
	readonly operation: OperationRow;
	readonly previousAttempt: RuntimeAttempt | null;
	readonly classification: string | null;
	/** Present when a replacement attempt may be dispatched; null when the run parked awaiting the user. */
	readonly retry: { readonly attempt: number; readonly modelAttempt: number; readonly selectedModel: string; readonly delayMs: number; readonly notBefore: string } | null;
	readonly exhausted: boolean;
}

export function runtimeDigest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("invalid runtime result object");
	return value;
}

function nonempty(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("runtime result requires nonempty text");
	return value;
}

function exitCode(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid runtime exit code");
	return value;
}

export function parseRuntimeOutcome(value: unknown): RuntimeOutcome {
	const input = record(value);
	if (input.kind === "exited") return { kind: input.kind, exitCode: exitCode(input.exitCode) };
	if (input.kind === "failed") return { kind: input.kind, exitCode: input.exitCode === null ? null : exitCode(input.exitCode), error: nonempty(input.error) };
	if (input.kind === "cancelled") return { kind: input.kind, signal: input.signal === null ? null : nonempty(input.signal) };
	if (input.kind === "interrupted") return { kind: input.kind, reason: nonempty(input.reason) };
	throw new Error("invalid runtime outcome");
}

export function parseRuntimeContent(value: unknown): RuntimeContent {
	const input = record(value);
	if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("invalid runtime content digest");
	return { sha256: input.sha256, bytes: exitCode(input.bytes) };
}

function contents(value: unknown): RuntimeContent[] {
	if (!Array.isArray(value)) throw new Error("invalid runtime content references");
	return value.map(parseRuntimeContent);
}

export function parseRuntimeCandidate(value: unknown): RuntimeCandidate {
	const input = record(value);
	if (input.kind === "coding") {
		const answer = input.answer === null ? null : parseRuntimeContent(input.answer);
		const artifacts = contents(input.artifacts);
		if (!answer?.bytes && !artifacts.some((artifact) => artifact.bytes > 0)) throw new Error("empty coding candidate");
		return { kind: input.kind, answer, artifacts, baseRevision: nonempty(input.baseRevision) };
	}
	if (input.kind === "research") {
		const answer = parseRuntimeContent(input.answer);
		if (answer.bytes === 0) throw new Error("empty research candidate");
		return { kind: input.kind, answer, sources: contents(input.sources) };
	}
	if (input.kind === "operational") {
		const answer = parseRuntimeContent(input.answer);
		if (answer.bytes === 0) throw new Error("empty operational candidate");
		return { kind: input.kind, answer, artifacts: contents(input.artifacts), baseRevision: nonempty(input.baseRevision), checkpoint: input.checkpoint === null || input.checkpoint === undefined ? null : parseRuntimeCheckpoint(input.checkpoint) };
	}
	throw new Error("invalid runtime candidate kind");
}

export function parseRuntimeCheckpoint(value: unknown): RuntimeCheckpoint {
	const input = record(value);
	if (input.jobsSaved !== null && (typeof input.jobsSaved !== "number" || !Number.isSafeInteger(input.jobsSaved) || input.jobsSaved < 0)) throw new Error("invalid checkpoint jobsSaved");
	if (input.status !== null && (typeof input.status !== "string" || !input.status.trim())) throw new Error("invalid checkpoint status");
	return { path: nonempty(input.path), content: parseRuntimeContent(input.content), jobsSaved: input.jobsSaved as number | null, status: input.status as string | null };
}

export function candidateContents(candidate: RuntimeCandidate): readonly RuntimeContent[] {
	return candidate.kind === "research" ? [candidate.answer, ...candidate.sources]
		: [...(candidate.answer ? [candidate.answer] : []), ...candidate.artifacts];
}

export function parseRuntimeObservation(value: unknown): RuntimeObservation {
	const input = record(value);
	const origin = input.sessionOrigin;
	if (origin !== null && origin !== "expected" && origin !== "loaded" && origin !== "created" && origin !== "resumed") throw new Error("invalid runtime session origin");
	const status = input.captureStatus;
	if (status !== "complete" && status !== "incomplete" && status !== "empty") throw new Error("invalid runtime capture status");
	if (input.requestId !== null && typeof input.requestId !== "string") throw new Error("invalid runtime request id");
	return { sessionId: nonempty(input.sessionId), requestId: input.requestId, sessionOrigin: origin, captureStatus: status, manifest: input.manifest === null || input.manifest === undefined ? null : parseRuntimeContent(input.manifest) };
}

export function parseRuntimeDecisionKind(value: unknown): RuntimeDecisionKind {
	if (value === "accepted" || value === "rejected") return value;
	throw new Error(`unsupported runtime decision: ${String(value)}`);
}
