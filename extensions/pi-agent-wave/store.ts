import { Database } from "./sqlite.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { decideTransition, graphDefinition } from "./graph-core.ts";
import { classifyFailure, retryDelayMs, selectModelFallback, type ModelFallbackDecision } from "./retry.ts";
import { parseAcpAgent, parseAcpxState, type AcpAgent, type AcpxState } from "./lib/acpx-types.ts";
import { headlessPresentationIdentity, herdrPresentationIdentity, parseWorkerTransportKind, type WorkerPresentationIdentity, type WorkerTransportKind } from "./lib/worker-transport.ts";
import { createAcpxAttemptIdentity } from "./lib/acpx-types.ts";
import { selectAcpAgent } from "./lib/acpx-select.ts";
import { RuntimeContentStore } from "./lib/runtime-content.ts";
import { RuntimeIntegration, type IntegrationStatus } from "./lib/runtime-integration.ts";
import { parseRuntimeStagingManifest } from "./lib/runtime-staging.ts";
import { canonical, candidateContents, type RuntimeLedger, parseRuntimeCandidate, parseRuntimeDecisionKind, parseRuntimeObservation, parseRuntimeOutcome, runtimeDigest, type ResultContract, type RuntimeAttempt, type RuntimeAttemptInput, type RuntimeContent, type RuntimeDecision, type RuntimeDecisionInput, type RuntimeRetryInput, type RuntimeRetryResult, type RuntimeSettlementInput } from "./lib/runtime-results.ts";
import type {
	EventRow,
	FrozenPolicy,
	GraphKind,
	ModelPolicyInput,
	NodeName,
	OperationRow,
	OperationStatus,
	OperationalCommand,
	OperationalCommandSpec,
	PolicyRoute,
	ResolvedPolicy,
	RunRow,
	RunState,
	RunStatus,
	SliceSpec,
	StateRow,
} from "./types.ts";

export const DEFAULT_GRAPH_HOME = join(homedir(), ".cache", "delegate-graph");
export const DEFAULT_DB_PATH = join(DEFAULT_GRAPH_HOME, "delegate-graph.db");

export interface StoreOptions {
	dbPath?: string;
	now?: () => Date;
	random?: () => number;
}

export type VisibleTransport = WorkerTransportKind;

export interface RecordOperationInput {
	runId: string;
	operationId: string;
	status: OperationStatus;
	verdict?: string;
	error?: string;
	agentId?: string;
	agentName?: string;
	transport?: VisibleTransport;
	modelPolicy?: ModelPolicyInput;
	policyDigest?: string;
	selectedModel?: string;
	modelAttempt?: number;
	retryReason?: string;
	fallbackReason?: string;
	payload?: Record<string, unknown>;
}

export interface RecordOperationResult {
	state: RunState;
	operation: OperationRow;
	retry?: { attempt: number; modelAttempt: number; selectedModel: string | null; delayMs: number; notBefore: string };
	requiresUserDecision?: boolean;
}

export interface AgentRegistration {
	id?: string;
	runId: string;
	name: string;
	node: NodeName;
	role: string;
	transport: VisibleTransport;
	herdrAgent?: string;
	tabId?: string;
	policyDigest?: string;
	selectedModel?: string;
	modelAttempt?: number;
	acpAgent?: AcpAgent;
	acpxRecordId?: string;
	acpxSessionId?: string;
	acpxState?: AcpxState;
	acpxAttemptKey?: string;
	agentFsSessionId?: string;
	agentFsDbPath?: string;
	herdrPaneId?: string;
	acpxCancelScript?: string;
	currentTask: string;
}

interface AgentDbRow {
	id: string;
	run_id: string;
	name: string;
	node: NodeName;
	role: string;
	transport: string;
	herdr_agent: string | null;
	tab_id: string | null;
	policy_digest: string | null;
	selected_model: string | null;
	model_attempt: number;
	acp_agent: string | null;
	acpx_record_id: string | null;
	acpx_session_id: string | null;
	acpx_state: string | null;
	acpx_attempt_key: string | null;
	agentfs_session_id: string | null;
	agentfs_db_path: string | null;
	herdr_pane_id: string | null;
	acpx_cancel_script: string | null;
	status: OperationStatus;
	current_task: string;
	created_at: string;
	last_activity_at: string;
}

export interface AgentRow extends AgentDbRow {
	transport: WorkerTransportKind;
	presentation_identity: WorkerPresentationIdentity | null;
}

interface CountRow {
	count: number;
}

interface RuntimeAttemptRow {
	attempt_key: string;
	run_id: string;
	operation_id: string;
	identity_json: string;
	outcome_json: string | null;
	candidate_json: string | null;
	candidate_id: string | null;
	observation_json: string | null;
	agent_id: string | null;
	started_at: string;
	finished_at: string | null;
	superseded_at: string | null;
}

interface RuntimeDecisionRow {
	attempt_key: string;
	candidate_id: string;
	decision: string;
	verdict: string | null;
	reason: string;
	integration_id: string | null;
	payload_json: string | null;
	decided_at: string;
}

export interface RuntimeDecisionResult {
	readonly attempt: RuntimeAttempt;
	readonly state: RunState;
	readonly operation: OperationRow;
}

interface SliceRow {
	slice_id: string | null;
	task: string;
	owned_paths_json: string;
}

function graphHash(definition: object): string {
	return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

/** Canonical, key-sorted serialization so equal policies always hash identically. */
function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function policyDigest(policy: ResolvedPolicy): string {
	return createHash("sha256").update(stableStringify(policy)).digest("hex");
}

/** The default auto policy persisted when a run initializes without an explicitly resolved one. */
export const DEFAULT_AUTO_POLICY: ResolvedPolicy = { input: { kind: "auto" }, routes: [] };

function ensurePrivatePath(dbPath: string): void {
	mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	chmodSync(dirname(dbPath), 0o700);
}

function nodeIsReadOnly(node: NodeName): boolean {
	return node !== "implement" && node !== "source_search";
}

export function roleForNode(node: NodeName): string {
	if (node.startsWith("thinker")) return "thinker";
	if (node === "implement") return "implementer";
	if (node === "review") return "reviewer";
	if (node === "test") return "tester";
	if (node === "audit") return "auditor";
	if (node === "search" || node === "source_search") return "searcher";
	return "supervisor";
}

function canonicalWritablePath(path: string): string {
	let current = resolve(path);
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missing.unshift(basename(current));
		current = parent;
	}
	const physical = existsSync(current) ? realpathSync(current) : current;
	return resolve(physical, ...missing);
}

function assertDisjointOwnership(slices: Array<{ id: string; ownedPaths?: string[] }>, label = "implementation slice"): void {
	const owners = new Map<string, string>();
	for (const slice of slices) {
		if (!slice.ownedPaths?.length) throw new Error(`${label} ${slice.id} requires ownedPaths`);
		for (const path of slice.ownedPaths) {
			const physical = canonicalWritablePath(path);
			for (const [owned, previous] of owners) {
				const candidateWithinOwned = relative(owned, physical);
				const ownedWithinCandidate = relative(physical, owned);
				if ((!candidateWithinOwned.startsWith("..") && candidateWithinOwned !== "") || (!ownedWithinCandidate.startsWith("..") && ownedWithinCandidate !== "") || owned === physical) {
					throw new Error(`writable path ${path} is owned by both ${previous} and ${slice.id}`);
				}
			}
			owners.set(physical, slice.id);
		}
	}
}

function validateOperationalCommands(commands: OperationalCommandSpec[] | undefined): OperationalCommandSpec[] {
	if (!commands?.length) throw new Error("operations graph requires at least one structured command");
	for (const item of commands) {
		if (!item.id?.trim() || !item.name?.trim()) throw new Error("operational command requires id and name");
		const command = item.command as OperationalCommand | undefined;
		if (!command?.executable?.trim() || !command.cwd?.trim() || !Array.isArray(command.args) || command.args.some((value) => typeof value !== "string")) {
			throw new Error(`operational command ${item.id} requires executable, argv, and cwd`);
		}
		if (item.checkpoint !== undefined) {
			if (typeof item.checkpoint !== "string" || !item.checkpoint.trim()) throw new Error(`operational command ${item.id} checkpoint must be a path`);
			const checkpoint = resolve(command.cwd, item.checkpoint);
			const inside = item.ownedPaths?.some((owned) => { const root = resolve(command.cwd, owned); return checkpoint === root || checkpoint.startsWith(`${root}/`); });
			if (!inside) throw new Error(`operational command ${item.id} checkpoint must lie under one of its owned paths`);
		}
	}
	assertDisjointOwnership(commands, "operational command");
	return commands;
}

function slicesFromPayload(payload: Record<string, unknown> | undefined): SliceSpec[] {
	const candidate = payload?.slices;
	if (!Array.isArray(candidate) || candidate.length === 0) {
		throw new Error("thinker result must include at least one slice");
	}
	return candidate.map((value, index) => {
		if (!value || typeof value !== "object") throw new Error(`slice ${index + 1} must be an object`);
		const slice = value as Partial<SliceSpec>;
		if (!slice.id || !slice.name || !slice.task) throw new Error(`slice ${index + 1} requires id, name, and task`);
		return {
			id: slice.id,
			name: slice.name,
			task: slice.task,
			ownedPaths: Array.isArray(slice.ownedPaths) ? slice.ownedPaths : undefined,
			readOnly: Boolean(slice.readOnly),
		};
	});
}

/** Owns the SQLite event stream and materialized state for every delegate graph run. */
export class GraphStore {
	readonly dbPath: string;
	private readonly db: Database;
	private readonly now: () => Date;
	private readonly random: () => number;

