import { Database } from "./sqlite.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { decideTransition, graphDefinition } from "./graph-core.ts";
import { classifyFailure, retryDelayMs, selectModelFallback, type ModelFallbackDecision } from "./retry.ts";
import { parseAcpAgent, parseAcpxState, type AcpAgent, type AcpxState } from "./lib/acpx-types.ts";
import { headlessPresentationIdentity, herdrPresentationIdentity, parseWorkerTransportKind, type WorkerPresentationIdentity, type WorkerTransportKind } from "./lib/worker-transport.ts";
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
	reportPath?: string;
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
				report_path TEXT,
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
	}

	private schemaVersion(): number {
		const row = this.db.query<{ version: number | null }, []>("SELECT MAX(version) AS version FROM schema_version").get();
		return row?.version ?? 0;
	}

	private hasColumn(table: "runs" | "agents" | "operations", column: string): boolean {
		return this.db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.some((row) => row.name === column);
	}

	private ensureColumn(table: "runs" | "agents" | "operations", column: string, definition: string): void {
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
		const version = (this.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
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
				for (const item of commands) this.insertOperation(runId, definition.initialNode, item.name, 1, 0, item.id, item.ownedPaths, item.command);
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
	next(runId: string): { state: RunState; operations: (OperationRow & { route?: PolicyRoute })[]; policy: FrozenPolicy } {
		const policy = this.policy(runId);
		const operations = this.operations(runId, true).map((operation) => ({
			...operation,
			route: policy.routes.find((route) => route.role === roleForNode(operation.node)),
		}));
		return { state: this.getState(runId), operations, policy };
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

	/** Records one operation transition and atomically advances the graph when its join is complete. */
	record(input: RecordOperationInput): RecordOperationResult {
		return this.transaction(() => {
			const state = this.getState(input.runId);
			if (state.status !== "active") throw new Error(`run ${input.runId} is ${state.status}; resolve it before recording operations`);
			const operation = this.getOperation(input.operationId);
			if (operation.run_id !== input.runId) throw new Error("operation does not belong to run");
			if (operation.node !== state.currentNode || operation.round !== state.round || operation.fix_iteration !== state.fixIteration) {
				throw new Error("operation is stale for current graph state");
			}
			const now = this.iso();

			if (input.status === "running") {
				if (operation.status !== "pending" && operation.status !== "running") throw new Error(`cannot run operation from ${operation.status}`);
				if (input.transport === undefined) throw new Error("running operation requires worker transport");
				parseWorkerTransportKind(input.transport);
				this.assertDispatchPolicy(input.runId, operation, input);
				const modelAttempt = input.modelAttempt ?? operation.model_attempt;
				const advancedModel = modelAttempt > operation.model_attempt;
				const retryAttempt = advancedModel ? 0 : operation.transient_attempts;
				const policyFields = this.policyEventContext(
					input.runId,
					operation.node,
					modelAttempt,
					retryAttempt,
					input.retryReason ?? operation.retry_reason,
					input.fallbackReason ?? null,
				);
				const selectedModel = (policyFields.selectedModel as string | null) ?? input.selectedModel ?? null;
				this.db
					.query("UPDATE operations SET status='running',agent_id=COALESCE(?,agent_id),started_at=COALESCE(started_at,?),model_attempt=?,selected_model=?,transient_attempts=?,retry_reason=?,fallback_reason=? WHERE id=?")
					.run(
						input.agentId ?? null,
						now,
						modelAttempt,
						selectedModel,
						retryAttempt,
						input.retryReason ?? operation.retry_reason,
						input.fallbackReason ?? null,
						operation.id,
					);
				if (input.agentId) {
					this.db
						.query("UPDATE agents SET status='running',policy_digest=?,selected_model=?,model_attempt=?,last_activity_at=? WHERE id=?")
						.run(this.policy(input.runId).digest, selectedModel, modelAttempt, now, input.agentId);
				}
				if (advancedModel) {
					this.event({
						runId: input.runId,
						type: "model_fallback",
						node: operation.node,
						operationId: operation.id,
						agentId: input.agentId,
						fromAgent: "supervisor",
						toAgent: input.agentName ?? roleForNode(operation.node),
						replyTo: "supervisor",
						payload: {
							...policyFields,
							fromModelAttempt: operation.model_attempt,
							fromModel: operation.selected_model,
							reasonCode: input.fallbackReason,
						},
					});
				}
				this.event({
					runId: input.runId,
					type: "model_selected",
					node: operation.node,
					operationId: operation.id,
					agentId: input.agentId,
					fromAgent: "supervisor",
					toAgent: input.agentName ?? roleForNode(operation.node),
					replyTo: "supervisor",
					payload: policyFields,
				});
				this.event({
					runId: input.runId,
					type: "operation_running",
					node: operation.node,
					operationId: operation.id,
					agentId: input.agentId,
					fromAgent: "supervisor",
					toAgent: input.agentName ?? roleForNode(operation.node),
					replyTo: "supervisor",
					payload: { task: operation.task, transport: input.transport, ...policyFields, policy: policyFields },
				});
				return { state, operation: this.getOperation(operation.id) };
			}

			if (input.status === "failed" && input.error) {
				const classification = classifyFailure(input.error);
				if (classification.kind === "transient" && operation.transient_attempts < 3) {
					const attempt = operation.transient_attempts + 1;
					const retryReason = input.retryReason?.trim() || classification.reason;
					const delayMs = retryDelayMs(operation.transient_attempts, this.random);
					const notBefore = new Date(this.now().getTime() + delayMs).toISOString();
					this.db
						.query("UPDATE operations SET status='running',transient_attempts=?,classifier_reason=?,retry_reason=?,last_error=?,retry_not_before=? WHERE id=?")
						.run(attempt, classification.reason, retryReason, input.error, notBefore, operation.id);
					if (operation.agent_id) this.db.query("UPDATE agents SET status='failed',last_activity_at=? WHERE id=?").run(now, operation.agent_id);
					const policyFields = this.policyEventContext(
						input.runId,
						operation.node,
						operation.model_attempt,
						attempt,
						retryReason,
						null,
					);
					this.event({
						runId: input.runId,
						type: "retry",
						node: operation.node,
						operationId: operation.id,
						agentId: input.agentId,
						fromAgent: input.agentName ?? roleForNode(operation.node),
						toAgent: input.agentName ?? roleForNode(operation.node),
						replyTo: input.agentName ?? roleForNode(operation.node),
						payload: {
							...policyFields,
							attempt,
							delayMs,
							notBefore,
							classification: classification.reason,
							reasonCode: retryReason,
							error: input.error,
							policy: policyFields,
						},
					});
					return {
						state,
						operation: this.getOperation(operation.id),
						retry: { attempt, modelAttempt: operation.model_attempt, selectedModel: operation.selected_model, delayMs, notBefore },
					};
				}
				const fallback = classification.kind === "transient"
					? this.modelFallbackFor(input.runId, operation, input.error)
					: null;
				if (fallback?.advance) {
					const delayMs = retryDelayMs(0, this.random);
					const notBefore = new Date(this.now().getTime() + delayMs).toISOString();
					this.db
						.query("UPDATE operations SET status='running',model_attempt=?,selected_model=?,transient_attempts=0,classifier_reason=?,retry_reason=?,fallback_reason=?,last_error=?,retry_not_before=?,finished_at=NULL WHERE id=?")
						.run(fallback.attempt, fallback.model, classification.reason, classification.reason, fallback.fallbackReason, input.error, notBefore, operation.id);
					if (operation.agent_id) this.db.query("UPDATE agents SET status='failed',last_activity_at=? WHERE id=?").run(now, operation.agent_id);
					this.event({
						runId: input.runId,
						type: "model_fallback",
						node: operation.node,
						operationId: operation.id,
						agentId: input.agentId,
						fromAgent: "supervisor",
						toAgent: input.agentName ?? roleForNode(operation.node),
						replyTo: "supervisor",
						payload: {
							...this.policyEventContext(input.runId, operation.node, fallback.attempt, 0, classification.reason, fallback.fallbackReason),
							fromModelAttempt: operation.model_attempt,
							fromModel: operation.selected_model,
							reasonCode: fallback.fallbackReason,
							notBefore,
						},
					});
					return {
						state,
						operation: this.getOperation(operation.id),
						retry: { attempt: 0, modelAttempt: fallback.attempt, selectedModel: fallback.model, delayMs, notBefore },
					};
				}
				this.db
					.query("UPDATE operations SET status='failed',classifier_reason=?,last_error=?,finished_at=? WHERE id=?")
					.run(classification.reason, input.error, now, operation.id);
				if (operation.agent_id) this.db.query("UPDATE agents SET status='failed',last_activity_at=? WHERE id=?").run(now, operation.agent_id);
				this.setState(input.runId, state.currentNode, state.round, state.fixIteration, "awaiting_user");
				this.event({
					runId: input.runId,
					type: classification.kind === "transient" ? "retry_exhausted" : "operation_failed",
					node: operation.node,
					operationId: operation.id,
					agentId: input.agentId,
					fromAgent: input.agentName ?? roleForNode(operation.node),
					toAgent: "user",
					replyTo: "user",
					payload: { classification: classification.reason, error: input.error },
				});
				return { state: this.getState(input.runId), operation: this.getOperation(operation.id), requiresUserDecision: true };
			}

			if (input.status === "blocked" || input.status === "cancelled") {
				this.db.query("UPDATE operations SET status=?,last_error=?,report_path=?,verdict=?,finished_at=? WHERE id=?").run(
					input.status,
					input.error ?? null,
					input.reportPath ?? null,
					input.verdict?.toUpperCase() ?? null,
					now,
					operation.id,
				);
				const runStatus: RunStatus = input.status === "blocked" ? "blocked" : "cancelled";
				if (operation.agent_id) this.db.query("UPDATE agents SET status=?,last_activity_at=? WHERE id=?").run(input.status === "blocked" ? "failed" : "cancelled", now, operation.agent_id);
				this.setState(input.runId, state.currentNode, state.round, state.fixIteration, runStatus);
				this.event({ runId: input.runId, type: `operation_${input.status}`, node: operation.node, operationId: operation.id, toAgent: "user", replyTo: "user" });
				return { state: this.getState(input.runId), operation: this.getOperation(operation.id) };
			}

			if (input.status !== "completed") throw new Error(`unsupported record status ${input.status}`);
			if (operation.status !== "running") throw new Error(`cannot complete operation from ${operation.status}`);
			this.db
				.query("UPDATE operations SET status='completed',report_path=?,verdict=?,finished_at=?,retry_not_before=NULL WHERE id=?")
				.run(input.reportPath ?? null, input.verdict?.toUpperCase() ?? null, now, operation.id);
			if (operation.agent_id) this.db.query("UPDATE agents SET status='completed',last_activity_at=? WHERE id=?").run(now, operation.agent_id);

			const allComplete = this.allCurrentComplete(state);
			const transition = decideTransition({ ...state, verdict: input.verdict, allComplete });
			this.event({
				runId: input.runId,
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
				payload: { reportPath: input.reportPath ?? null, ...input.payload },
			});

			if (transition.kind === "stay") return { state, operation: this.getOperation(operation.id) };
			if (transition.kind === "terminal") {
				this.setState(input.runId, "terminal", transition.round, transition.fixIteration, "terminal");
			} else if (transition.kind === "blocked") {
				this.setState(input.runId, state.currentNode, transition.round, transition.fixIteration, "blocked");
				this.event({
					runId: input.runId,
					type: "capsule",
					fromNode: state.currentNode,
					toAgent: "user",
					replyTo: "user",
					payload: { reason: transition.reason, round: transition.round, fixIteration: transition.fixIteration },
				});
			} else {
				this.setState(input.runId, transition.nextNode, transition.round, transition.fixIteration, "active");
				this.createNextOperations(state, transition.nextNode, input.payload, transition.round, transition.fixIteration);
			}
			this.event({
				runId: input.runId,
				type: "handoff",
				fromAgent: roleForNode(state.currentNode),
				toAgent: transition.replyTo,
				replyTo: transition.replyTo,
				fromNode: state.currentNode,
				toNode: transition.nextNode,
				payload: { reason: transition.reason, round: transition.round, fixIteration: transition.fixIteration },
			});
			return { state: this.getState(input.runId), operation: this.getOperation(operation.id) };
		});
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

	/** Applies the user's post-exhaustion choice without inventing a new operation. */
	resolveExhaustion(runId: string, operationId: string, decision: "retry" | "defer" | "abort" | "escalate", deferredUntil?: string): RunState {
		return this.transaction(() => {
			const state = this.getState(runId);
			if (state.status !== "awaiting_user" && state.status !== "deferred") throw new Error("run is not awaiting a recovery decision");
			const operation = this.getOperation(operationId);
			if (decision === "retry") {
				this.db
					.query("UPDATE operations SET status='pending',transient_attempts=0,classifier_reason=NULL,last_error=NULL,retry_not_before=NULL,started_at=NULL,finished_at=NULL WHERE id=?")
					.run(operationId);
				this.setState(runId, operation.node, operation.round, operation.fix_iteration, "active");
				this.event({ runId, type: "resume", node: operation.node, operationId, toAgent: roleForNode(operation.node), replyTo: roleForNode(operation.node) });
			} else if (decision === "defer") {
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
