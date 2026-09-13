#!/usr/bin/env -S node --experimental-strip-types
/**
 * Matched live measurement of the two result contracts on the real research graph or the real build graph.
 *
 * Default and --dry-run print the plan and start nothing. --preflight checks executables, loopback
 * binding and the selected provider credential without dispatching. Only --execute spends provider
 * credits: it drives the production delegate_graph tool, with real ACPX/AgentFS workers on the Pi
 * adapter, through the same task N times, and records
 * monotonic phase durations, attempts, retries, fallbacks and outcomes. The driver acts as the
 * supervisor: it supplies fixed fan-out slices, integrates a runtime coding candidate through
 * op=integrate before deciding it, reads review/test/audit verdicts from the worker (the final
 * VERDICT: line of the answer) and accepts every exited candidate automatically, which it records as such. Nothing here is independent
 * review, a quality benchmark, or product activation: the adapter is enabled only in a temporary store.
 */
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { RuntimeContentStore } from "../../lib/runtime-content.ts";
import { parseRuntimeStagingManifest } from "../../lib/runtime-staging.ts";

const PACKAGE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPO = resolve(PACKAGE, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: string): string => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const mode = flag("--execute") ? "execute" : flag("--preflight") ? "preflight" : "dry-run";
const graph = option("--graph", "research") as "research" | "build" | "operations";
if (graph !== "research" && graph !== "build" && graph !== "operations") throw new Error("--graph must be research, build or operations");
const model = option("--model", "alibaba/qwen3.8-flash");
const repeats = Number.parseInt(option("--repeats", "1"), 10);
const contracts = ["runtime-v1"] as const;
const evidenceDir = resolve(option("--evidence-dir", join(REPO, "agent-output", `runtime-measure-${new Date().toISOString().slice(0, 10)}`)));
const runTimeoutMs = Number.parseInt(option("--run-timeout-ms", String((graph === "build" ? 40 : 20) * 60_000)), 10);
/** The adapter the model routes to; its credential store is preflighted. */
const adapter = model.startsWith("openai-codex/") ? "codex" : model.startsWith("claude-code/") ? "claude" : "pi";
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");

