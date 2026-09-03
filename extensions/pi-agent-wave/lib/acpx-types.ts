import { createHash } from "node:crypto";
import { headlessPresentationIdentity, herdrPresentationIdentity, parseWorkerPresentationIdentity, type WorkerPresentationIdentity } from "./worker-transport.ts";

/** Finite delegation-context Value Object for the supported ACPX agent adapters. */
export const ACPX_AGENTS: readonly ["pi", "codex", "claude"] = Object.freeze(["pi", "codex", "claude"]);
export type AcpAgent = (typeof ACPX_AGENTS)[number];

/** Tested ACPX client/runtime states; graph operation states are a separate type. */
export const ACPX_STATES: readonly ["idle", "alive", "no-session"] = Object.freeze(["idle", "alive", "no-session"]);
export type AcpxState = (typeof ACPX_STATES)[number];

interface AcpxAttemptCoordinates {
	runId: string;
	operationId: string;
	role: string;
	modelAttempt: number;
	transientAttempt: number;
	selectedModel: string;
	agent: AcpAgent;
}

export type AcpxAttemptIdentityInput = AcpxAttemptCoordinates & (
	| { presentation: WorkerPresentationIdentity; herdrAgent?: never; herdrTabId?: never; herdrPaneId?: never }
	| { presentation?: never; herdrAgent: string; herdrTabId: string; herdrPaneId: string }
);

/** Immutable identity Value Object for one graph operation dispatch attempt. */
export interface AcpxAttemptIdentity extends Readonly<AcpxAttemptCoordinates> {
	readonly presentation: WorkerPresentationIdentity;
	readonly herdrAgent: string | null;
	readonly herdrTabId: string | null;
	readonly herdrPaneId: string | null;
	readonly attemptKey: string;
	readonly sessionName: string;
	readonly agentFsSession: string;
}

export function parseAcpAgent(value: unknown): AcpAgent {
	if (value === "pi" || value === "codex" || value === "claude") return value;
	throw new Error(`unsupported ACPX agent: ${String(value)}`);
}

export function parseAcpxState(value: unknown): AcpxState {
	if (value === "idle" || value === "alive" || value === "no-session") return value;
	throw new Error(`unsupported ACPX state: ${String(value)}`);
}

function required(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${name} is required`);
	return normalized;
}

function attempt(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "worker";
}

export function acpxAttemptKey(identity: AcpxAttemptCoordinates): string {
	return [identity.runId, identity.operationId, identity.role, identity.modelAttempt, identity.transientAttempt, identity.selectedModel, identity.agent].join(":");
}

/** Creates one stable session identity per operation/model/transient attempt. */
export function createAcpxAttemptIdentity(input: AcpxAttemptIdentityInput): AcpxAttemptIdentity {
	const presentation = input.presentation === undefined
		? herdrPresentationIdentity(input.herdrAgent, input.herdrTabId, input.herdrPaneId)
		: parseWorkerPresentationIdentity(input.presentation);
	const normalized: AcpxAttemptCoordinates = {
		runId: required(input.runId, "runId"),
		operationId: required(input.operationId, "operationId"),
		role: required(input.role, "role"),
		modelAttempt: attempt(input.modelAttempt, "modelAttempt"),
		transientAttempt: attempt(input.transientAttempt, "transientAttempt"),
		selectedModel: required(input.selectedModel, "selectedModel"),
		agent: parseAcpAgent(input.agent),
	};
	const attemptKey = acpxAttemptKey(normalized);
	const sessionCoordinates = [normalized.runId, normalized.operationId, normalized.modelAttempt, normalized.transientAttempt].join(":");
	const digest = createHash("sha256").update(sessionCoordinates).digest("hex").slice(0, 12);
	const sessionName = `dg-${slug(normalized.role)}-${normalized.modelAttempt}-${normalized.transientAttempt}-${digest}`;
	return Object.freeze({
		...normalized,
		presentation,
		herdrAgent: presentation.kind === "herdr" ? presentation.agent : null,
		herdrTabId: presentation.kind === "herdr" ? presentation.tabId : null,
		herdrPaneId: presentation.kind === "herdr" ? presentation.paneId : null,
		attemptKey,
		sessionName,
		agentFsSession: sessionName,
	});
}

export function createHeadlessAcpxAttemptIdentity(input: AcpxAttemptCoordinates): AcpxAttemptIdentity {
	return createAcpxAttemptIdentity({ ...input, presentation: headlessPresentationIdentity() });
}

export function sameAcpxAttempt(left: AcpxAttemptIdentity, right: AcpxAttemptIdentity): boolean {
	return left.attemptKey === right.attemptKey;
}
