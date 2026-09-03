export const WORKER_TRANSPORT_KINDS: readonly ["headless", "herdr"] = Object.freeze(["headless", "herdr"]);
export type WorkerTransportKind = (typeof WORKER_TRANSPORT_KINDS)[number];

export type WorkerPresentationIdentity =
	| Readonly<{ kind: "headless"; agent?: never; tabId?: never; paneId?: never }>
	| Readonly<{ kind: "herdr"; agent: string; tabId: string; paneId: string }>;

export interface WorkerAttemptIdentityInput {
	runId: string;
	operationId: string;
	role: string;
	modelAttempt: number;
	transientAttempt: number;
	acpAgent: "pi" | "codex" | "claude";
	acpxSessionId: string;
	acpxRecordId: string;
	acpxAttemptKey: string;
	agentFsSessionId: string;
	agentFsDbPath: string;
}

export type WorkerAttemptIdentity = Readonly<WorkerAttemptIdentityInput>;

export interface WorkerLaunchRequest {
	identity: WorkerAttemptIdentity;
	taskFile: string;
	reportPath: string;
	readOnly: boolean;
	ownedPaths: readonly string[];
}

export interface WorkerHandle {
	identity: WorkerAttemptIdentity;
	presentation: WorkerPresentationIdentity;
}

export interface WorkerSettlement {
	identity: WorkerAttemptIdentity;
	verdict: string;
	reportPath: string;
	settlementEvidencePath: string;
	cleanupEvidencePath: string;
}

export interface WorkerProgressEvent {
	identity: WorkerAttemptIdentity;
	kind: "started" | "progress" | "awaiting_user" | "retrying" | "cancelled" | "failed" | "completed";
	detail: string;
}

export interface WorkerTransportPort {
	readonly kind: WorkerTransportKind;
	launch(request: WorkerLaunchRequest): Promise<WorkerHandle>;
	wait(handle: WorkerHandle): Promise<WorkerSettlement>;
	cancel(handle: WorkerHandle): Promise<void>;
	cleanup(handle: WorkerHandle): Promise<void>;
	observeProgress(handle: WorkerHandle, listener: (event: WorkerProgressEvent) => void): Promise<void>;
	focus?(handle: WorkerHandle): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
	return value.trim();
}

function requiredAttempt(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

export function parseWorkerTransportKind(value: unknown): WorkerTransportKind {
	if (value === "headless" || value === "herdr") return value;
	throw new Error(`unsupported worker transport: ${String(value)}`);
}

export function headlessPresentationIdentity(): WorkerPresentationIdentity {
	return Object.freeze({ kind: "headless" });
}

export function herdrPresentationIdentity(agent: string, tabId: string, paneId: string): WorkerPresentationIdentity {
	return Object.freeze({ kind: "herdr", agent: requiredString(agent, "Herdr agent"), tabId: requiredString(tabId, "Herdr tab"), paneId: requiredString(paneId, "Herdr pane") });
}

export function parseWorkerPresentationIdentity(value: unknown): WorkerPresentationIdentity {
	if (!record(value)) throw new Error("worker presentation identity must be an object");
	if (value.kind === "headless") {
		if (Object.keys(value).length !== 1) throw new Error("headless presentation identity cannot contain Herdr fields");
		return headlessPresentationIdentity();
	}
	if (value.kind === "herdr") {
		if (Object.keys(value).some((key) => !["kind", "agent", "tabId", "paneId"].includes(key))) throw new Error("Herdr presentation identity contains unsupported fields");
		return herdrPresentationIdentity(requiredString(value.agent, "Herdr agent"), requiredString(value.tabId, "Herdr tab"), requiredString(value.paneId, "Herdr pane"));
	}
	throw new Error(`unsupported presentation identity: ${String(value.kind)}`);
}

export function presentationIdentityEquals(left: WorkerPresentationIdentity, right: WorkerPresentationIdentity): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "headless" || right.kind === "headless") return left.kind === right.kind;
	return left.agent === right.agent && left.tabId === right.tabId && left.paneId === right.paneId;
}

export function workerAttemptIdentity(input: WorkerAttemptIdentityInput): WorkerAttemptIdentity {
	const acpAgent = input.acpAgent;
	if (acpAgent !== "pi" && acpAgent !== "codex" && acpAgent !== "claude") throw new Error(`unsupported ACP agent: ${String(acpAgent)}`);
	return Object.freeze({
		runId: requiredString(input.runId, "runId"),
		operationId: requiredString(input.operationId, "operationId"),
		role: requiredString(input.role, "role"),
		modelAttempt: requiredAttempt(input.modelAttempt, "modelAttempt"),
		transientAttempt: requiredAttempt(input.transientAttempt, "transientAttempt"),
		acpAgent,
		acpxSessionId: requiredString(input.acpxSessionId, "acpxSessionId"),
		acpxRecordId: requiredString(input.acpxRecordId, "acpxRecordId"),
		acpxAttemptKey: requiredString(input.acpxAttemptKey, "acpxAttemptKey"),
		agentFsSessionId: requiredString(input.agentFsSessionId, "agentFsSessionId"),
		agentFsDbPath: requiredString(input.agentFsDbPath, "agentFsDbPath"),
	});
}