const RESEARCH_TASK = "research: determine where cache invalidation is triggered in this repository, which module owns the cache, and whether invalidation can be skipped. Cite file paths for every claim.";
const BUILD_TASK = "implement: the admin bulk import in src/import.ts writes rows without invalidating the cache in src/cache.ts. Make bulkImport invalidate the cache for every imported key, keeping its signature and existing behaviour otherwise. Only src/import.ts may change.";
const OPERATIONS_TASK = "operations: run the supplied fixture source command exactly as given, then report what the checkpoint and results files record. Cite file paths for every claim.";
const TASK = graph === "build" ? BUILD_TASK : graph === "operations" ? OPERATIONS_TASK : RESEARCH_TASK;
const RESEARCH_SLICES = [
	{ id: "cache-owner", name: "cache-owner", task: "Identify the file and functions that implement the cache. Cite the exact file path and function names as evidence.", ownedPaths: [] as string[] },
	{ id: "invalidation-trigger", name: "invalidation-trigger", task: "Identify every place that triggers cache invalidation and whether any path skips it. Cite file paths and the relevant lines as evidence.", ownedPaths: [] as string[] },
];
/** Build slices own absolute repository paths; they are bound to the temporary corpus per run. */
const buildSlices = (repo: string) => [
	{ id: "import-invalidation", name: "import-invalidation", task: "Edit src/import.ts so that bulkImport calls invalidate(key) from ./cache.ts for every imported key after writing it to target. Keep the exported signature unchanged and do not modify any other file. Reply with the exact diff you applied.", ownedPaths: [join(repo, "src", "import.ts")] },
];
/** Operations: one fixture source command whose script writes a checkpoint and a results file into its owned directory. */
const operationsCommands = (repo: string) => [{ id: "fixture-source", name: "Fixture source", command: { executable: "node", args: ["search.mjs", "--source", "fixture-source"], cwd: repo }, ownedPaths: [join(repo, "runs", "fixture-source")], checkpoint: "runs/fixture-source/checkpoint.json" }];
const SLICE_IDS = graph === "build" ? buildSlices("/corpus").map((slice) => slice.id) : graph === "operations" ? operationsCommands("/corpus").map((item) => item.id) : RESEARCH_SLICES.map((slice) => slice.id);
const PLAN_NODE = graph === "build" ? "thinker_plan" : graph === "operations" ? "none" : "thinker_split";
/** Verdicts the driver reads from the worker; the planner and implementer verdicts are fixed by the graph contract. */
const VERDICT_NODES: Record<string, readonly string[]> = { review: ["PASS", "FAIL"], test: ["GREEN", "NOT_OK"], audit: ["PASS", "FAIL"], source_search: ["DONE", "BLOCKED"] };
const FIXED_VERDICTS: Record<string, string> = { thinker_plan: "READY", thinker_split: "READY", implement: "DONE", search: "DONE", thinker_synthesize: "DONE" };
const plan = {
	mode, model, adapter, contracts, repeats, graph, task: TASK, slices: SLICE_IDS, workerTurnsPerRun: graph === "build" ? 1 + SLICE_IDS.length + 3 : graph === "operations" ? SLICE_IDS.length + 2 : 1 + SLICE_IDS.length + 1,
	runTimeoutMs, evidenceDir, spend: "provider-priced; no dollar estimate; usage is not reported by the worker path", activation: "runs in a temporary DELEGATE_GRAPH_DB; the real Pi installation is not modified",
	acceptance: "runtime-v1 candidates are accepted automatically by the driver; this is not independent review",
	verdicts: "review, test and audit verdicts are read from the final VERDICT: line of the worker's answer; a FAIL or NOT_OK follows the graph edge back to implementation",
	integration: graph === "build" ? "a runtime coding candidate with staged changes is applied with op=integrate before op=decide; the launcher never writes the host tree at settlement" : graph === "operations" ? "a runtime operational candidate's staged owned artifacts (checkpoint, results) are placed with op=integrate before op=decide; the checkpoint is observed at settlement" : "none: research candidates carry no file changes",
};
console.log(JSON.stringify(plan, null, 2));
if (mode === "dry-run") process.exit(0);

const blockers: string[] = [];
for (const executable of ["node", "acpx", "agentfs", "pi", "git"]) if (spawnSync("sh", ["-c", `command -v ${executable}`], { encoding: "utf8" }).status !== 0) blockers.push(`missing executable: ${executable}`);
await new Promise<void>((done) => { const server = createServer(); server.once("error", (error: NodeJS.ErrnoException) => { blockers.push(`AgentFS loopback prerequisite unavailable: ${error.code}`); done(); }); server.listen(0, "127.0.0.1", () => server.close(() => done())); });
const provider = model.split("/")[0];
if (adapter === "pi") {
	const credential = spawnSync("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"], { encoding: "utf8" });
	try { if (credential.status !== 0 || JSON.parse(credential.stdout.trim().split("\n").at(-1) ?? "{}").status !== "ready") blockers.push(`provider ${provider} credential is not ready`); } catch { blockers.push(`provider ${provider} credential check returned no JSON`); }
} else if (adapter === "codex") {
	const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
	if (!existsSync(join(home, "auth.json"))) blockers.push(`Codex credential store ${join(home, "auth.json")} is missing`);
} else if (!process.env.PI_CLAUDE_OAUTH_TOKEN_FILE || !existsSync(process.env.PI_CLAUDE_OAUTH_TOKEN_FILE)) blockers.push("PI_CLAUDE_OAUTH_TOKEN_FILE must name an existing token file for a Claude run");
if (blockers.length) { console.log(JSON.stringify({ blocked: blockers, workersStarted: 0 })); process.exit(1); }
if (mode === "preflight") { console.log(JSON.stringify({ prerequisitesAvailable: true, workersStarted: 0 })); process.exit(0); }

