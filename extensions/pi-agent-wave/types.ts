export const OPERATION_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"blocked",
	"cancelled",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];
export type GraphKind = "build" | "research" | "operations";

/** Friendly human-readable presets that map to concrete tiers in the shared resolver. */
export type PolicyPreset = "cheap" | "balanced" | "strong" | "local" | "long-context";

/**
 * The tagged union a user/supervisor supplies to select one run's model policy.
 * `auto` applies each role's configured default; an exact `model` lock never falls back.
 */
export type ModelPolicyInput =
	| { kind: "auto" }
	| { kind: "preset"; preset: PolicyPreset }
	| { kind: "tier"; tier: string }
	| { kind: "model"; model: string; reason: string };

/** One graph role's resolved, capability-floor-promoted route before dispatch. */
export interface PolicyRoute {
	role: string;
	tier: string;
	chain: string[];
	thinking: string;
	session: boolean;
	capabilityFloor: string;
	selectionSource: string;
	promoted: boolean;
	promotedFrom?: string;
	promotionReason: string | null;
}

/** Immutable canonical resolved policy snapshot frozen at run initialization. */
export interface ResolvedPolicy {
	input: ModelPolicyInput;
	routes: PolicyRoute[];
}

/** The frozen policy as persisted with a run: canonical snapshot plus its digest. */
export interface FrozenPolicy {
	input: ModelPolicyInput;
	routes: PolicyRoute[];
	digest: string;
}

export type RunStatus = "active" | "terminal" | "blocked" | "awaiting_user" | "deferred" | "cancelled";
export type NodeName =
	| "thinker_plan"
	| "implement"
	| "review"
	| "test"
	| "audit"
	| "thinker_split"
	| "search"
	| "source_search"
	| "thinker_synthesize"
	| "terminal";

/** Exact process boundary for an operational worker; never render this as interpolated shell text. */
export interface OperationalCommand {
	executable: string;
	args: string[];
	cwd: string;
	/** Persisted with the command when the spec declares a checkpoint file; passed to the launcher unchanged. */
	checkpoint?: string;
}

/** One independently owned command dispatched by an operational-search graph. */
export interface OperationalCommandSpec {
	id: string;
	name: string;
	command: OperationalCommand;
	ownedPaths: string[];
	/** Checkpoint file the source script writes, relative to the command cwd (or absolute), under one of the owned paths. */
	checkpoint?: string;
}

export interface SliceSpec {
	id: string;
	name: string;
	task: string;
	ownedPaths?: string[];
	readOnly?: boolean;
}

export interface GraphNodeDefinition {
	name: NodeName;
	role: "thinker" | "implementer" | "reviewer" | "tester" | "auditor" | "searcher";
	fanOut: boolean;
	readOnly: boolean;
}

export interface GraphDefinition {
	name: GraphKind;
	initialNode: NodeName;
	nodes: GraphNodeDefinition[];
}

export interface RunState {
	runId: string;
	graph: GraphKind;
	currentNode: NodeName;
	round: number;
	fixIteration: number;
	status: RunStatus;
}

export interface TransitionInput extends RunState {
	verdict?: string;
	allComplete: boolean;
}

export interface TransitionDecision {
	kind: "stay" | "advance" | "terminal" | "blocked";
	nextNode: NodeName;
	round: number;
	fixIteration: number;
	replyTo: string;
	reason: string;
}

export interface RunRow {
	id: string;
	story: string;
	graph_name: GraphKind;
	task: string;
	status: RunStatus;
	policy_json: string;
	policy_digest: string;
	created_at: string;
	updated_at: string;
	/** A home run's working directory (`$HOME` or under it); null for every repository run. */
	workspace_root: string | null;
}

export interface StateRow {
	run_id: string;
	current_node: NodeName;
	round: number;
	fix_iteration: number;
	status: RunStatus;
	updated_at: string;
}

export interface OperationRow {
	id: string;
	run_id: string;
	node: NodeName;
	slice_id: string | null;
	agent_id: string | null;
	status: OperationStatus;
	read_only: number;
	owned_paths_json: string;
	round: number;
	fix_iteration: number;
	transient_attempts: number;
	model_attempt: number;
	selected_model: string | null;
	command_json: string | null;
	task: string;
	verdict: string | null;
	classifier_reason: string | null;
	retry_reason: string | null;
	fallback_reason: string | null;
	last_error: string | null;
	retry_not_before: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}

export interface EventRow {
	id: number;
	ts: string;
	run_id: string;
	operation_id: string | null;
	agent_id: string | null;
	type: string;
	node: NodeName | null;
	from_agent: string | null;
	to_agent: string | null;
	reply_to: string | null;
	from_node: NodeName | null;
	to_node: NodeName | null;
	verdict: string | null;
	payload_json: string;
}

export const LEDGER_OUTCOMES = ["accepted", "blocked", "failed"] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/**
 * A claim's evidence state, stored as a state rather than written as prose. `unverified` and
 * `unverified-recall` are the byte-exact markers the supervisor rules require, so a claim that rests
 * on memory or inference cannot be reported as though it had been checked.
 */
export const LEDGER_CLAIM_STATUSES = ["verified", "unverified", "unverified-recall"] as const;
export type LedgerClaimStatus = (typeof LEDGER_CLAIM_STATUSES)[number];

export interface LedgerClaimRow {
	position: number;
	claim: string;
	evidence: string;
	status: LedgerClaimStatus;
}

/**
 * `percentage` is stored as the caller supplied it, not derived: an audit that recomputes it is only
 * meaningful if a recorded figure can disagree with its own components.
 */
export interface LedgerAggregateRow {
	position: number;
	name: string;
	numerator: number;
	denominator: number;
	percentage: number;
}

export interface LedgerEntryRow {
	id: string;
	story: string;
	sequence: number;
	topic: string;
	runId: string;
	tier: string;
	model: string;
	outcome: LedgerOutcome;
	dispatchedAt: string;
	task: string;
	claims: LedgerClaimRow[];
	aggregates: LedgerAggregateRow[];
}

export interface LedgerFinding {
	entry: string;
	code: "LEDGER_EMPTY" | "SEQUENCE_GAP" | "AGGREGATE_INVALID" | "AGGREGATE_MISMATCH";
	message: string;
}

export interface StoryLedgerAudit {
	story: string;
	entries: number;
	valid: boolean;
	findings: LedgerFinding[];
}

export interface LedgerEntryInput {
	story: string;
	topic: string;
	runId: string;
	tier: string;
	model: string;
	outcome: LedgerOutcome;
	task: string;
	dispatchedAt?: string;
	claims?: readonly { claim: string; evidence: string; status: LedgerClaimStatus }[];
	aggregates?: readonly { name: string; numerator: number; denominator: number; percentage: number }[];
}