	constructor(options: StoreOptions = {}) {
		this.dbPath = options.dbPath ?? process.env.DELEGATE_GRAPH_DB ?? DEFAULT_DB_PATH;
		this.now = options.now ?? (() => new Date());
		this.random = options.random ?? Math.random;
		ensurePrivatePath(this.dbPath);
		this.db = new Database(this.dbPath, { create: true, strict: true });
		this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
		this.migrate();
		chmodSync(this.dbPath, 0o600);
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				story TEXT NOT NULL,
				graph_name TEXT NOT NULL CHECK(graph_name IN ('build','research','operations')),
				task TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active','terminal','blocked','awaiting_user','deferred','cancelled')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS graphs (
				run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				definition_json TEXT NOT NULL,
				sha256 TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS agents (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				node TEXT NOT NULL,
				role TEXT NOT NULL,
				transport TEXT NOT NULL,
				herdr_agent TEXT,
				tab_id TEXT,
				status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','blocked','cancelled')),
				current_task TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_activity_at TEXT NOT NULL,
				UNIQUE(run_id, name)
			);
			CREATE TABLE IF NOT EXISTS operations (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				node TEXT NOT NULL,
				slice_id TEXT,
				agent_id TEXT REFERENCES agents(id),
				status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','blocked','cancelled')),
				read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
				owned_paths_json TEXT NOT NULL DEFAULT '[]',
				round INTEGER NOT NULL,
				fix_iteration INTEGER NOT NULL,
				transient_attempts INTEGER NOT NULL DEFAULT 0,
				command_json TEXT,
				task TEXT NOT NULL,
				verdict TEXT,
				classifier_reason TEXT,
				last_error TEXT,
				retry_not_before TEXT,
				created_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT
			);
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts TEXT NOT NULL,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				operation_id TEXT REFERENCES operations(id),
				agent_id TEXT REFERENCES agents(id),
				type TEXT NOT NULL,
				node TEXT,
				from_agent TEXT,
				to_agent TEXT,
				reply_to TEXT,
				from_node TEXT,
				to_node TEXT,
				verdict TEXT,
				payload_json TEXT NOT NULL DEFAULT '{}'
			);
			CREATE TABLE IF NOT EXISTS state (
				run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
				current_node TEXT NOT NULL,
				round INTEGER NOT NULL,
				fix_iteration INTEGER NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active','terminal','blocked','awaiting_user','deferred','cancelled')),
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_operations_current ON operations(run_id, node, round, fix_iteration, status);
			CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events(run_id, ts, id);
			CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(run_id, status);
		`);
		const version = this.schemaVersion();
		if (version < 1) this.db.exec("INSERT INTO schema_version(version) VALUES (1)");
		// Always inspect columns so interrupted migrations repair idempotently.
		this.migrateToV2();
		this.migrateToV3();
		this.migrateToV4();
		this.migrateToV5();
		this.migrateToV6();
		this.migrateToV7();
		this.migrateToV8();
		this.migrateToV9();
		this.migrateToV10();
		this.migrateToV11();
	}

	private schemaVersion(): number {
		const row = this.db.query<{ version: number | null }, []>("SELECT MAX(version) AS version FROM schema_version").get();
		return row?.version ?? 0;
	}

	private hasColumn(table: "runs" | "agents" | "operations" | "runtime_attempts", column: string): boolean {
		return this.db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.some((row) => row.name === column);
	}

	private ensureColumn(table: "runs" | "agents" | "operations" | "runtime_attempts", column: string, definition: string): void {
		if (!this.hasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}

	/** v2 binds immutable policy state and model observability without replacing any v1 table. */
	private migrateToV2(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.ensureColumn("runs", "policy_json", "TEXT NOT NULL DEFAULT '{}'");
			this.ensureColumn("runs", "policy_digest", "TEXT NOT NULL DEFAULT ''");
			this.ensureColumn("operations", "model_attempt", "INTEGER NOT NULL DEFAULT 0");
			this.ensureColumn("operations", "selected_model", "TEXT");
			this.ensureColumn("operations", "retry_reason", "TEXT");
			this.ensureColumn("operations", "fallback_reason", "TEXT");
			this.ensureColumn("agents", "policy_digest", "TEXT");
			this.ensureColumn("agents", "selected_model", "TEXT");
			this.ensureColumn("agents", "model_attempt", "INTEGER NOT NULL DEFAULT 0");

			const legacyPolicy = stableStringify(DEFAULT_AUTO_POLICY);
			for (const run of this.db.query<{ id: string; policy_json: string; policy_digest: string }, []>("SELECT id,policy_json,policy_digest FROM runs").all()) {
				if (run.policy_digest) continue;
				let policy = legacyPolicy;
				if (run.policy_json && run.policy_json !== "{}") {
					const parsed = JSON.parse(run.policy_json) as ResolvedPolicy;
					this.assertPolicy(parsed);
					policy = stableStringify(parsed);
				}
				this.db.query("UPDATE runs SET policy_json=?, policy_digest=? WHERE id=?").run(
					policy,
					policyDigest(JSON.parse(policy) as ResolvedPolicy),
					run.id,
				);
			}
			this.db.exec("INSERT OR REPLACE INTO schema_version(version) VALUES (2)");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** v3 adds operational graphs and structured command persistence. */
	private migrateToV3(): void {
		const version = this.schemaVersion();
		if (version >= 3) return;
		if (!this.hasColumn("operations", "command_json")) this.db.exec("ALTER TABLE operations ADD COLUMN command_json TEXT");
		this.db.exec("PRAGMA foreign_keys = OFF");
		try {
			this.db.exec("BEGIN IMMEDIATE");
			this.db.exec(`
				CREATE TABLE runs_v3 (
					id TEXT PRIMARY KEY,
					story TEXT NOT NULL,
					graph_name TEXT NOT NULL CHECK(graph_name IN ('build','research','operations')),
					task TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active','terminal','blocked','awaiting_user','deferred','cancelled')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					policy_json TEXT NOT NULL DEFAULT '{}',
					policy_digest TEXT NOT NULL DEFAULT ''
				);
				INSERT INTO runs_v3 SELECT id, story, graph_name, task, status, created_at, updated_at, policy_json, policy_digest FROM runs;
				DROP TABLE runs;
				ALTER TABLE runs_v3 RENAME TO runs;
				INSERT OR REPLACE INTO schema_version(version) VALUES (3);
				COMMIT;
			`);
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// The failing statement may already have ended the transaction.
			}
			throw error;
		} finally {
			this.db.exec("PRAGMA foreign_keys = ON");
		}
		const foreignKeyFinding = this.db.query("PRAGMA foreign_key_check").get();
		if (foreignKeyFinding) throw new Error("v3 migration produced a foreign-key violation");
	}

	/** v4 adds nullable ACPX provenance while preserving legacy v1-v3 agents. */
	private migrateToV4(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.ensureColumn("agents", "acp_agent", "TEXT");
			this.ensureColumn("agents", "acpx_record_id", "TEXT");
			this.ensureColumn("agents", "acpx_session_id", "TEXT");
			this.ensureColumn("agents", "acpx_state", "TEXT");
			this.ensureColumn("agents", "acpx_attempt_key", "TEXT");
			this.ensureColumn("agents", "agentfs_session_id", "TEXT");
			this.ensureColumn("agents", "agentfs_db_path", "TEXT");
			this.ensureColumn("agents", "herdr_pane_id", "TEXT");
			this.ensureColumn("agents", "acpx_cancel_script", "TEXT");
			const identityColumns = "acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,acpx_cancel_script";
			const inconsistent = this.db.query<CountRow, []>(`SELECT COUNT(*) AS count FROM agents WHERE (${identityColumns.replaceAll(",", " IS NOT NULL OR ")} IS NOT NULL) AND NOT (${identityColumns.replaceAll(",", " IS NOT NULL AND ")} IS NOT NULL)`).get()?.count ?? 0;
			if (inconsistent) throw new Error("agents table contains inconsistent partial ACPX/AgentFS identity");
			this.db.exec(`
				CREATE TRIGGER IF NOT EXISTS agents_acpx_identity_insert
				BEFORE INSERT ON agents WHEN
					(NEW.acp_agent IS NOT NULL OR NEW.acpx_record_id IS NOT NULL OR NEW.acpx_session_id IS NOT NULL OR NEW.acpx_state IS NOT NULL OR NEW.acpx_attempt_key IS NOT NULL OR NEW.agentfs_session_id IS NOT NULL OR NEW.agentfs_db_path IS NOT NULL OR NEW.herdr_pane_id IS NOT NULL OR NEW.acpx_cancel_script IS NOT NULL)
					AND NOT (NEW.acp_agent IS NOT NULL AND NEW.acpx_record_id IS NOT NULL AND NEW.acpx_session_id IS NOT NULL AND NEW.acpx_state IS NOT NULL AND NEW.acpx_attempt_key IS NOT NULL AND NEW.agentfs_session_id IS NOT NULL AND NEW.agentfs_db_path IS NOT NULL AND NEW.herdr_pane_id IS NOT NULL AND NEW.acpx_cancel_script IS NOT NULL)
				BEGIN SELECT RAISE(ABORT, 'complete ACPX provenance required'); END;
				CREATE TRIGGER IF NOT EXISTS agents_acpx_identity_update
				BEFORE UPDATE OF acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,herdr_pane_id,acpx_cancel_script ON agents WHEN
					(NEW.acp_agent IS NOT NULL OR NEW.acpx_record_id IS NOT NULL OR NEW.acpx_session_id IS NOT NULL OR NEW.acpx_state IS NOT NULL OR NEW.acpx_attempt_key IS NOT NULL OR NEW.agentfs_session_id IS NOT NULL OR NEW.agentfs_db_path IS NOT NULL OR NEW.herdr_pane_id IS NOT NULL OR NEW.acpx_cancel_script IS NOT NULL)
					AND NOT (NEW.acp_agent IS NOT NULL AND NEW.acpx_record_id IS NOT NULL AND NEW.acpx_session_id IS NOT NULL AND NEW.acpx_state IS NOT NULL AND NEW.acpx_attempt_key IS NOT NULL AND NEW.agentfs_session_id IS NOT NULL AND NEW.agentfs_db_path IS NOT NULL AND NEW.herdr_pane_id IS NOT NULL AND NEW.acpx_cancel_script IS NOT NULL)
				BEGIN SELECT RAISE(ABORT, 'complete ACPX provenance required'); END;
			`);
			this.db.exec("INSERT OR REPLACE INTO schema_version(version) VALUES (4)");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** v5 makes presentation identity transport-aware without changing stored columns. */
	private migrateToV5(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			// Retired pre-v5 labels named visible Herdr workers. A complete triple identifies a real Herdr worker and is
			// kept as one; a row with no Herdr and no ACPX identity columns becomes a Herdr row with an incomplete
			// triple, which projects a null presentation identity — readable history, never focusable or reusable.
			// Any other retired-labelled row carries a partial identity and still fails closed below.
			this.db.exec(`
				UPDATE agents SET transport='herdr'
				WHERE transport IN ('delegate','opaque-delegate')
					AND (
						(herdr_agent IS NOT NULL AND tab_id IS NOT NULL AND herdr_pane_id IS NOT NULL)
						OR (herdr_agent IS NULL AND tab_id IS NULL AND herdr_pane_id IS NULL
							AND acp_agent IS NULL AND acpx_record_id IS NULL AND acpx_session_id IS NULL
							AND acpx_state IS NULL AND acpx_attempt_key IS NULL AND agentfs_session_id IS NULL
							AND agentfs_db_path IS NULL AND acpx_cancel_script IS NULL)
					)
			`);
			const invalid = this.db.query<CountRow, []>(`
				SELECT COUNT(*) AS count FROM agents WHERE
					transport NOT IN ('headless','herdr')
					OR (transport='herdr' AND acp_agent IS NOT NULL AND (herdr_agent IS NULL OR tab_id IS NULL OR herdr_pane_id IS NULL))
					OR (transport='headless' AND (herdr_agent IS NOT NULL OR tab_id IS NOT NULL OR herdr_pane_id IS NOT NULL))
			`).get()?.count ?? 0;
			if (invalid) throw new Error("agents table contains invalid transport presentation identity");
			this.db.exec(`
				DROP TRIGGER IF EXISTS agents_acpx_identity_insert;
				DROP TRIGGER IF EXISTS agents_acpx_identity_update;
				CREATE TRIGGER agents_acpx_identity_insert
				BEFORE INSERT ON agents WHEN
					NEW.transport NOT IN ('headless','herdr')
					OR (NEW.transport='herdr' AND (NEW.herdr_agent IS NULL OR NEW.tab_id IS NULL OR NEW.herdr_pane_id IS NULL))
					OR (NEW.transport='headless' AND (NEW.herdr_agent IS NOT NULL OR NEW.tab_id IS NOT NULL OR NEW.herdr_pane_id IS NOT NULL))
					OR ((NEW.acp_agent IS NOT NULL OR NEW.acpx_record_id IS NOT NULL OR NEW.acpx_session_id IS NOT NULL OR NEW.acpx_state IS NOT NULL OR NEW.acpx_attempt_key IS NOT NULL OR NEW.agentfs_session_id IS NOT NULL OR NEW.agentfs_db_path IS NOT NULL OR NEW.acpx_cancel_script IS NOT NULL)
						AND NOT (NEW.acp_agent IS NOT NULL AND NEW.acpx_record_id IS NOT NULL AND NEW.acpx_session_id IS NOT NULL AND NEW.acpx_state IS NOT NULL AND NEW.acpx_attempt_key IS NOT NULL AND NEW.agentfs_session_id IS NOT NULL AND NEW.agentfs_db_path IS NOT NULL AND NEW.acpx_cancel_script IS NOT NULL))
				BEGIN SELECT RAISE(ABORT, 'valid transport and complete ACPX provenance required'); END;
				CREATE TRIGGER agents_acpx_identity_update
				BEFORE UPDATE OF transport,herdr_agent,tab_id,herdr_pane_id,acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,acpx_cancel_script ON agents WHEN
					NEW.transport NOT IN ('headless','herdr')
					OR (NEW.transport='herdr' AND (NEW.herdr_agent IS NULL OR NEW.tab_id IS NULL OR NEW.herdr_pane_id IS NULL))
					OR (NEW.transport='headless' AND (NEW.herdr_agent IS NOT NULL OR NEW.tab_id IS NOT NULL OR NEW.herdr_pane_id IS NOT NULL))
					OR ((NEW.acp_agent IS NOT NULL OR NEW.acpx_record_id IS NOT NULL OR NEW.acpx_session_id IS NOT NULL OR NEW.acpx_state IS NOT NULL OR NEW.acpx_attempt_key IS NOT NULL OR NEW.agentfs_session_id IS NOT NULL OR NEW.agentfs_db_path IS NOT NULL OR NEW.acpx_cancel_script IS NOT NULL)
						AND NOT (NEW.acp_agent IS NOT NULL AND NEW.acpx_record_id IS NOT NULL AND NEW.acpx_session_id IS NOT NULL AND NEW.acpx_state IS NOT NULL AND NEW.acpx_attempt_key IS NOT NULL AND NEW.agentfs_session_id IS NOT NULL AND NEW.agentfs_db_path IS NOT NULL AND NEW.acpx_cancel_script IS NOT NULL))
				BEGIN SELECT RAISE(ABORT, 'valid transport and complete ACPX provenance required'); END;
			`);
			this.db.exec("INSERT OR REPLACE INTO schema_version(version) VALUES (5)");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		const foreignKeyFinding = this.db.query("PRAGMA foreign_key_check").get();
		if (foreignKeyFinding) throw new Error("v5 migration produced a foreign-key violation");
	}

	private migrateToV6(): void {
		this.transaction(() => {
			// The contract column existed from v6 to v9; v10 removes it, so it is only materialized on older databases.
			if (this.schemaVersion() < 10) this.ensureColumn("runs", "result_contract", "TEXT NOT NULL DEFAULT 'runtime-v1' CHECK(result_contract IN ('legacy-v1','runtime-v1'))");
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS runtime_attempts (
					attempt_key TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
					operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
					identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
					outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
					candidate_json TEXT CHECK(candidate_json IS NULL OR json_valid(candidate_json)),
					candidate_id TEXT UNIQUE,
					started_at TEXT NOT NULL,
					finished_at TEXT,
					CHECK((outcome_json IS NULL AND finished_at IS NULL) OR (outcome_json IS NOT NULL AND finished_at IS NOT NULL)),
					CHECK((candidate_json IS NULL AND candidate_id IS NULL) OR (candidate_json IS NOT NULL AND candidate_id IS NOT NULL AND outcome_json IS NOT NULL))
				);
				CREATE TRIGGER IF NOT EXISTS runtime_attempts_identity_immutable
				BEFORE UPDATE OF attempt_key,run_id,operation_id,identity_json,started_at ON runtime_attempts
				BEGIN SELECT RAISE(ABORT, 'runtime attempt identity is immutable'); END;
				CREATE TRIGGER IF NOT EXISTS runtime_attempts_settlement_immutable
				BEFORE UPDATE OF outcome_json,candidate_json,candidate_id,finished_at ON runtime_attempts WHEN OLD.outcome_json IS NOT NULL
				BEGIN SELECT RAISE(ABORT, 'runtime settlement is immutable'); END;
				INSERT OR REPLACE INTO schema_version(version) VALUES (6);
			`);
			if (this.schemaVersion() < 10) this.db.exec(`
				CREATE TRIGGER IF NOT EXISTS runtime_attempts_identity_insert
				BEFORE INSERT ON runtime_attempts WHEN NOT EXISTS (
					SELECT 1 FROM operations JOIN runs ON runs.id=operations.run_id
					WHERE operations.id=NEW.operation_id AND runs.id=NEW.run_id AND runs.result_contract='runtime-v1'
				)
				BEGIN SELECT RAISE(ABORT, 'runtime attempt requires matching operation and contract'); END;
			`);
		});
	}

	/** v7 records explicit candidate decisions, observed settlement identity and per-adapter enablement evidence. */
	private migrateToV7(): void {
		this.transaction(() => {
			this.ensureColumn("runtime_attempts", "observation_json", "TEXT CHECK(observation_json IS NULL OR json_valid(observation_json))");
			this.ensureColumn("runtime_attempts", "agent_id", "TEXT REFERENCES agents(id)");
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS runtime_decisions (
					attempt_key TEXT PRIMARY KEY REFERENCES runtime_attempts(attempt_key) ON DELETE CASCADE,
					candidate_id TEXT NOT NULL,
					decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
					verdict TEXT,
					reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
					integration_id TEXT,
					payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
					decided_at TEXT NOT NULL
				);
				CREATE TRIGGER IF NOT EXISTS runtime_decisions_immutable
				BEFORE UPDATE ON runtime_decisions
				BEGIN SELECT RAISE(ABORT, 'runtime decision is immutable'); END;
				CREATE TRIGGER IF NOT EXISTS runtime_decisions_candidate
				BEFORE INSERT ON runtime_decisions WHEN NOT EXISTS (
					SELECT 1 FROM runtime_attempts WHERE attempt_key=NEW.attempt_key AND candidate_id=NEW.candidate_id
				)
				BEGIN SELECT RAISE(ABORT, 'runtime decision requires the settled candidate'); END;
				CREATE TABLE IF NOT EXISTS runtime_adapters (
					agent TEXT PRIMARY KEY CHECK(agent IN ('pi','codex','claude')),
					evidence TEXT NOT NULL CHECK(length(trim(evidence)) > 0),
					enabled_at TEXT NOT NULL
				);
				INSERT OR REPLACE INTO schema_version(version) VALUES (7);
			`);
		});
	}

	/**
	 * v8 allows fenced attempt replacement: one active attempt per operation (partial unique index) while
	 * superseded attempts stay as immutable rows with their retained candidates and decisions. SQLite cannot
	 * drop the v6 UNIQUE constraint in place, so the table is rebuilt with foreign keys off and checked after.
	 */
	private migrateToV8(): void {
		if (this.schemaVersion() >= 8) return;
		this.db.exec("PRAGMA foreign_keys = OFF");
		try {
			this.db.exec("BEGIN IMMEDIATE");
			// Re-checked under the write lock: a second opener that saw v7 before the lock must not rebuild again.
			if (this.schemaVersion() >= 8) { this.db.exec("ROLLBACK"); return; }
			this.db.exec(`
				DROP TRIGGER IF EXISTS runtime_decisions_candidate;
				CREATE TABLE runtime_attempts_v8 (
					attempt_key TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
					operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
					identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
					outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
					candidate_json TEXT CHECK(candidate_json IS NULL OR json_valid(candidate_json)),
					candidate_id TEXT UNIQUE,
					started_at TEXT NOT NULL,
					finished_at TEXT,
					observation_json TEXT CHECK(observation_json IS NULL OR json_valid(observation_json)),
					agent_id TEXT REFERENCES agents(id),
					superseded_at TEXT,
					CHECK((outcome_json IS NULL AND finished_at IS NULL) OR (outcome_json IS NOT NULL AND finished_at IS NOT NULL)),
					CHECK((candidate_json IS NULL AND candidate_id IS NULL) OR (candidate_json IS NOT NULL AND candidate_id IS NOT NULL AND outcome_json IS NOT NULL)),
					CHECK(superseded_at IS NULL OR outcome_json IS NOT NULL)
				);
				INSERT INTO runtime_attempts_v8 (attempt_key,run_id,operation_id,identity_json,outcome_json,candidate_json,candidate_id,started_at,finished_at,observation_json,agent_id,superseded_at)
					SELECT attempt_key,run_id,operation_id,identity_json,outcome_json,candidate_json,candidate_id,started_at,finished_at,observation_json,agent_id,NULL FROM runtime_attempts;
				DROP TABLE runtime_attempts;
				ALTER TABLE runtime_attempts_v8 RENAME TO runtime_attempts;
				CREATE UNIQUE INDEX runtime_attempts_active ON runtime_attempts(operation_id) WHERE superseded_at IS NULL;
				CREATE TRIGGER runtime_attempts_identity_insert
				BEFORE INSERT ON runtime_attempts WHEN NOT EXISTS (
					SELECT 1 FROM operations JOIN runs ON runs.id=operations.run_id
					WHERE operations.id=NEW.operation_id AND runs.id=NEW.run_id AND runs.result_contract='runtime-v1'
				)
				BEGIN SELECT RAISE(ABORT, 'runtime attempt requires matching operation and contract'); END;
				CREATE TRIGGER runtime_attempts_identity_immutable
				BEFORE UPDATE OF attempt_key,run_id,operation_id,identity_json,started_at ON runtime_attempts
				BEGIN SELECT RAISE(ABORT, 'runtime attempt identity is immutable'); END;
				CREATE TRIGGER runtime_attempts_settlement_immutable
				BEFORE UPDATE OF outcome_json,candidate_json,candidate_id,observation_json,finished_at ON runtime_attempts WHEN OLD.outcome_json IS NOT NULL
				BEGIN SELECT RAISE(ABORT, 'runtime settlement is immutable'); END;
				CREATE TRIGGER runtime_attempts_superseded_immutable
				BEFORE UPDATE ON runtime_attempts WHEN OLD.superseded_at IS NOT NULL
				BEGIN SELECT RAISE(ABORT, 'a superseded runtime attempt is immutable'); END;
				CREATE TRIGGER runtime_decisions_candidate
				BEFORE INSERT ON runtime_decisions WHEN NOT EXISTS (
					SELECT 1 FROM runtime_attempts WHERE attempt_key=NEW.attempt_key AND candidate_id=NEW.candidate_id AND superseded_at IS NULL
				)
				BEGIN SELECT RAISE(ABORT, 'runtime decision requires the active settled candidate'); END;
				INSERT OR REPLACE INTO schema_version(version) VALUES (8);
			`);
			// Validated before the rebuild is committed, so an interrupted or violating migration leaves v7 intact.
			if (this.db.query("PRAGMA foreign_key_check").get()) throw new Error("v8 migration produced a foreign-key violation");
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// The failing statement may already have ended the transaction.
			}
			throw error;
		} finally {
			this.db.exec("PRAGMA foreign_keys = ON");
		}
	}

	/** v9: the operations graph runs on runtime-v1 (operational candidates), so the graph trigger from v6 goes. */
	private migrateToV9(): void {
		if (this.schemaVersion() >= 9) return;
		this.transaction(() => {
			if (this.schemaVersion() >= 9) return;
			this.db.exec(`
				DROP TRIGGER IF EXISTS runs_result_contract_graph;
				INSERT OR REPLACE INTO schema_version(version) VALUES (9);
			`);
		});
	}

	/**
	 * v10 removes the two columns the report contract left behind: `runs.result_contract` (with its immutability
	 * trigger) and `operations.report_path`. SQLite cannot drop a column that a CHECK or trigger names, so both tables
	 * are rebuilt with foreign keys off and checked before commit, the way v8 rebuilt runtime_attempts. A database
	 * that still holds a legacy run cannot be migrated and says so; none exists.
	 */
	private migrateToV10(): void {
		if (this.schemaVersion() >= 10) return;
		this.db.exec("PRAGMA foreign_keys = OFF");
		try {
			this.db.exec("BEGIN IMMEDIATE");
			if (this.schemaVersion() >= 10) { this.db.exec("ROLLBACK"); return; }
			const legacy = this.hasColumn("runs", "result_contract") ? this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs WHERE result_contract='legacy-v1'").get() : undefined;
			if (legacy?.count) throw new Error(`v10 migration refused: ${legacy.count} legacy-v1 run(s) remain; the report contract was removed on 2026-09-12 and such runs cannot be carried forward`);
			this.db.exec(`
				DROP TRIGGER IF EXISTS runtime_attempts_identity_insert;
				CREATE TABLE runs_v10 (
					id TEXT PRIMARY KEY,
					story TEXT NOT NULL,
					graph_name TEXT NOT NULL CHECK(graph_name IN ('build','research','operations')),
					task TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active','terminal','blocked','awaiting_user','deferred','cancelled')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					policy_json TEXT NOT NULL DEFAULT '{}',
					policy_digest TEXT NOT NULL DEFAULT ''
				);
				INSERT INTO runs_v10 (id,story,graph_name,task,status,created_at,updated_at,policy_json,policy_digest)
					SELECT id,story,graph_name,task,status,created_at,updated_at,policy_json,policy_digest FROM runs;
				DROP TABLE runs;
				ALTER TABLE runs_v10 RENAME TO runs;
				CREATE TABLE operations_v10 (
					id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
					node TEXT NOT NULL,
					slice_id TEXT,
					agent_id TEXT REFERENCES agents(id),
					status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','blocked','cancelled')),
					read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
					owned_paths_json TEXT NOT NULL DEFAULT '[]',
					round INTEGER NOT NULL,
					fix_iteration INTEGER NOT NULL,
					transient_attempts INTEGER NOT NULL DEFAULT 0,
					command_json TEXT,
					task TEXT NOT NULL,
					verdict TEXT,
					classifier_reason TEXT,
					last_error TEXT,
					retry_not_before TEXT,
					created_at TEXT NOT NULL,
					started_at TEXT,
					finished_at TEXT,
					model_attempt INTEGER NOT NULL DEFAULT 0,
					selected_model TEXT,
					retry_reason TEXT,
					fallback_reason TEXT
				);
				INSERT INTO operations_v10 (id,run_id,node,slice_id,agent_id,status,read_only,owned_paths_json,round,fix_iteration,transient_attempts,command_json,task,verdict,classifier_reason,last_error,retry_not_before,created_at,started_at,finished_at,model_attempt,selected_model,retry_reason,fallback_reason)
					SELECT id,run_id,node,slice_id,agent_id,status,read_only,owned_paths_json,round,fix_iteration,transient_attempts,command_json,task,verdict,classifier_reason,last_error,retry_not_before,created_at,started_at,finished_at,model_attempt,selected_model,retry_reason,fallback_reason FROM operations;
				DROP TABLE operations;
				ALTER TABLE operations_v10 RENAME TO operations;
				CREATE INDEX IF NOT EXISTS idx_operations_current ON operations(run_id, node, round, fix_iteration, status);
				CREATE TRIGGER runtime_attempts_identity_insert
				BEFORE INSERT ON runtime_attempts WHEN NOT EXISTS (
					SELECT 1 FROM operations JOIN runs ON runs.id=operations.run_id
					WHERE operations.id=NEW.operation_id AND runs.id=NEW.run_id
				)
				BEGIN SELECT RAISE(ABORT, 'runtime attempt requires a matching operation'); END;
				INSERT OR REPLACE INTO schema_version(version) VALUES (10);
			`);
			if (this.db.query("PRAGMA foreign_key_check").get()) throw new Error("v10 migration produced a foreign-key violation");
			this.db.exec("COMMIT");
		} catch (error) {
			try { this.db.exec("ROLLBACK"); } catch { /* the failing statement may already have ended the transaction */ }
			throw error;
		} finally {
			this.db.exec("PRAGMA foreign_keys = ON");
		}
	}

	/** v11 drops the adapter enablement table: every proven adapter is dispatchable, and provenance lives in the PRD and READMEs. */
	private migrateToV11(): void {
		if (this.schemaVersion() >= 11) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (this.schemaVersion() >= 11) { this.db.exec("ROLLBACK"); return; }
			this.db.exec("DROP TABLE IF EXISTS runtime_adapters; INSERT OR REPLACE INTO schema_version(version) VALUES (11)");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private iso(): string {
		return this.now().toISOString();
	}

	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private event(input: {
		runId: string;
		type: string;
		node?: NodeName;
		operationId?: string;
		agentId?: string;
		fromAgent?: string;
		toAgent?: string;
		replyTo?: string;
		fromNode?: NodeName;
		toNode?: NodeName;
		verdict?: string;
		payload?: Record<string, unknown>;
	}): void {
		this.db
			.query(`INSERT INTO events(ts,run_id,operation_id,agent_id,type,node,from_agent,to_agent,reply_to,from_node,to_node,verdict,payload_json)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				this.iso(),
				input.runId,
				input.operationId ?? null,
				input.agentId ?? null,
				input.type,
				input.node ?? null,
				input.fromAgent ?? null,
				input.toAgent ?? null,
				input.replyTo ?? null,
				input.fromNode ?? null,
				input.toNode ?? null,
				input.verdict ?? null,
				JSON.stringify(input.payload ?? {}),
			);
	}

	private insertOperation(
		runId: string,
		node: NodeName,
		task: string,
		round: number,
		fixIteration: number,
		sliceId?: string,
		ownedPaths: string[] = [],
		command?: OperationalCommand,
	): string {
		const id = `op_${randomUUID()}`;
		this.db
			.query(`INSERT INTO operations(id,run_id,node,slice_id,status,read_only,owned_paths_json,round,fix_iteration,command_json,task,created_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				id,
				runId,
				node,
				sliceId ?? null,
				"pending",
				nodeIsReadOnly(node) ? 1 : 0,
				JSON.stringify(ownedPaths),
				round,
				fixIteration,
				command ? JSON.stringify(command) : null,
				task,
				this.iso(),
			);
		this.event({
			runId,
			type: "operation_pending",
			node,
			operationId: id,
			toAgent: roleForNode(node),
			replyTo: node,
			payload: { task, sliceId: sliceId ?? null, ownedPaths, readOnly: nodeIsReadOnly(node) },
		});
		return id;
	}

	/** Initializes a run and freezes the selected graph definition plus its immutable policy snapshot. */
	initRun(
		story: string,
		graph: GraphKind,
		task: string,
		policy: ResolvedPolicy = DEFAULT_AUTO_POLICY,
		operationalCommands?: OperationalCommandSpec[],
	): RunState {
		if (!story.trim() || !task.trim()) throw new Error("story and task are required");
		this.assertPolicy(policy);
		const commands = graph === "operations" ? validateOperationalCommands(operationalCommands) : undefined;
		if (graph !== "operations" && operationalCommands?.length) throw new Error("structured commands require the operations graph");
		const runId = `run_${randomUUID()}`;
		const definition = graphDefinition(graph);
		const now = this.iso();
		const policyJson = stableStringify(policy);
		const digest = policyDigest(policy);
		return this.transaction(() => {
			this.db.query("INSERT INTO runs(id,story,graph_name,task,status,policy_json,policy_digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
				runId,
				story,
				graph,
				task,
				"active",
				policyJson,
				digest,
				now,
				now,
			);
			this.db.query("INSERT INTO graphs(run_id,name,definition_json,sha256) VALUES (?,?,?,?)").run(
				runId,
				graph,
				JSON.stringify(definition),
				graphHash(definition),
			);
			this.db.query("INSERT INTO state(run_id,current_node,round,fix_iteration,status,updated_at) VALUES (?,?,?,?,?,?)").run(
				runId,
				definition.initialNode,
				1,
				0,
				"active",
				now,
			);
			this.event({ runId, type: "run_initialized", toNode: definition.initialNode, replyTo: definition.initialNode, payload: { story, graph, task, policy: { digest, input: policy.input } } });
			if (commands) {
				for (const item of commands) this.insertOperation(runId, definition.initialNode, item.name, 1, 0, item.id, item.ownedPaths, item.checkpoint ? { ...item.command, checkpoint: item.checkpoint } : item.command);
			} else {
				this.insertOperation(runId, definition.initialNode, task, 1, 0);
			}
			return { runId, graph, currentNode: definition.initialNode, round: 1, fixIteration: 0, status: "active" };
		});
	}

	getRun(runId: string): RunRow {
		const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId);
		if (!row) throw new Error(`unknown run ${runId}`);
		return row;
	}

	/** Returns the immutable frozen policy snapshot after verifying its stored digest. */
	policy(runId: string): FrozenPolicy {
		const run = this.getRun(runId);
		const resolved = this.parsePolicy(run.policy_json);
		const digest = policyDigest(resolved);
		if (!run.policy_digest || run.policy_digest !== digest) throw new Error(`frozen policy digest mismatch for ${runId}`);
		return { input: resolved.input, routes: resolved.routes, digest };
	}

	/** Returns the frozen route for a graph node's role, if the policy resolved one. */
	routeForNode(runId: string, node: NodeName): PolicyRoute | undefined {
		const role = roleForNode(node);
		return this.policy(runId).routes.find((route) => route.role === role);
	}

	private assertPolicy(policy: ResolvedPolicy): void {
		const input = policy?.input;
		if (!input || !["auto", "preset", "tier", "model"].includes(input.kind)) throw new Error("invalid model policy input");
		if (input.kind === "preset" && !["cheap", "balanced", "strong", "local", "long-context"].includes(input.preset)) {
			throw new Error(`invalid model policy preset ${input.preset}`);
		}
		if (input.kind === "tier" && !input.tier.trim()) throw new Error("tier policy requires a non-empty tier");
		if (input.kind === "model" && (!input.model.trim() || !input.reason.trim())) {
			throw new Error("exact model policy requires non-empty model and reason");
		}
		if (!Array.isArray(policy.routes)) throw new Error("resolved policy routes must be an array");
		const roles = new Set<string>();
		for (const route of policy.routes) {
			if (!route.role || roles.has(route.role)) throw new Error(`invalid or duplicate policy role ${route.role}`);
			roles.add(route.role);
			if (!Array.isArray(route.chain) || route.chain.some((model) => !model.trim())) throw new Error(`invalid model chain for ${route.role}`);
		}
	}

	private parsePolicy(raw: string): ResolvedPolicy {
		let parsed: ResolvedPolicy;
		try {
			parsed = JSON.parse(raw) as ResolvedPolicy;
		} catch (error) {
			throw new Error(`invalid frozen policy JSON: ${String(error)}`);
		}
		this.assertPolicy(parsed);
		return parsed;
	}

	private assertDispatchPolicy(runId: string, operation: OperationRow, input: RecordOperationInput): void {
		const policy = this.policy(runId);
		const route = policy.routes.find((candidate) => candidate.role === roleForNode(operation.node));
		const bindingSupplied = input.policyDigest !== undefined || input.modelPolicy !== undefined;
		if (route || bindingSupplied) {
			if (!input.policyDigest) throw new Error("dispatch requires the frozen policy digest from op=next");
			if (input.policyDigest !== policy.digest) throw new Error("dispatch policy digest conflicts with the frozen run policy");
			if (!input.modelPolicy) throw new Error("dispatch requires the frozen modelPolicy from op=next");
			if (stableStringify(input.modelPolicy) !== stableStringify(policy.input)) {
				throw new Error("dispatch modelPolicy conflicts with the frozen run policy");
			}
		}
		if (!route) return;
		const modelAttempt = input.modelAttempt ?? operation.model_attempt;
		if (!Number.isInteger(modelAttempt) || modelAttempt < 0 || modelAttempt >= route.chain.length) {
			throw new Error(`modelAttempt ${modelAttempt} is outside the frozen chain for ${route.role}`);
		}
		if (modelAttempt < operation.model_attempt || modelAttempt > operation.model_attempt + 1) {
			throw new Error(`modelAttempt must remain ${operation.model_attempt} or advance exactly once`);
		}
		const selectedModel = input.selectedModel;
		if (!selectedModel || selectedModel !== route.chain[modelAttempt]) {
			throw new Error(`selectedModel must match frozen chain model ${route.chain[modelAttempt]}`);
		}
		if (modelAttempt > operation.model_attempt) {
			if (policy.input.kind === "model") throw new Error("exact model policy cannot fall back");
			if (!input.fallbackReason?.trim()) throw new Error("cross-model fallback requires fallbackReason");
		} else if (input.fallbackReason) {
			throw new Error("fallbackReason requires an advanced modelAttempt");
		}
	}

	/** Frozen policy fields attached to dispatch, retry, and fallback events. */
	private policyEventContext(
		runId: string,
		node: NodeName,
		modelAttempt: number,
		retryAttempt = 0,
		retryReason: string | null = null,
		fallbackReason: string | null = null,
	): Record<string, unknown> {
		const policy = this.policy(runId);
		const route = policy.routes.find((candidate) => candidate.role === roleForNode(node));
		const chain = route?.chain ?? [];
		const selectedModel = chain[modelAttempt] ?? null;
		return {
			policyDigest: policy.digest,
			inputKind: policy.input.kind,
			preset: policy.input.kind === "preset" ? policy.input.preset : null,
			role: roleForNode(node),
			tier: route?.tier ?? null,
			selectedModel,
			modelAttempt,
			attempt: modelAttempt,
			retryAttempt,
			chainLength: chain.length,
			retryReason,
			fallbackReason,
			thinking: route?.thinking ?? null,
			session: route?.session ?? null,
			capabilityFloor: route?.capabilityFloor ?? null,
			selectionSource: route?.selectionSource ?? null,
			promotionReason: route?.promotionReason ?? null,
		};
	}

	getState(runId: string): RunState {
		const run = this.getRun(runId);
		const row = this.db.query<StateRow, [string]>("SELECT * FROM state WHERE run_id=?").get(runId);
		if (!row) throw new Error(`missing state for ${runId}`);
		return {
			runId,
			graph: run.graph_name,
			currentNode: row.current_node,
			round: row.round,
			fixIteration: row.fix_iteration,
			status: row.status,
		};
	}

	getOperation(operationId: string): OperationRow {
		const row = this.db.query<OperationRow, [string]>("SELECT * FROM operations WHERE id=?").get(operationId);
		if (!row) throw new Error(`unknown operation ${operationId}`);
		return row;
	}

	operations(runId: string, currentOnly = false): OperationRow[] {
		if (!currentOnly) {
			return this.db.query<OperationRow, [string]>("SELECT * FROM operations WHERE run_id=? ORDER BY created_at,id").all(runId);
		}
		const state = this.getState(runId);
		return this.db
			.query<OperationRow, [string, string, number, number]>(
				"SELECT * FROM operations WHERE run_id=? AND node=? AND round=? AND fix_iteration=? ORDER BY created_at,id",
			)
			.all(runId, state.currentNode, state.round, state.fixIteration);
	}

	/** Returns the current dispatchable operations, each with its frozen role route, plus the frozen policy. */
	next(runId: string): { state: RunState; operations: (OperationRow & { route?: PolicyRoute; runtimeAttempt?: RuntimeAttempt })[]; policy: FrozenPolicy } {
		const policy = this.policy(runId);
		const operations = this.operations(runId, true).map((operation) => ({
			...operation,
			route: policy.routes.find((route) => route.role === roleForNode(operation.node)),
			runtimeAttempt: this.runtimeAttemptForOperation(operation.id),
		}));
		return { state: this.getState(runId), operations, policy };
	}

	retainRuntimeContent(bytes: Uint8Array): RuntimeContent {
		return new RuntimeContentStore(this.dbPath).retain(bytes);
	}

	runtimeContentPath(content: RuntimeContent): string {
		return new RuntimeContentStore(this.dbPath).path(content);
	}

	/** The registered runtime attempt for an operation, if any; every public runtime op starts here. */
	runtimeAttemptByOperation(operationId: string): RuntimeAttempt | undefined {
		return this.runtimeAttemptForOperation(operationId);
	}

	private runtimeAttemptForOperation(operationId: string): RuntimeAttempt | undefined {
		const row = this.db.query<{ attempt_key: string }, [string]>("SELECT attempt_key FROM runtime_attempts WHERE operation_id=? AND superseded_at IS NULL").get(operationId);
		return row ? this.runtimeAttempt(row.attempt_key) : undefined;
	}

	runtimeAttempt(attemptKey: string): RuntimeAttempt {
		const row = this.db.query<RuntimeAttemptRow, [string]>("SELECT * FROM runtime_attempts WHERE attempt_key=?").get(attemptKey);
		if (!row) throw new Error("unknown runtime attempt");
		const outcome = row.outcome_json === null ? null : parseRuntimeOutcome(JSON.parse(row.outcome_json));
		const candidate = row.candidate_json === null ? null : parseRuntimeCandidate(JSON.parse(row.candidate_json));
		const observation = row.observation_json === null ? null : parseRuntimeObservation(JSON.parse(row.observation_json));
		const decision = this.runtimeDecision(attemptKey);
		const acceptance: RuntimeAttempt["acceptance"] = decision ? decision.decision : candidate && this.getRun(row.run_id).status !== "cancelled" ? "pending" : "unavailable";
		return {
			attemptKey, runId: row.run_id, operationId: row.operation_id, agentId: row.agent_id, processState: outcome?.kind ?? "running", outcome, candidate,
			candidateId: row.candidate_id, observation, decision, cleanup: "pending", acceptance,
			startedAt: row.started_at, finishedAt: row.finished_at, supersededAt: row.superseded_at,
		};
	}

	private runtimeDecision(attemptKey: string): RuntimeDecision | null {
		const row = this.db.query<RuntimeDecisionRow, [string]>("SELECT * FROM runtime_decisions WHERE attempt_key=?").get(attemptKey);
		if (!row) return null;
		return { decision: parseRuntimeDecisionKind(row.decision), reason: row.reason, verdict: row.verdict, integrationId: row.integration_id, decidedAt: row.decided_at };
	}

	/**
	 * A derived, reconstructible view of a runtime-v1 run: every attempt with its identity, outcome,
	 * candidate references, observation, decision and supersession, plus the event ledger. It reads
	 * only; it cannot invalidate a candidate, settle an operation or advance a graph, and it is not
	 * consulted by any gate.
	 */
	runtimeLedger(runId: string): RuntimeLedger {
		const run = this.getRun(runId);
		const state = this.getState(runId);
		const policy = this.policy(runId);
		const operations = this.operations(runId).map((operation) => {
			const attempts = this.db.query<{ attempt_key: string; identity_json: string }, [string]>("SELECT attempt_key,identity_json FROM runtime_attempts WHERE operation_id=? ORDER BY started_at,attempt_key").all(operation.id)
				.map((row) => {
					const attempt = this.runtimeAttempt(row.attempt_key);
					const registered: unknown = JSON.parse(row.identity_json);
					const identity = isRecordValue(registered) && isRecordValue(registered.identity) ? registered.identity : {};
					return {
						attemptKey: attempt.attemptKey, modelAttempt: numberOr(identity.modelAttempt), transientAttempt: numberOr(identity.transientAttempt), selectedModel: stringOr(identity.selectedModel), agent: stringOr(identity.agent),
						agentId: attempt.agentId, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, supersededAt: attempt.supersededAt,
						processState: attempt.processState, outcome: attempt.outcome, candidateId: attempt.candidateId, candidateKind: attempt.candidate?.kind ?? null, checkpoint: attempt.candidate?.kind === "operational" ? attempt.candidate.checkpoint : null,
						contents: attempt.candidate ? candidateContents(attempt.candidate).map((content) => ({ digest: content.sha256, bytes: content.bytes })) : [],
						observation: attempt.observation, acceptance: attempt.acceptance, decision: attempt.decision,
					};
				});
			return { operationId: operation.id, node: operation.node, round: operation.round, fixIteration: operation.fix_iteration, status: operation.status, modelAttempt: operation.model_attempt, transientAttempts: operation.transient_attempts, selectedModel: operation.selected_model, classifierReason: operation.classifier_reason, retryReason: operation.retry_reason, fallbackReason: operation.fallback_reason, lastError: operation.last_error, retryNotBefore: operation.retry_not_before, attempts };
		});
		const events = this.events(runId, 10_000).map((event) => ({ id: event.id, ts: event.ts, type: event.type, node: event.node, operationId: event.operation_id, agentId: event.agent_id, verdict: event.verdict, payload: JSON.parse(event.payload_json) as unknown }));
		return { schemaVersion: 1, derived: true, derivedAt: this.iso(), runId, story: run.story, graph: run.graph_name, task: run.task, resultContract: "runtime-v1", status: state.status, currentNode: state.currentNode, round: state.round, fixIteration: state.fixIteration, policyDigest: policy.digest, operations, events };
	}

	/** Registers the operation's active attempt; a replacement registers only with the identity retryRuntimeAttempt froze. */
	beginRuntimeAttempt(input: RuntimeAttemptInput): RuntimeAttempt {
		return this.transaction(() => {
			const identity = createAcpxAttemptIdentity({
				runId: input.identity.runId, operationId: input.identity.operationId, role: input.identity.role,
				modelAttempt: input.identity.modelAttempt, transientAttempt: input.identity.transientAttempt,
				selectedModel: input.identity.selectedModel, agent: input.identity.agent, presentation: input.identity.presentation,
			});
			if (canonical(identity) !== canonical(input.identity)) throw new Error("runtime attempt identity mismatch");
			const run = this.getRun(identity.runId);
			if (run.status !== "active") throw new Error(`run is ${run.status}`);
			const operation = this.getOperation(identity.operationId);
			const state = this.getState(run.id);
			if (operation.run_id !== run.id || operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) throw new Error("stale runtime operation");
			if (!input.sessionId.trim() || (input.requestId !== null && !input.requestId.trim())) throw new Error("runtime session and request identity required");
			if (input.agentId !== undefined) {
				const agent = this.db.query<{ run_id: string }, [string]>("SELECT run_id FROM agents WHERE id=?").get(input.agentId);
				if (!agent || agent.run_id !== run.id) throw new Error("runtime attempt agent does not belong to run");
			}
			if (identity.role !== roleForNode(operation.node) || identity.modelAttempt !== operation.model_attempt || identity.transientAttempt !== operation.transient_attempts) throw new Error("runtime attempt identity conflicts with operation");
			if (selectAcpAgent(identity.selectedModel) !== identity.agent) throw new Error("runtime agent conflicts with selected model");
			const policy = this.policy(run.id);
			if (input.policyDigest !== policy.digest) throw new Error("runtime policy digest mismatch");
			const route = policy.routes.find((route) => route.role === identity.role);
			if (!route || route.chain[identity.modelAttempt] !== identity.selectedModel) throw new Error("runtime model conflicts with frozen policy");
			if (policy.input.kind === "model" && policy.input.model !== identity.selectedModel) throw new Error("runtime model conflicts with exact lock");
			const identityJson = canonical({ identity: input.identity, sessionId: input.sessionId, requestId: input.requestId, policyDigest: input.policyDigest });
			const previous = this.db.query<RuntimeAttemptRow, [string]>("SELECT * FROM runtime_attempts WHERE operation_id=? AND superseded_at IS NULL").get(operation.id);
			if (previous) {
				if (previous.identity_json !== identityJson) throw new Error("conflicting runtime attempt identity");
				if (input.agentId !== undefined && previous.agent_id !== null && previous.agent_id !== input.agentId) throw new Error("conflicting runtime attempt agent");
				if (input.agentId !== undefined && previous.agent_id === null) {
					this.db.query("UPDATE runtime_attempts SET agent_id=? WHERE attempt_key=?").run(input.agentId, previous.attempt_key);
					this.db.query("UPDATE operations SET agent_id=? WHERE id=?").run(input.agentId, operation.id);
				}
				return this.runtimeAttempt(previous.attempt_key);
			}
			if (operation.status !== "pending") throw new Error("runtime operation must be pending");
			const now = this.iso();
			this.db.query("INSERT INTO runtime_attempts(attempt_key,run_id,operation_id,identity_json,started_at,agent_id) VALUES (?,?,?,?,?,?)").run(identity.attemptKey, run.id, operation.id, identityJson, now, input.agentId ?? null);
			this.db.query("UPDATE operations SET status='running',started_at=?,selected_model=?,agent_id=COALESCE(?,agent_id) WHERE id=?").run(now, identity.selectedModel, input.agentId ?? null, operation.id);
			if (input.agentId !== undefined) this.db.query("UPDATE agents SET status='running',policy_digest=?,selected_model=?,model_attempt=?,last_activity_at=? WHERE id=?").run(policy.digest, identity.selectedModel, identity.modelAttempt, now, input.agentId);
			this.event({ runId: run.id, operationId: operation.id, type: "runtime_attempt_registered", payload: { attemptKey: identity.attemptKey } });
			return this.runtimeAttempt(identity.attemptKey);
		});
	}

	/** Commits facts only. No report, ledger, verdict, retry or graph transition is inferred. */
	settleRuntimeAttempt(input: RuntimeSettlementInput): RuntimeAttempt {
		return this.transaction(() => {
			const current = this.runtimeAttempt(input.attemptKey);
			const outcome = parseRuntimeOutcome(input.outcome);
			const candidate = input.candidate === undefined ? null : parseRuntimeCandidate(input.candidate);
			const observation = input.observation === undefined ? null : parseRuntimeObservation(input.observation);
			if (candidate) for (const content of candidateContents(candidate)) new RuntimeContentStore(this.dbPath).verify(content);
			if (observation?.manifest && (!candidate || (candidate.kind !== "coding" && candidate.kind !== "operational") || !candidate.artifacts.some((item) => canonical(item) === canonical(observation.manifest)))) throw new Error("observed manifest must be a retained coding or operational artifact");
			if (current.outcome !== null) {
				if (canonical(current.outcome) !== canonical(outcome) || canonical(current.candidate) !== canonical(candidate) || canonical(current.observation) !== canonical(observation)) throw new Error("conflicting runtime settlement");
				return current;
			}
			const candidateId = candidate ? runtimeDigest({ attemptKey: input.attemptKey, candidate }) : null;
			this.db.query("UPDATE runtime_attempts SET outcome_json=?,candidate_json=?,candidate_id=?,observation_json=?,finished_at=? WHERE attempt_key=? AND outcome_json IS NULL")
				.run(canonical(outcome), candidate ? canonical(candidate) : null, candidateId, observation ? canonical(observation) : null, this.iso(), input.attemptKey);
			if (current.agentId) this.db.query("UPDATE agents SET status=?,last_activity_at=? WHERE id=?").run(outcome.kind === "exited" ? "completed" : outcome.kind === "cancelled" ? "cancelled" : "failed", this.iso(), current.agentId);
			this.event({ runId: current.runId, operationId: current.operationId, type: "runtime_attempt_settled", payload: { attemptKey: input.attemptKey, processState: outcome.kind, candidateId } });
			return this.runtimeAttempt(input.attemptKey);
		});
	}

	/** Reserves a checkpoint for a retained coding candidate; never applies or accepts it. */
	prepareRuntimeIntegration(attemptKey: string, manifestReference: RuntimeContent): IntegrationStatus {
		return this.prepareIntegration(attemptKey, manifestReference, false);
	}

	/** Only a rollback may touch a superseded attempt's integration: the historical recovery route after replacement. */
	private prepareIntegration(attemptKey: string, manifestReference: RuntimeContent, historicalRollback: boolean): IntegrationStatus {
		const attempt = this.runtimeAttempt(attemptKey);
		if (attempt.supersededAt && !historicalRollback) throw new Error("integration refused: the attempt was superseded by a replacement; only rollback remains available");
		const candidate = attempt.candidate;
		if (!attempt.outcome || !candidate || (candidate.kind !== "coding" && candidate.kind !== "operational") || !attempt.candidateId) throw new Error("integration requires a settled coding or operational candidate");
		if (!candidate.artifacts.some((item) => canonical(item) === canonical(manifestReference))) throw new Error("candidate does not retain this staging manifest");
		const content = new RuntimeContentStore(this.dbPath);
		const manifest = parseRuntimeStagingManifest(JSON.parse(content.read(manifestReference, 16 * 1024 * 1024).toString("utf8")));
		if (manifest.attemptKey !== attemptKey || manifest.baseRevision !== candidate.baseRevision || manifest.readOnly) throw new Error("staging manifest conflicts with candidate identity");
		if (realpathSync(manifest.workspace) !== manifest.workspace) throw new Error("staging workspace identity changed");
		for (const change of manifest.changes) {
			if (change.after && !candidate.artifacts.some((item) => canonical(item) === canonical(change.after))) throw new Error("candidate does not retain staged file");
		}
		const journal = new RuntimeIntegration(this.dbPath);
		try {
			return journal.prepare({ workspace: manifest.workspace, baseRevision: manifest.baseRevision, candidateId: attempt.candidateId, ownedPaths: manifest.ownedPaths, changes: manifest.changes, gitChecks: candidate.kind === "coding" }, () => {
				const run = this.getRun(attempt.runId);
				const operation = this.getOperation(attempt.operationId);
				if (run.status !== "active" || operation.status === "cancelled") throw new Error(`runtime integration unavailable: ${run.status === "active" ? operation.status : run.status}`);
				const state = this.getState(run.id);
				const current = this.runtimeAttempt(attemptKey);
				if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration || current.candidateId !== attempt.candidateId) throw new Error("stale integration candidate");
				if (current.supersededAt && !historicalRollback) throw new Error("integration refused: the attempt was superseded during preparation");
				for (const reference of candidateContents(candidate)) content.verify(reference);
			});
		} finally { journal.close(); }
	}

	/** Applies a prepared candidate integration to completion, or rolls it back; each file step is journaled. */
	applyRuntimeIntegration(attemptKey: string, manifest: RuntimeContent, direction: "apply" | "rollback" = "apply"): IntegrationStatus {
		const prepared = this.prepareIntegration(attemptKey, manifest, direction === "rollback");
		const journal = new RuntimeIntegration(this.dbPath);
		try { return direction === "apply" ? journal.apply(prepared.id) : journal.rollback(prepared.id); }
		finally { journal.close(); }
	}

	/** An integration that has touched or reserved the workspace for this candidate and has not been rolled back. */
	private outstandingIntegrationFor(candidateId: string): IntegrationStatus | null {
		if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_integrations'").get()) return null;
		const row = this.db.query<{ id: string; state: IntegrationStatus["state"]; direction: IntegrationStatus["direction"]; error: string | null }, [string]>(
			"SELECT id,state,direction,error FROM runtime_integrations WHERE json_extract(manifest_json,'$.candidateId')=? AND state IN ('prepared','applying','applied','needs_reconciliation')",
		).get(candidateId);
		return row ? { id: row.id, state: row.state, direction: row.direction, error: row.error } : null;
	}

	private integrationStatusFor(workspace: string, candidateId: string): IntegrationStatus | null {
		// The journal creates its own table on first use; before that nothing can have been prepared.
		if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_integrations'").get()) return null;
		const row = this.db.query<{ id: string; state: IntegrationStatus["state"]; direction: IntegrationStatus["direction"]; error: string | null }, [string, string]>(
			"SELECT id,state,direction,error FROM runtime_integrations WHERE workspace=? AND json_extract(manifest_json,'$.candidateId')=?",
		).get(workspace, candidateId);
		return row ? { id: row.id, state: row.state, direction: row.direction, error: row.error } : null;
	}

	/**
	 * Records the caller's explicit acceptance or rejection of a settled candidate. Acceptance completes the
	 * operation through the same join and transition logic as legacy completion; rejection parks the run for
	 * the user with the candidate retained. Duplicate identical decisions return the recorded outcome.
	 */
	decideRuntimeCandidate(input: RuntimeDecisionInput): RuntimeDecisionResult {
		return this.transaction(() => {
			const decision = parseRuntimeDecisionKind(input.decision);
			const reason = input.reason.trim();
			if (!reason) throw new Error("runtime decision requires a reason");
			const attempt = this.runtimeAttempt(input.attemptKey);
			const verdict = input.verdict?.trim().toUpperCase() || null;
			const result = () => ({ attempt: this.runtimeAttempt(input.attemptKey), state: this.getState(attempt.runId), operation: this.getOperation(attempt.operationId) });
			if (attempt.decision) {
				if (attempt.decision.decision !== decision || attempt.decision.reason !== reason || attempt.decision.verdict !== verdict) throw new Error("conflicting runtime decision");
				return result();
			}
			if (attempt.supersededAt) throw new Error("runtime decision refused: the attempt was superseded by a replacement");
			if (!attempt.outcome || !attempt.candidate || !attempt.candidateId) throw new Error("runtime decision requires a settled candidate");
			const run = this.getRun(attempt.runId);
			if (run.status !== "active") throw new Error(`run is ${run.status}`);
			const state = this.getState(run.id);
			const operation = this.getOperation(attempt.operationId);
			if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) throw new Error("operation is stale for current graph state");
			if (operation.status !== "running") throw new Error(`cannot decide operation from ${operation.status}`);
			let integrationId: string | null = null;
			if (decision === "accepted" && (attempt.candidate.kind === "coding" || attempt.candidate.kind === "operational")) {
				const manifestReference = attempt.observation?.manifest ?? null;
				if (!manifestReference) throw new Error(`${attempt.candidate.kind} acceptance requires the observed staging manifest`);
				const content = new RuntimeContentStore(this.dbPath);
				const manifest = parseRuntimeStagingManifest(JSON.parse(content.read(manifestReference, 16 * 1024 * 1024).toString("utf8")));
				if (manifest.attemptKey !== input.attemptKey || manifest.baseRevision !== attempt.candidate.baseRevision) throw new Error("staging manifest conflicts with candidate identity");
				if (manifest.changes.length) {
					const status = this.integrationStatusFor(manifest.workspace, attempt.candidateId);
					if (!status || status.state !== "applied") throw new Error(`${attempt.candidate.kind} acceptance requires an applied integration (${status?.state ?? "not prepared"})`);
					integrationId = status.id;
				}
			}
			const now = this.iso();
			this.db.query("INSERT INTO runtime_decisions(attempt_key,candidate_id,decision,verdict,reason,integration_id,payload_json,decided_at) VALUES (?,?,?,?,?,?,?,?)")
				.run(input.attemptKey, attempt.candidateId, decision, verdict, reason, integrationId, input.payload ? canonical(input.payload) : null, now);
			this.event({ runId: run.id, operationId: operation.id, agentId: attempt.agentId ?? undefined, type: "runtime_candidate_decided", node: operation.node, payload: { attemptKey: input.attemptKey, candidateId: attempt.candidateId, decision, verdict, reason, integrationId } });
			if (decision === "rejected") {
				this.db.query("UPDATE operations SET status='failed',classifier_reason='candidate-rejected',last_error=?,finished_at=? WHERE id=?").run(reason, now, operation.id);
				if (attempt.agentId) this.db.query("UPDATE agents SET status='failed',last_activity_at=? WHERE id=?").run(now, attempt.agentId);
				this.setState(run.id, state.currentNode, state.round, state.fixIteration, "awaiting_user");
				this.event({ runId: run.id, type: "operation_failed", node: operation.node, operationId: operation.id, agentId: attempt.agentId ?? undefined, fromAgent: roleForNode(operation.node), toAgent: "user", replyTo: "user", payload: { classification: "candidate-rejected", error: reason } });
				return result();
			}
			this.completeOperation(state, operation, { verdict: verdict ?? undefined, payload: input.payload, agentName: undefined, settlingWhileParked: false });
			return result();
		});
	}

	/**
	 * Fenced attempt replacement under the frozen policy. Automatic mode classifies the active attempt's own
	 * recorded failure (or a launch failure when no attempt exists) exactly as legacy record does: same-model
	 * budget of three, then the next frozen chain model, then awaiting_user. Approved mode is the operator's
	 * retry from awaiting_user. Neither path decides a candidate or advances the graph.
	 */
	retryRuntimeAttempt(input: RuntimeRetryInput): RuntimeRetryResult {
		return this.transaction(() => {
			const run = this.getRun(input.runId);
			const operation = this.getOperation(input.operationId);
			if (operation.run_id !== run.id) throw new Error("operation does not belong to run");
			const state = this.getState(run.id);
			if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) throw new Error("operation is stale for current graph state");
			const activeRow = this.db.query<{ attempt_key: string }, [string]>("SELECT attempt_key FROM runtime_attempts WHERE operation_id=? AND superseded_at IS NULL").get(operation.id);
			const previous = activeRow ? this.runtimeAttempt(activeRow.attempt_key) : null;
			const now = this.iso();
			const role = roleForNode(operation.node);
			const result = (retry: RuntimeRetryResult["retry"], classification: string | null, exhausted: boolean): RuntimeRetryResult => ({
				state: this.getState(run.id), operation: this.getOperation(operation.id), previousAttempt: previous ? this.runtimeAttempt(previous.attemptKey) : null, classification, retry, exhausted,
			});
			const supersede = () => {
				if (!previous) return;
				this.db.query("UPDATE runtime_attempts SET superseded_at=? WHERE attempt_key=? AND superseded_at IS NULL").run(now, previous.attemptKey);
				this.event({ runId: run.id, operationId: operation.id, agentId: previous.agentId ?? undefined, type: "runtime_attempt_superseded", node: operation.node, payload: { attemptKey: previous.attemptKey, processState: previous.processState } });
			};

			if (input.approved) {
				if (input.error !== undefined) throw new Error("an approved retry carries no failure text");
				// awaiting_user and deferred park a failed operation; an escalated run is blocked with an explicitly blocked operation, and the operator may resume either.
				if (state.status !== "awaiting_user" && state.status !== "deferred" && state.status !== "blocked") throw new Error("run is not awaiting a recovery decision");
				if (state.status === "blocked" && operation.status !== "blocked") throw new Error("recovery requires an explicitly blocked operation");
				if (operation.status !== "failed" && operation.status !== "blocked") throw new Error("operation is not awaiting recovery");
				if (previous && !previous.outcome) throw new Error("runtime attempt is still running");
				if (previous?.candidateId) {
					const outstanding = this.outstandingIntegrationFor(previous.candidateId);
					if (outstanding) throw new Error(`runtime retry refused: the candidate's integration is ${outstanding.state}; roll it back first`);
				}
				supersede();
				const retryReason = input.retryReason?.trim() || "operator-approved-retry";
				// The transient counter advances rather than resetting: attempt keys derive from it, and a
				// superseded key must never be minted twice. The same-model budget is not restored.
				const attempt = operation.transient_attempts + 1;
				this.db.query("UPDATE operations SET status='pending',agent_id=NULL,transient_attempts=?,classifier_reason=NULL,last_error=NULL,retry_reason=?,fallback_reason=NULL,retry_not_before=NULL,started_at=NULL,finished_at=NULL WHERE id=?").run(attempt, retryReason, operation.id);
				const unresolved = this.db.query<CountRow, [string, string, number, number]>(
					"SELECT COUNT(*) AS count FROM operations WHERE run_id=? AND node=? AND round=? AND fix_iteration=? AND status IN ('failed','blocked')",
				).get(run.id, operation.node, operation.round, operation.fix_iteration);
				this.setState(run.id, operation.node, operation.round, operation.fix_iteration, unresolved?.count ? "awaiting_user" : "active");
				this.event({ runId: run.id, type: "resume", node: operation.node, operationId: operation.id, agentId: previous?.agentId ?? undefined, toAgent: role, replyTo: role, payload: {
					previousAttempt: previous ? { attemptKey: previous.attemptKey, processState: previous.processState, acceptance: previous.acceptance, error: operation.last_error } : { error: operation.last_error },
				} });
				const selectedModel = operation.selected_model ?? this.policy(run.id).routes.find((route) => route.role === role)?.chain[operation.model_attempt] ?? "";
				return result({ attempt, modelAttempt: operation.model_attempt, selectedModel, delayMs: 0, notBefore: now }, null, false);
			}

			if (run.status !== "active") throw new Error(`run is ${run.status}`);
			let error: string;
			if (previous) {
				if (!previous.outcome) throw new Error("runtime attempt is still running; collect it before retrying");
				if (input.error !== undefined) throw new Error("a settled runtime attempt is retried from its own recorded outcome, not caller text");
				if (previous.decision) throw new Error(`runtime attempt was already ${previous.decision.decision}`);
				// An exited worker whose capture produced no candidate (empty or incomplete answer) is a transient failure, the
				// runtime analogue of a silent legacy turn; an exited worker with a candidate is decided, never retried.
				if (previous.outcome.kind === "exited" && previous.candidate) throw new Error("an exited runtime attempt with a candidate must be decided, not retried");
				if (previous.outcome.kind === "cancelled") throw new Error("a cancelled runtime attempt cannot be retried");
				if (operation.status !== "running") throw new Error(`cannot retry operation from ${operation.status}`);
				if (previous.candidateId) {
					const outstanding = this.outstandingIntegrationFor(previous.candidateId);
					if (outstanding) throw new Error(`runtime retry refused: the candidate's integration is ${outstanding.state}; roll it back first`);
				}
				error = previous.outcome.kind === "failed" ? previous.outcome.error
					: previous.outcome.kind === "interrupted" ? previous.outcome.reason
					: `runtime worker exited without a candidate (capture ${previous.observation?.captureStatus ?? "unrecorded"})`;
			} else {
				if (operation.status !== "pending") throw new Error(`cannot retry operation from ${operation.status} without an active attempt`);
				error = input.error?.trim() ?? "";
				if (!error) throw new Error("retrying an unlaunched runtime operation requires the launch failure text");
				// A launch failure is fenced to the identity that was dispatched; a replayed or stale report cannot spend the budget twice.
				if (!input.launched) throw new Error("retrying an unlaunched runtime operation requires the launched modelAttempt and transientAttempt");
				if (input.launched.modelAttempt !== operation.model_attempt || input.launched.transientAttempt !== operation.transient_attempts) throw new Error(`stale launch failure: operation is at model attempt ${operation.model_attempt}, transient attempt ${operation.transient_attempts}`);
			}

			const classification = classifyFailure(error);
			const policyFields = (modelAttempt: number, transientAttempt: number, retryReason: string, fallbackReason: string | null) =>
				this.policyEventContext(run.id, operation.node, modelAttempt, transientAttempt, retryReason, fallbackReason);
			if (classification.kind === "transient" && operation.transient_attempts < 3) {
				const attempt = operation.transient_attempts + 1;
				const retryReason = input.retryReason?.trim() || classification.reason;
				const delayMs = retryDelayMs(operation.transient_attempts, this.random);
				const notBefore = new Date(this.now().getTime() + delayMs).toISOString();
				supersede();
				this.db.query("UPDATE operations SET status='pending',agent_id=NULL,transient_attempts=?,classifier_reason=?,retry_reason=?,last_error=?,retry_not_before=?,started_at=NULL,finished_at=NULL WHERE id=?")
					.run(attempt, classification.reason, retryReason, error, notBefore, operation.id);
				const fields = policyFields(operation.model_attempt, attempt, retryReason, null);
				this.event({ runId: run.id, type: "retry", node: operation.node, operationId: operation.id, agentId: previous?.agentId ?? undefined, fromAgent: role, toAgent: role, replyTo: role, payload: { ...fields, attempt, delayMs, notBefore, classification: classification.reason, reasonCode: retryReason, error, previousAttemptKey: previous?.attemptKey ?? null, policy: fields } });
				const selectedModel = operation.selected_model ?? this.policy(run.id).routes.find((route) => route.role === role)?.chain[operation.model_attempt] ?? "";
				return result({ attempt, modelAttempt: operation.model_attempt, selectedModel, delayMs, notBefore }, classification.reason, false);
			}
			const fallback = classification.kind === "transient" ? this.modelFallbackFor(run.id, operation, error) : null;
			if (fallback?.advance) {
				const delayMs = retryDelayMs(0, this.random);
				const notBefore = new Date(this.now().getTime() + delayMs).toISOString();
				supersede();
				this.db.query("UPDATE operations SET status='pending',agent_id=NULL,model_attempt=?,selected_model=?,transient_attempts=0,classifier_reason=?,retry_reason=?,fallback_reason=?,last_error=?,retry_not_before=?,started_at=NULL,finished_at=NULL WHERE id=?")
					.run(fallback.attempt, fallback.model, classification.reason, classification.reason, fallback.fallbackReason, error, notBefore, operation.id);
				this.event({ runId: run.id, type: "model_fallback", node: operation.node, operationId: operation.id, agentId: previous?.agentId ?? undefined, fromAgent: "supervisor", toAgent: role, replyTo: "supervisor", payload: { ...policyFields(fallback.attempt, 0, classification.reason, fallback.fallbackReason), fromModelAttempt: operation.model_attempt, fromModel: operation.selected_model, reasonCode: fallback.fallbackReason, notBefore, previousAttemptKey: previous?.attemptKey ?? null } });
				return result({ attempt: 0, modelAttempt: fallback.attempt, selectedModel: fallback.model, delayMs, notBefore }, classification.reason, false);
			}
			this.db.query("UPDATE operations SET status='failed',classifier_reason=?,last_error=?,finished_at=? WHERE id=?").run(classification.reason, error, now, operation.id);
			if (previous?.agentId) this.db.query("UPDATE agents SET status='failed',last_activity_at=? WHERE id=?").run(now, previous.agentId);
			this.setState(run.id, state.currentNode, state.round, state.fixIteration, "awaiting_user");
			this.event({ runId: run.id, type: classification.kind === "transient" ? "retry_exhausted" : "operation_failed", node: operation.node, operationId: operation.id, agentId: previous?.agentId ?? undefined, fromAgent: role, toAgent: "user", replyTo: "user", payload: { ...policyFields(operation.model_attempt, operation.transient_attempts, classification.reason, null), classification: classification.reason, error, attemptKey: previous?.attemptKey ?? null } });
			return result(null, classification.reason, true);
		});
	}

	registerAgent(input: AgentRegistration): string {
		const transport = parseWorkerTransportKind(input.transport);
		if (transport === "herdr" && (!input.herdrAgent?.trim() || !input.tabId?.trim() || !input.herdrPaneId?.trim())) throw new Error("Herdr agent registration requires agent, tab, and pane identity");
		if (transport === "headless" && (input.herdrAgent !== undefined || input.tabId !== undefined || input.herdrPaneId !== undefined)) throw new Error("headless agent registration cannot contain Herdr identity");
		const acpxValues = [input.acpAgent, input.acpxRecordId, input.acpxSessionId, input.acpxState, input.acpxAttemptKey, input.agentFsSessionId, input.agentFsDbPath, input.acpxCancelScript];
		const hasAcpx = acpxValues.some((value) => value !== undefined);
		if (hasAcpx && acpxValues.some((value) => typeof value !== "string" || !value.trim())) {
			throw new Error("agent registration requires complete ACPX provenance");
		}
		if (hasAcpx) {
			parseAcpAgent(input.acpAgent);
			parseAcpxState(input.acpxState);
		}
		const id = input.id ?? `agent_${randomUUID()}`;
		const now = this.iso();
		this.transaction(() => {
			this.db
				.query(`INSERT INTO agents(id,run_id,name,node,role,transport,herdr_agent,tab_id,policy_digest,selected_model,model_attempt,acp_agent,acpx_record_id,acpx_session_id,acpx_state,acpx_attempt_key,agentfs_session_id,agentfs_db_path,herdr_pane_id,acpx_cancel_script,status,current_task,created_at,last_activity_at)
					VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
				.run(
					id,
					input.runId,
					input.name,
					input.node,
					input.role,
					transport,
					input.herdrAgent ?? null,
					input.tabId ?? null,
					input.policyDigest ?? null,
					input.selectedModel ?? null,
					input.modelAttempt ?? 0,
					input.acpAgent ?? null,
					input.acpxRecordId ?? null,
					input.acpxSessionId ?? null,
					input.acpxState ?? null,
					input.acpxAttemptKey ?? null,
					input.agentFsSessionId ?? null,
					input.agentFsDbPath ?? null,
					input.herdrPaneId ?? null,
					input.acpxCancelScript ?? null,
					"pending",
					input.currentTask,
					now,
					now,
				);
			this.event({ runId: input.runId, type: "agent_registered", node: input.node, agentId: id, toAgent: input.name, replyTo: input.name });
		});
		return id;
	}

	private allCurrentComplete(state: RunState): boolean {
		const row = this.db
			.query<CountRow, [string, string, number, number]>(
				"SELECT COUNT(*) AS count FROM operations WHERE run_id=? AND node=? AND round=? AND fix_iteration=? AND status!='completed'",
			)
			.get(state.runId, state.currentNode, state.round, state.fixIteration);
		return row?.count === 0;
	}

	private previousSlices(runId: string, round: number): SliceSpec[] {
		const maxFix = this.db
			.query<{ fix: number | null }, [string, number]>("SELECT MAX(fix_iteration) AS fix FROM operations WHERE run_id=? AND node='implement' AND round=?")
			.get(runId, round)?.fix;
		if (maxFix === null || maxFix === undefined) throw new Error("no implementation slices available for retry");
		return this.db
			.query<SliceRow, [string, number, number]>(
				"SELECT slice_id,task,owned_paths_json FROM operations WHERE run_id=? AND node='implement' AND round=? AND fix_iteration=? ORDER BY slice_id",
			)
			.all(runId, round, maxFix)
			.map((row, index) => ({
				id: row.slice_id ?? `slice-${index + 1}`,
				name: row.slice_id ?? `slice-${index + 1}`,
				task: row.task,
				ownedPaths: JSON.parse(row.owned_paths_json) as string[],
			}));
	}

	private createNextOperations(
		state: RunState,
		nextNode: NodeName,
		payload: Record<string, unknown> | undefined,
		round: number,
		fixIteration: number,
	): void {
		if (nextNode === "terminal") return;
		if (nextNode === "implement" || nextNode === "search") {
			let slices: SliceSpec[];
			if (state.currentNode === "thinker_plan" || state.currentNode === "thinker_split") {
				slices = slicesFromPayload(payload);
				if (nextNode === "implement") assertDisjointOwnership(slices);
				if (nextNode === "search") slices = slices.map((slice) => ({ ...slice, readOnly: true, ownedPaths: [] }));
			} else {
				slices = this.previousSlices(state.runId, state.round);
			}
			const feedback = typeof payload?.feedback === "string" ? payload.feedback : undefined;
			for (const slice of slices) {
				const task = feedback ? `${slice.task}\n\nRequired feedback:\n${feedback}` : slice.task;
				this.insertOperation(state.runId, nextNode, task, round, fixIteration, slice.id, slice.ownedPaths);
			}
			return;
		}
		const taskByNode: Partial<Record<NodeName, string>> = {
			review: "Review all current implementation outputs against the frozen thinker plan.",
			test: "Test the implementation against the frozen thinker plan and current reviewer comments.",
			audit: "Audit the evidence ledger and current accepted revision.",
			thinker_synthesize: "Synthesize every search report into one evidence-bearing answer.",
		};
		this.insertOperation(state.runId, nextNode, taskByNode[nextNode] ?? nextNode, round, fixIteration);
	}

	private setState(runId: string, currentNode: NodeName, round: number, fixIteration: number, status: RunStatus): void {
		const now = this.iso();
		this.db.query("UPDATE state SET current_node=?,round=?,fix_iteration=?,status=?,updated_at=? WHERE run_id=?").run(
			currentNode,
			round,
			fixIteration,
			status,
			now,
			runId,
		);
		this.db.query("UPDATE runs SET status=?,updated_at=? WHERE id=?").run(status, now, runId);
	}

	/** Returns the next frozen chain model for a transiently exhausted attempt, or a non-advancing decision at chain end. */
	private modelFallbackFor(runId: string, operation: OperationRow, error: string): ModelFallbackDecision {
		const policy = this.policy(runId);
		const route = policy.routes.find((candidate) => candidate.role === roleForNode(operation.node));
		if (!route) return { kind: "permanent", reason: "no-frozen-route", advance: false, attempt: operation.model_attempt, model: operation.selected_model ?? "", fallbackReason: null };
		return selectModelFallback(route.chain, operation.model_attempt, error, { exactLock: policy.input.kind === "model" });
	}

	/**
	 * The operator's cancel-all: every running operation of the current node is marked cancelled and the run
	 * leaves `active` for `cancelled` in one transaction. Worker processes are the caller's concern and are
	 * stopped before this is recorded; the reason names any that could not be confirmed stopped.
	 */
	cancelRunningOperations(runId: string, reason: string): { state: RunState; operations: OperationRow[] } {
		return this.transaction(() => {
			const state = this.getState(runId);
			if (state.status !== "active") throw new Error(`run ${runId} is ${state.status}; nothing to cancel`);
			const now = this.iso();
			const running = this.operations(runId, true).filter((operation) => operation.status === "running");
			for (const operation of running) {
				this.db.query("UPDATE operations SET status='cancelled',last_error=?,finished_at=? WHERE id=?").run(reason, now, operation.id);
				if (operation.agent_id) this.db.query("UPDATE agents SET status='cancelled',last_activity_at=? WHERE id=?").run(now, operation.agent_id);
				this.event({ runId, type: "operation_cancelled", node: operation.node, operationId: operation.id, toAgent: "user", replyTo: "user", payload: { reason } });
			}
			this.setState(runId, state.currentNode, state.round, state.fixIteration, "cancelled");
			this.event({ runId, type: "run_cancelled", node: state.currentNode, toAgent: "user", replyTo: "user", payload: { reason, operations: running.map((operation) => operation.id) } });
			return { state: this.getState(runId), operations: running.map((operation) => this.getOperation(operation.id)) };
		});
	}

	/** Records one operation transition and atomically advances the graph when its join is complete. */
	/** The only remaining record transition: cancellation of the current operation (report settlement was removed with legacy-v1). */
	record(input: RecordOperationInput): RecordOperationResult {
		return this.transaction(() => {
			if (input.status !== "cancelled") throw new Error(`unsupported record status ${input.status}: runtime attempts settle through collect and advance through decide`);
			const state = this.getState(input.runId);
			const operation = this.getOperation(input.operationId);
			if (operation.run_id !== input.runId) throw new Error("operation does not belong to run");
			if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) {
				throw new Error("operation is stale for current graph state");
			}
			if (state.status !== "active") throw new Error(`run ${input.runId} is ${state.status}; resolve it before recording operations`);
			const now = this.iso();
			this.db.query("UPDATE operations SET status='cancelled',last_error=?,finished_at=? WHERE id=?").run(input.error ?? null, now, operation.id);
			if (operation.agent_id) this.db.query("UPDATE agents SET status='cancelled',last_activity_at=? WHERE id=?").run(now, operation.agent_id);
			this.setState(input.runId, state.currentNode, state.round, state.fixIteration, "cancelled");
			this.event({ runId: input.runId, type: "operation_cancelled", node: operation.node, operationId: operation.id, toAgent: "user", replyTo: "user" });
			return { state: this.getState(input.runId), operation: this.getOperation(operation.id) };
		});
	}

	/** Completes one running operation and atomically advances the graph when its join is complete. Caller holds the transaction. */
	private completeOperation(state: RunState, operation: OperationRow, input: { verdict?: string; payload?: Record<string, unknown>; agentName?: string; settlingWhileParked: boolean }): RecordOperationResult {
		const now = this.iso();
		this.db
			.query("UPDATE operations SET status='completed',verdict=?,finished_at=?,retry_not_before=NULL WHERE id=?")
			.run(input.verdict?.toUpperCase() ?? null, now, operation.id);
		if (operation.agent_id) this.db.query("UPDATE agents SET status='completed',last_activity_at=? WHERE id=?").run(now, operation.agent_id);

		const allComplete = this.allCurrentComplete(state);
		const transition = decideTransition({ ...state, verdict: input.verdict, allComplete });
		this.event({
			runId: state.runId,
			type: "result",
			node: operation.node,
			operationId: operation.id,
			agentId: operation.agent_id ?? undefined,
			fromAgent: input.agentName ?? roleForNode(operation.node),
			toAgent: transition.replyTo,
			replyTo: transition.replyTo,
			fromNode: state.currentNode,
			toNode: transition.nextNode,
			verdict: input.verdict?.toUpperCase(),
			payload: { ...input.payload },
		});

		if (input.settlingWhileParked || transition.kind === "stay") return { state, operation: this.getOperation(operation.id) };
		if (transition.kind === "terminal") {
			this.setState(state.runId, "terminal", transition.round, transition.fixIteration, "terminal");
		} else if (transition.kind === "blocked") {
			this.setState(state.runId, state.currentNode, transition.round, transition.fixIteration, "blocked");
			this.event({
				runId: state.runId,
				type: "capsule",
				fromNode: state.currentNode,
				toAgent: "user",
				replyTo: "user",
				payload: { reason: transition.reason, round: transition.round, fixIteration: transition.fixIteration },
			});
		} else {
			this.setState(state.runId, transition.nextNode, transition.round, transition.fixIteration, "active");
			this.createNextOperations(state, transition.nextNode, input.payload, transition.round, transition.fixIteration);
		}
		this.event({
			runId: state.runId,
			type: "handoff",
			fromAgent: roleForNode(state.currentNode),
			toAgent: transition.replyTo,
			replyTo: transition.replyTo,
			fromNode: state.currentNode,
			toNode: transition.nextNode,
			payload: { reason: transition.reason, round: transition.round, fixIteration: transition.fixIteration },
		});
		return { state: this.getState(state.runId), operation: this.getOperation(operation.id) };
	}

	private projectAgent(row: AgentDbRow): AgentRow {
		const transport = parseWorkerTransportKind(row.transport);
		const presentationIdentity = transport === "headless"
			? headlessPresentationIdentity()
			: row.herdr_agent && row.tab_id && row.herdr_pane_id
				? herdrPresentationIdentity(row.herdr_agent, row.tab_id, row.herdr_pane_id)
				: null;
		return { ...row, transport, presentation_identity: presentationIdentity };
	}

	agents(runId?: string): AgentRow[] {
		const rows = runId
			? this.db.query<AgentDbRow, [string]>("SELECT * FROM agents WHERE run_id=? ORDER BY created_at,id").all(runId)
			: this.db.query<AgentDbRow, []>("SELECT * FROM agents ORDER BY created_at,id").all();
		return rows.map((row) => this.projectAgent(row));
	}

	events(runId: string, limit = 50, agent?: string): EventRow[] {
		if (agent) {
			return this.db
				.query<EventRow, [string, string, string, number]>(
					"SELECT * FROM events WHERE run_id=? AND (from_agent=? OR to_agent=?) ORDER BY id DESC LIMIT ?",
				)
				.all(runId, agent, agent, limit)
				.reverse();
		}
		return this.db.query<EventRow, [string, number]>("SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?").all(runId, limit).reverse();
	}

	/** Applies an explicit recovery choice to the current failed or blocked operation. */
	/** Applies defer, abort or escalate to the current failed or blocked operation; retry is the fenced runtime replacement. */
	resolveExhaustion(runId: string, operationId: string, decision: "defer" | "abort" | "escalate", deferredUntil?: string): RunState {
		return this.transaction(() => {
			if ((decision as string) === "retry") throw new Error("retry a runtime attempt with retryRuntimeAttempt");
			const state = this.getState(runId);
			if (state.status !== "awaiting_user" && state.status !== "deferred" && state.status !== "blocked") throw new Error("run is not awaiting a recovery decision");
			const operation = this.getOperation(operationId);
			if (operation.run_id !== runId) throw new Error("operation does not belong to run");
			if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) {
				throw new Error("operation is stale for current graph state");
			}
			if (state.status === "blocked" && operation.status !== "blocked") throw new Error("recovery requires an explicitly blocked operation");
			if (operation.status !== "blocked" && operation.status !== "failed") throw new Error("operation is not awaiting recovery");
			if (decision === "defer") {
				if (!deferredUntil) throw new Error("deferredUntil is required");
				this.setState(runId, operation.node, operation.round, operation.fix_iteration, "deferred");
				this.event({ runId, type: "deferral", node: operation.node, operationId, toAgent: roleForNode(operation.node), replyTo: roleForNode(operation.node), payload: { deferredUntil } });
			} else {
				const status: RunStatus = decision === "abort" ? "cancelled" : "blocked";
				const operationStatus: OperationStatus = decision === "abort" ? "cancelled" : "blocked";
				this.db.query("UPDATE operations SET status=?,finished_at=? WHERE id=?").run(operationStatus, this.iso(), operationId);
				this.setState(runId, operation.node, operation.round, operation.fix_iteration, status);
				this.event({ runId, type: decision, node: operation.node, operationId, toAgent: "user", replyTo: "user" });
			}
			return this.getState(runId);
		});
	}

	/** Retains a private post-mortem bundle beside the graph database for a run whose worker never registered. */
	retainRunDiagnostic(runId: string, name: string, payload: Record<string, unknown>): string {
		const path = join(dirname(this.dbPath), "failures", runId, name);
		ensurePrivatePath(path);
		writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return path;
	}

	prune(days: number): number {
		if (!Number.isFinite(days) || days < 0) throw new Error("days must be non-negative");
		const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
		const rows = this.db
			.query<{ id: string }, [string]>("SELECT id FROM runs WHERE status IN ('terminal','blocked','cancelled') AND updated_at < ?")
			.all(cutoff);
		this.transaction(() => {
			for (const row of rows) this.db.query("DELETE FROM runs WHERE id=?").run(row.id);
		});
		return rows.length;
	}

	close(): void {
		this.db.close();
	}
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberOr(value: unknown): number | null { return typeof value === "number" ? value : null; }
function stringOr(value: unknown): string | null { return typeof value === "string" ? value : null; }