// ---- execute -------------------------------------------------------------------------------------
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 }); chmodSync(evidenceDir, 0o700);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => performance.now();
interface Timed { readonly kind: string; readonly operationId: string | null; readonly node: string | null; readonly ms: number; readonly detail: Record<string, unknown> }
interface RunRecord {
	contract: string; repeat: number; runId: string | null; startedAt: string; finishedAt: string | null; totalMs: number | null; finalStatus: string | null; terminal: boolean;
	dispatches: number; collects: number; completions: number; retries: number; modelFallbacks: number; parked: boolean; failures: string[]; phases: Timed[]; operations: Record<string, unknown>[];
	privateRunDirs: string[]; progress: { kind: string; at: number; details: Record<string, unknown> }[]; ledgerPath: string | null; error: string | null;
	verdicts: { operationId: string; node: string; verdict: string | null; source: string; answerExcerpt: string | null }[]; integrations: { operationId: string; state: string; changes: number }[];
	watchSamples: { at: number; agents: { agentName: string | null; node: string; processState: string | null; toolCalls: number; lastActivity: string | null }[] }[];
	workspace: { status: string; diff: string } | null;
}

function corpus(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true }); mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# widget-service\n\nA small service with an in-memory cache. See docs/design.md.\n");
	writeFileSync(join(dir, "docs", "design.md"), "# Design\n\nThe cache lives in src/cache.ts. Writes go through src/store.ts, which must invalidate. The admin bulk import in src/import.ts bypasses the store.\n");
	writeFileSync(join(dir, "src", "cache.ts"), "const entries = new Map<string, string>();\nexport function get(key: string): string | undefined { return entries.get(key); }\nexport function put(key: string, value: string): void { entries.set(key, value); }\nexport function invalidate(key: string): void { entries.delete(key); }\nexport function clear(): void { entries.clear(); }\n");
	writeFileSync(join(dir, "src", "store.ts"), "import { invalidate, put } from \"./cache.ts\";\nconst rows = new Map<string, string>();\nexport function save(key: string, value: string): void {\n  rows.set(key, value);\n  invalidate(key); // every save invalidates before the next read repopulates\n}\nexport function load(key: string): string | undefined {\n  const value = rows.get(key);\n  if (value !== undefined) put(key, value);\n  return value;\n}\n");
	writeFileSync(join(dir, "src", "import.ts"), "// Bulk import used by the admin CLI. NOTE: writes rows directly and never calls cache.invalidate.\nexport function bulkImport(rows: Map<string, string>, target: Map<string, string>): void {\n  for (const [key, value] of rows) target.set(key, value);\n}\n");
	const git = (...argv: string[]) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" });
	git("init", "-q"); git("add", "."); git("-c", "user.name=measure", "-c", "user.email=measure@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "corpus");
}

function operationsCorpus(dir: string): void {
	mkdirSync(join(dir, "runs", "fixture-source"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# fixture-source\n\nsearch.mjs is the source command. It writes runs/<source>/checkpoint.json and runs/<source>/results.json.\n");
	writeFileSync(join(dir, "search.mjs"), [
		"import { mkdirSync, writeFileSync } from \"node:fs\";",
		"import { join } from \"node:path\";",
		"const source = process.argv[process.argv.indexOf(\"--source\") + 1] ?? \"fixture-source\";",
		"const dir = join(process.cwd(), \"runs\", source); mkdirSync(dir, { recursive: true });",
		"const results = [{ id: \"job-1\", title: \"Fixture role A\" }, { id: \"job-2\", title: \"Fixture role B\" }];",
		"writeFileSync(join(dir, \"results.json\"), JSON.stringify(results, null, 2) + \"\\n\");",
		"writeFileSync(join(dir, \"checkpoint.json\"), JSON.stringify({ source, jobsSaved: results.length, status: \"completed\", runId: `${source}-1` }, null, 2) + \"\\n\");",
		"console.log(JSON.stringify({ source, jobsSaved: results.length, status: \"completed\" }));",
	].join("\n") + "\n");
}

function workspaceState(dir: string): { status: string; diff: string } {
	const git = (...argv: string[]) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" }).stdout;
	return { status: git("status", "--porcelain"), diff: git("diff", "--", "src/import.ts").slice(0, 8192) };
}

/** The final `VERDICT: <value>` line of a runtime answer, or null when the worker did not state one. */
export function verdictFromAnswer(answer: string, allowed: readonly string[]): string | null {
	const matches = [...answer.matchAll(/^\s*\**\s*VERDICT\s*:\s*\**\s*([A-Z_]+)\s*\**\s*$/gm)];
	const last = matches.at(-1)?.[1] ?? null;
	return last && allowed.includes(last) ? last : null;
}

function exec(command: string, argv: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
	return new Promise((done) => {
		execFile(command, argv, { cwd: options?.cwd, env: process.env, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: unknown }).code) : error ? 1 : 0;
			done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), killed: false });
		});
	});
}

async function loadTool(dbPath: string): Promise<{ execute: (params: Record<string, unknown>, onUpdate: (update: unknown) => void, ctx: unknown) => Promise<unknown> }> {
	process.env.DELEGATE_GRAPH_DB = dbPath;
	delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
	const { default: extension } = await import(`../../index.ts?measure=${Date.now()}-${Math.random()}`);
	let tool: { execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: (update: unknown) => void, ctx: unknown) => Promise<unknown> } | undefined;
	extension({ registerCommand() {}, registerTool(definition: typeof tool) { tool = definition; }, exec, sendUserMessage() {} });
	if (!tool) throw new Error("delegate_graph tool did not register");
	const registered = tool;
	return { execute: (params, onUpdate, ctx) => registered.execute("measure", params, undefined, onUpdate, ctx) };
}

function readContent(dbPath: string, reference: { sha256: string; bytes: number }): string {
	const content = new RuntimeContentStore(dbPath);
	return content.read(reference, 16 * 1024 * 1024).toString("utf8");
}

function parsed(result: unknown): Record<string, any> {
	const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
	try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function measureRun(contract: "runtime-v1", repeat: number): Promise<RunRecord> {
	const record: RunRecord = { contract, repeat, runId: null, startedAt: new Date().toISOString(), finishedAt: null, totalMs: null, finalStatus: null, terminal: false, dispatches: 0, collects: 0, completions: 0, retries: 0, modelFallbacks: 0, parked: false, failures: [], phases: [], operations: [], privateRunDirs: [], progress: [], ledgerPath: null, error: null, verdicts: [], integrations: [], workspace: null, watchSamples: [] };
	const root = mkdtempSync(join(tmpdir(), `pi-wave-measure-${contract}-`));
	const repo = join(root, "repo"); mkdirSync(repo); if (graph === "operations") operationsCorpus(repo); else corpus(repo);
	const slices = graph === "build" ? buildSlices(repo) : RESEARCH_SLICES;
	const dbPath = join(root, "graph.db");
	const started = now();
	const ctx = { mode: "headless", cwd: repo, ui: { notify() {} } };
	const progress = (update: unknown) => { const value = parsed(update); record.progress.push({ kind: String(value.kind), at: Math.round(now() - started), details: value }); };
	const timed = async (kind: string, operationId: string | null, node: string | null, work: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
		const t0 = now(); const value = await work(); const ms = now() - t0;
		record.phases.push({ kind, operationId, node, ms: Math.round(ms), detail: { error: value.error ?? null, status: value.state?.status ?? value.status ?? null } });
		return value;
	};
	try {
		const tool = await loadTool(dbPath);
		const init = await timed("init", null, null, () => tool.execute({ op: "init", story: `measure-${graph}-${contract}-${repeat}`, graph, task: TASK, modelPolicy: { kind: "model", model, reason: "matched live measurement" }, ...(graph === "operations" ? { commands: operationsCommands(repo) } : {}) }, progress, ctx).then(parsed));
		if (init.error) throw new Error(`init failed: ${init.error}`);
		const runId: string = init.state.runId; record.runId = runId;
		for (let iteration = 0; iteration < 60; iteration += 1) {
			if (now() - started > runTimeoutMs) throw new Error(`run exceeded ${runTimeoutMs} ms`);
			// A supervisor error that repeats on the same operation is a driver or product defect, never progress; stop instead of spinning.
			const repeated = record.failures.filter((item) => /^(decide|integrate|verdict|collect): /.test(item));
			if (repeated.length >= 3 && repeated.slice(-3).every((item) => item === repeated.at(-1))) throw new Error(`repeated supervisor failure: ${repeated.at(-1)}`);
			const next = parsed(await tool.execute({ op: "next", runId }, progress, ctx));
			if (next.error) throw new Error(`next failed: ${next.error}`);
			record.finalStatus = next.state.status;
			if (next.state.status !== "active") { record.parked = next.state.status === "awaiting_user"; record.terminal = next.state.status === "terminal"; break; }
			const operations: Record<string, any>[] = next.operations;
			const pending = operations.filter((operation) => operation.status === "pending");
			const running = operations.filter((operation) => operation.status === "running");
			if (!pending.length && !running.length) throw new Error("active run with nothing pending or running");
			for (const operation of pending) {
				if (operation.retry_not_before) { const wait = Date.parse(operation.retry_not_before) - Date.now(); if (wait > 0) { record.phases.push({ kind: "backoff", operationId: operation.id, node: operation.node, ms: wait, detail: {} }); await sleep(wait); } }
				const dispatched = await timed("dispatch", operation.id, operation.node, () => tool.execute({ op: "dispatch", runId, operationId: operation.id, transport: "headless" }, progress, ctx).then(parsed));
				if (dispatched.error) throw new Error(`dispatch failed: ${dispatched.error}`);
				record.dispatches += 1;
				if (dispatched.dispatched === false) { record.failures.push(`preflight: ${dispatched.reason}`); if (dispatched.retry) record.retries += 1; continue; }
				if (dispatched.launch && typeof dispatched.launch["acpx-cancel-script"] === "string") { const dir = resolve(dispatched.launch["acpx-cancel-script"], "..", "..", ".."); if (!record.privateRunDirs.includes(dir)) record.privateRunDirs.push(dir); }
				running.push({ ...operation, status: "running" });
			}
			// While workers run, sample the read-only watch view every 20 s: this is the evidence that the pane rendering and the summary line work on a real stream.
			const watcher = setInterval(async () => {
				try {
					const view = parsed(await tool.execute({ op: "watch", runId }, () => {}, ctx));
					if (record.watchSamples.length < 30 && Array.isArray(view.agents)) record.watchSamples.push({ at: Math.round(now() - started), agents: view.agents.map((agent: Record<string, any>) => ({ agentName: agent.agentName, node: agent.node, processState: agent.processState, toolCalls: agent.toolCalls, lastActivity: agent.lastActivity })) });
				} catch { /* sampling only */ }
			}, 20_000);
			await Promise.all(running.map(async (operation) => {
				const collected = await timed("collect", operation.id, operation.node, () => tool.execute({ op: "collect", runId, operationId: operation.id }, progress, ctx).then(parsed));
				record.collects += 1;
				if (collected.error) { record.failures.push(`collect: ${collected.error}`); return; }
				const slicePayload = operation.node === PLAN_NODE ? { slices } : {};
				const attempt = collected.attempt;
				if (collected.captureRetainedPath) record.failures.push(`capture retained: ${collected.captureRetainedPath}`);
				if (attempt.processState === "exited" && attempt.candidate) {
					let verdict: string | undefined = FIXED_VERDICTS[operation.node];
					if (VERDICT_NODES[operation.node]) {
						const answerText = attempt.candidate?.answer ? readContent(dbPath, attempt.candidate.answer) : "";
						const read = verdictFromAnswer(answerText, VERDICT_NODES[operation.node]);
						record.verdicts.push({ operationId: operation.id, node: operation.node, verdict: read, source: "runtime answer VERDICT line", answerExcerpt: answerText.slice(0, 6000) });
						if (!read) { record.failures.push(`verdict: ${operation.node} answer states no readable VERDICT line`); return; }
						verdict = read;
					}
					if ((attempt.candidate?.kind === "coding" || attempt.candidate?.kind === "operational") && attempt.observation?.manifest) {
						const manifest = parseRuntimeStagingManifest(JSON.parse(readContent(dbPath, attempt.observation.manifest)));
						if (manifest.changes.length > 0) {
							const integrated = await timed("integrate", operation.id, operation.node, () => tool.execute({ op: "integrate", runId, operationId: operation.id }, progress, ctx).then(parsed));
							if (integrated.error) { record.failures.push(`integrate: ${integrated.error}`); return; }
							record.integrations.push({ operationId: operation.id, state: integrated.integration?.state ?? "unknown", changes: manifest.changes.length });
							if (integrated.integration?.state !== "applied") { record.failures.push(`integrate: state ${integrated.integration?.state}`); return; }
						} else {
							record.integrations.push({ operationId: operation.id, state: "not-needed", changes: 0 });
						}
					}
					const decided = await timed("decide", operation.id, operation.node, () => tool.execute({ op: "decide", runId, operationId: operation.id, decision: "accepted", reason: "matched live measurement: automatic acceptance of an exited candidate; no independent review", verdict, payload: slicePayload }, progress, ctx).then(parsed));
					if (decided.error) { record.failures.push(`decide: ${decided.error}`); return; }
					record.completions += 1;
				} else {
					record.failures.push(`attempt ${attempt.processState}${attempt.candidate ? "" : " without a candidate"}: ${attempt.outcome?.error ?? attempt.outcome?.reason ?? attempt.observation?.captureStatus ?? ""}`);
					const retried = await timed("retry", operation.id, operation.node, () => tool.execute({ op: "retry", runId, operationId: operation.id }, progress, ctx).then(parsed));
					if (retried.error) { record.failures.push(`retry: ${retried.error}`); return; }
					record.retries += 1; if (retried.retry && retried.retry.modelAttempt > operation.model_attempt) record.modelFallbacks += 1;
				}
			})).finally(() => clearInterval(watcher));
		}
		record.workspace = graph === "operations" ? { status: existsSync(join(repo, "runs", "fixture-source", "checkpoint.json")) ? "checkpoint placed" : "", diff: existsSync(join(repo, "runs", "fixture-source", "checkpoint.json")) ? readFileSync(join(repo, "runs", "fixture-source", "checkpoint.json"), "utf8").slice(0, 2000) : "" } : workspaceState(repo);
		const { GraphStore } = await import("../../store.ts");
		const store = new GraphStore({ dbPath });
		try {
			record.operations = store.operations(runId).map((operation) => ({ id: operation.id, node: operation.node, status: operation.status, modelAttempt: operation.model_attempt, transientAttempts: operation.transient_attempts, selectedModel: operation.selected_model, classifierReason: operation.classifier_reason, retryReason: operation.retry_reason, fallbackReason: operation.fallback_reason, verdict: operation.verdict, lastError: operation.last_error }));
			{ const path = join(evidenceDir, `ledger-${contract}-${repeat}.json`); writeFileSync(path, JSON.stringify(store.runtimeLedger(runId), null, 2) + "\n", { mode: 0o600 }); record.ledgerPath = path; }
			const events = store.events(runId, 10_000);
			record.retries = events.filter((event) => event.type === "retry").length;
			record.modelFallbacks = events.filter((event) => event.type === "model_fallback").length;
		} finally { store.close(); }
	} catch (error) {
		record.error = error instanceof Error ? error.message : String(error);
	} finally {
		record.finishedAt = new Date().toISOString(); record.totalMs = Math.round(now() - started);
		writeFileSync(join(evidenceDir, `run-${contract}-${repeat}.json`), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
		rmSync(root, { recursive: true, force: true });
	}
	return record;
}

const records: RunRecord[] = [];
for (let repeat = 1; repeat <= repeats; repeat += 1) for (const contract of contracts) {
	console.log(JSON.stringify({ starting: { contract, repeat } }));
	const record = await measureRun(contract, repeat);
	records.push(record);
	console.log(JSON.stringify({ finished: { contract, repeat, runId: record.runId, status: record.finalStatus, terminal: record.terminal, totalMs: record.totalMs, dispatches: record.dispatches, retries: record.retries, modelFallbacks: record.modelFallbacks, failures: record.failures.length, error: record.error } }));
}
const phaseSum = (record: RunRecord, kind: string) => record.phases.filter((phase) => phase.kind === kind).reduce((sum, phase) => sum + phase.ms, 0);
const summary = {
	schemaVersion: 1, measuredAt: new Date().toISOString(), plan, hostPiVersion: spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim(), sampleCounts: Object.fromEntries(contracts.map((contract) => [contract, records.filter((record) => record.contract === contract).length])),
	runs: records.map((record) => ({ contract: record.contract, repeat: record.repeat, runId: record.runId, terminal: record.terminal, finalStatus: record.finalStatus, totalMs: record.totalMs, dispatches: record.dispatches, collects: record.collects, completions: record.completions, retries: record.retries, modelFallbacks: record.modelFallbacks, failures: record.failures, error: record.error, dispatchMs: phaseSum(record, "dispatch"), collectMs: phaseSum(record, "collect"), completionMs: phaseSum(record, "record-completed") + phaseSum(record, "decide"), integrateMs: phaseSum(record, "integrate"), backoffMs: phaseSum(record, "backoff"), verdicts: record.verdicts, integrations: record.integrations, workspaceChanged: record.workspace ? record.workspace.status.trim().length > 0 : null, criticalPathNote: "collect phases of a fan-out overlap; collectMs is the sum, totalMs is elapsed wall time" })),
	cost: "unknown: provider usage is not reported by the worker path and is not estimated",
};
writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
const lines = ["# Matched live measurement", "", `Measured ${summary.measuredAt} on Pi ${summary.hostPiVersion}, model \`${model}\`, adapter pi, ${graph} graph, ${repeats} repeat(s) per contract. Cost: ${summary.cost}.`, "", "| contract | repeat | terminal | status | total ms | dispatches | retries | fallbacks | completions | failures | verdicts | workspace changed | error |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...summary.runs.map((run) => `| ${run.contract} | ${run.repeat} | ${run.terminal} | ${run.finalStatus} | ${run.totalMs} | ${run.dispatches} | ${run.retries} | ${run.modelFallbacks} | ${run.completions} | ${run.failures.length} | ${run.verdicts.map((item) => `${item.node}=${item.verdict ?? "none"}`).join(" ") || "-"} | ${run.workspaceChanged ?? "-"} | ${run.error ?? ""} |`), "", "Runtime-v1 candidates were accepted automatically by the driver; this measures latency, turns and recovery, not quality or independent review. Review, test and audit verdicts were read from the worker. Sums of parallel collect phases exceed elapsed time by design."];
writeFileSync(join(evidenceDir, "summary.md"), lines.join("\n") + "\n", { mode: 0o600 });
console.log(JSON.stringify({ evidenceDir, summary: join(evidenceDir, "summary.md"), runs: summary.runs.length, terminal: summary.runs.filter((run) => run.terminal).length }));
process.exitCode = records.every((record) => record.terminal && !record.error) ? 0 : 1;
