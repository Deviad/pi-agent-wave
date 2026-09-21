#!/usr/bin/env node
/**
 * Live proof of the two fixes in `tasks/handoff-settlement-and-integration-races.md`, on real workers.
 *
 * The shipped measurement driver cannot show either one: its build graph ships a single slice, so the
 * sibling guard never fires, and it integrates inside its parallel collect loop, which is the ordering the
 * guard now refuses. This drives the real `delegate_graph` tool through a two-slice build run and performs
 * the incident's exact sequence:
 *
 *   dispatch A and B -> collect A while B still runs -> integrate A (must be REFUSED, naming B)
 *   -> collect B -> assert B's candidate survived -> integrate A (must now APPLY).
 *
 * It also samples the turn-end label while a worker is between "turn over" and "collected", which is the
 * window issue 1 is about. Only the corpus and the slice topology are fixture; the graph, the workers, the
 * AgentFS overlays, the audit and the integration journal are the shipped code.
 *
 * Spends provider credit. `--execute` is required; without it this prints its plan and exits.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeContentStore } from "../../lib/runtime-content.ts";
import { parseRuntimeStagingManifest } from "../../lib/runtime-staging.ts";
import { SCRATCH_ROOT, makeScratchDir } from "../../lib/agent-paths.mjs";
import { turnEndFor } from "../../lib/turn-end.ts";

const PACKAGE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPO = resolve(PACKAGE, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: string): string => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const execute = flag("--execute");
const model = option("--model", "alibaba/qwen3.8-flash");
const transport = option("--transport", "headless");
const runTimeoutMs = Number.parseInt(option("--run-timeout-ms", String(40 * 60_000)), 10);
const evidenceDir = resolve(option("--evidence-dir", join(REPO, "agent-output", `sibling-race-proof-${new Date().toISOString().slice(0, 10)}`)));

const TASK = "implement: this service has two documents that are out of date with the code. Update them.";
/** Two disjoint slices, each owning one file: the shape that makes the race reachable at all. */
const slices = (repo: string) => [
	{ id: "product", name: "product", task: "Write docs/product.md describing what this service does for a user, in at most 12 lines. Read src/cache.ts and src/store.ts first and describe the real behaviour. Only docs/product.md may change. Reply with the file content you wrote.", ownedPaths: [join(repo, "docs", "product.md")] },
	{ id: "specification", name: "specification", task: "Write docs/specification.md describing the cache invalidation rules this code implements, in at most 12 lines. Read src/cache.ts, src/store.ts and src/import.ts first and cite function names. Only docs/specification.md may change. Reply with the file content you wrote.", ownedPaths: [join(repo, "docs", "specification.md")] },
];

function corpus(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true }); mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "README.md"), "# widget-service\n\nA small service with an in-memory cache.\n");
	writeFileSync(join(dir, "docs", "product.md"), "# Product\n\nSTALE: this file predates the cache and must be rewritten.\n");
	writeFileSync(join(dir, "docs", "specification.md"), "# Specification\n\nSTALE: this file predates the cache and must be rewritten.\n");
	writeFileSync(join(dir, "src", "cache.ts"), "const entries = new Map<string, string>();\nexport function get(key: string): string | undefined { return entries.get(key); }\nexport function put(key: string, value: string): void { entries.set(key, value); }\nexport function invalidate(key: string): void { entries.delete(key); }\nexport function clear(): void { entries.clear(); }\n");
	writeFileSync(join(dir, "src", "store.ts"), "import { invalidate, put } from \"./cache.ts\";\nconst rows = new Map<string, string>();\nexport function save(key: string, value: string): void {\n  rows.set(key, value);\n  invalidate(key);\n}\nexport function load(key: string): string | undefined {\n  const value = rows.get(key);\n  if (value !== undefined) put(key, value);\n  return value;\n}\n");
	writeFileSync(join(dir, "src", "import.ts"), "// Bulk import used by the admin CLI. NOTE: writes rows directly and never calls cache.invalidate.\nexport function bulkImport(rows: Map<string, string>, target: Map<string, string>): void {\n  for (const [key, value] of rows) target.set(key, value);\n}\n");
	const git = (...argv: string[]) => spawnSync("git", ["-C", dir, ...argv], { encoding: "utf8" });
	git("init", "-q"); git("add", "."); git("-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "corpus");
}

function exec(command: string, argv: string[], options?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
	return new Promise((done) => {
		execFile(command, argv, { cwd: options?.cwd, env: process.env, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: unknown }).code) : error ? 1 : 0;
			done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), killed: false });
		});
	});
}

async function loadTool(dbPath: string): Promise<(params: Record<string, unknown>, onUpdate?: (u: unknown) => void) => Promise<Record<string, any>>> {
	process.env.DELEGATE_GRAPH_DB = dbPath;
	if (transport === "headless") { delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID; }
	const { default: extension } = await import(`../../index.ts?proof=${Date.now()}`);
	let tool: any;
	extension({ registerCommand() {}, registerTool(definition: unknown) { tool = definition; }, exec, sendUserMessage() {}, on() {} });
	if (!tool) throw new Error("delegate_graph tool did not register");
	return async (params, onUpdate) => {
		const result = await tool.execute("proof", params, undefined, onUpdate ?? (() => {}), ctx);
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		try { return JSON.parse(text); } catch { return { raw: text }; }
	};
}

let ctx: Record<string, unknown>;
const findings: { check: string; expected: string; observed: string; pass: boolean }[] = [];
function record(check: string, expected: string, observed: string, pass: boolean): void {
	findings.push({ check, expected, observed, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      expected: ${expected}\n      observed: ${observed}`);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
	const plan = { mode: execute ? "execute" : "dry-run", model, transport, graph: "build", slices: slices("/corpus").map((slice) => slice.id), sequence: ["dispatch A+B", "collect A while B runs", "integrate A -> expect refusal naming B", "collect B", "assert B candidate intact", "integrate A -> expect applied"], evidenceDir, spend: "provider-priced; six or more worker turns" };
	console.log(JSON.stringify(plan, null, 2));
	if (!execute) return;

	const root = makeScratchDir("pi-wave-race-proof-");
	const repo = join(root, "repo"); mkdirSync(repo); corpus(repo);
	const dbPath = join(root, "graph.db");
	ctx = { mode: "headless", cwd: repo, ui: { notify() {} } };
	const tool = await loadTool(dbPath);
	const started = Date.now();
	const transcript: Record<string, unknown>[] = [];
	const note = (kind: string, detail: Record<string, unknown>) => { transcript.push({ at: Date.now() - started, kind, ...detail }); };

	const init = await tool({ op: "init", story: `sibling-race-proof-${Date.now()}`, graph: "build", task: TASK, modelPolicy: { kind: "model", model, reason: "live proof of the sibling-integration race" } });
	if (init.error) throw new Error(`init failed: ${init.error}`);
	const runId: string = init.state.runId;
	note("init", { runId });
	console.log(`run ${runId}\nrepo ${repo}\nroot ${root}`);

	const cancelScripts = new Map<string, string>();
	const dispatch = async (operationId: string): Promise<void> => {
		const dispatched = await tool({ op: "dispatch", runId, operationId, transport });
		if (dispatched.error) throw new Error(`dispatch failed: ${dispatched.error}`);
		if (dispatched.dispatched === false) throw new Error(`dispatch blocked: ${dispatched.reason}`);
		const script = dispatched.launch?.["acpx-cancel-script"];
		if (typeof script === "string") cancelScripts.set(operationId, script);
		note("dispatch", { operationId, agent: dispatched.agentName });
	};
	const collect = async (operationId: string): Promise<Record<string, any>> => {
		const collected = await tool({ op: "collect", runId, operationId });
		if (collected.error) throw new Error(`collect failed: ${collected.error}`);
		note("collect", { operationId, processState: collected.attempt?.processState, candidate: collected.attempt?.candidate?.kind ?? null });
		return collected;
	};
	const decide = async (operationId: string, verdict: string | undefined, payload: Record<string, unknown>): Promise<void> => {
		const decided = await tool({ op: "decide", runId, operationId, decision: "accepted", reason: "live proof: automatic acceptance of an exited candidate; no independent review", verdict, payload });
		if (decided.error) throw new Error(`decide failed: ${decided.error}`);
		note("decide", { operationId, verdict: verdict ?? null, status: decided.state?.status });
	};
	const verdictFrom = (answer: string, allowed: readonly string[]): string | null => {
		const matches = [...answer.matchAll(/^\s*\**\s*VERDICT\s*:\s*\**\s*([A-Z_]+)\s*\**\s*$/gm)];
		const last = matches.at(-1)?.[1] ?? null;
		return last && allowed.includes(last) ? last : null;
	};
	const VERDICTS: Record<string, readonly string[]> = { review: ["PASS", "FAIL"], test: ["GREEN", "NOT_OK"], audit: ["PASS", "FAIL"] };
	const FIXED: Record<string, string> = { thinker_plan: "READY", implement: "DONE" };
	const answerOf = (attempt: Record<string, any>): string => attempt?.candidate?.answer ? new RuntimeContentStore(dbPath).read(attempt.candidate.answer, 16 * 1024 * 1024).toString("utf8") : "";

	let raceDone = false;
	for (let iteration = 0; iteration < 60; iteration += 1) {
		if (Date.now() - started > runTimeoutMs) throw new Error(`run exceeded ${runTimeoutMs} ms`);
		const next = await tool({ op: "next", runId });
		if (next.error) throw new Error(`next failed: ${next.error}`);
		if (next.state.status !== "active") { note("terminal", { status: next.state.status }); break; }
		const pending: Record<string, any>[] = next.operations.filter((operation: Record<string, any>) => operation.status === "pending");
		const running: Record<string, any>[] = next.operations.filter((operation: Record<string, any>) => operation.status === "running");
		if (!pending.length && !running.length) throw new Error("active run with nothing pending or running");

		const implementPending = pending.filter((operation) => operation.node === "implement");
		if (!raceDone && implementPending.length === 2) {
			// ---- the incident's exact sequence, on live workers ----
			raceDone = true;
			const [a, b] = implementPending;
			await dispatch(a.id); await dispatch(b.id);
			console.log("\n--- both implement workers dispatched; collecting A while B still runs ---");

			const collectedA = await collect(a.id);

			// Issue 1: B's worker may be between "turn over" and "collected". Sample the label either way.
			const bScript = cancelScripts.get(b.id) ?? null;
			const bTurn = turnEndFor(bScript);
			const bWatch = await tool({ op: "watch", runId });
			const bRow = (bWatch.agents ?? []).find((agent: Record<string, any>) => agent.node === "implement" && agent.processState !== null);
			note("turn-end-sample", { operationId: b.id, ended: bTurn.ended, exitCode: bTurn.exitCode, watchProcessState: bRow?.processState ?? null });
			console.log(`turn-end sample for the still-uncollected worker: ended=${bTurn.ended} exitCode=${bTurn.exitCode} watch=${bRow?.processState ?? "none"}`);
			if (bTurn.ended) {
				record("issue 1: an uncollected worker whose turn ended is labelled as such", "watch reports 'awaiting collect'", String(bRow?.processState), String(bRow?.processState ?? "").includes("awaiting collect"));
			} else {
				record("issue 1 (live window not observed)", "worker B still mid-turn at sample time", `ended=false, watch=${bRow?.processState ?? "none"}; the label is proven by test/turn-end-visibility.test.ts instead`, true);
			}

			// Issue 2: integrate A while B's worker is still live.
			const manifestA = collectedA.attempt?.observation?.manifest;
			if (!manifestA) throw new Error("slice A settled without a staging manifest; the proof needs a coding candidate");
			const changesA = parseRuntimeStagingManifest(JSON.parse(new RuntimeContentStore(dbPath).read(manifestA, 16 * 1024 * 1024).toString("utf8"))).changes;
			note("slice-a-staged", { changes: changesA.map((change) => change.path) });
			// Which slice the graph dispatched first is the planner's business, so the file to assert on is read
			// from A's own manifest rather than assumed: hardcoding one made a passing run report a false FAIL.
			const pathA = changesA[0]?.path;
			if (!pathA) throw new Error("slice A staged no file; the proof needs a file change to integrate");
			const bAttemptLive = (await tool({ op: "status", runId })).raw ?? null;
			const refused = await tool({ op: "integrate", runId, operationId: a.id });
			const namesB = typeof refused.error === "string" && refused.error.includes(b.id);
			note("integrate-while-sibling-live", { error: refused.error ?? null, namesB, bAttemptLive });
			record("issue 2: integrating while a sibling worker is live is refused, naming it", `an error containing ${b.id}`, String(refused.error ?? "(no error: it applied)"), Boolean(refused.error) && namesB);

			const beforeText = readFileSync(join(repo, pathA), "utf8");
			record("issue 2: the refused integration wrote nothing", `${pathA} still holds its committed preimage`, beforeText.includes("STALE") ? "unchanged (STALE preimage)" : "MODIFIED", beforeText.includes("STALE"));

			// Now collect B and prove its attempt survived the attempted integration.
			console.log("\n--- collecting B; it must settle with its candidate intact ---");
			const collectedB = await collect(b.id);
			const bOk = collectedB.attempt?.processState === "exited" && Boolean(collectedB.attempt?.candidate);
			record("issue 2: the sibling settles normally with its candidate intact", "processState=exited with a candidate", `processState=${collectedB.attempt?.processState} candidate=${collectedB.attempt?.candidate?.kind ?? "none"}`, bOk);
			const bFailed = JSON.stringify(collectedB.attempt?.outcome ?? {});
			record("issue 2: the sibling never sees 'unowned changes'", "no AgentFS ownership failure in its outcome", bFailed.includes("unowned changes") ? bFailed : "no ownership failure", !bFailed.includes("unowned changes"));

			// With both settled, the integration that was refused must now go through.
			const applied = await tool({ op: "integrate", runId, operationId: a.id });
			note("integrate-after-sibling-settled", { error: applied.error ?? null, state: applied.integration?.state ?? null, overrideReason: applied.integration?.overrideReason ?? null });
			record("issue 2: the same integration applies once the sibling has settled", "integration state 'applied' with no override", `state=${applied.integration?.state ?? "error: " + applied.error} override=${applied.integration?.overrideReason ?? "null"}`, applied.integration?.state === "applied" && applied.integration?.overrideReason === null);
			const afterText = readFileSync(join(repo, pathA), "utf8");
			record("issue 2: the applied integration wrote the candidate", `${pathA} no longer holds the STALE preimage`, afterText.includes("STALE") ? "still STALE" : `written (${afterText.length} bytes)`, !afterText.includes("STALE"));

			// Decide both so the run can advance to review/test/audit.
			for (const operation of [a, b]) {
				const attempt = operation.id === a.id ? collectedA.attempt : collectedB.attempt;
				if (operation.id === b.id) {
					const manifestB = collectedB.attempt?.observation?.manifest;
					if (manifestB) {
						const changesB = parseRuntimeStagingManifest(JSON.parse(new RuntimeContentStore(dbPath).read(manifestB, 16 * 1024 * 1024).toString("utf8"))).changes;
						if (changesB.length) {
							const integratedB = await tool({ op: "integrate", runId, operationId: b.id });
							note("integrate-b", { state: integratedB.integration?.state ?? null, error: integratedB.error ?? null });
							record("issue 2: the sibling's own candidate integrates afterwards", "integration state 'applied'", `state=${integratedB.integration?.state ?? "error: " + integratedB.error}`, integratedB.integration?.state === "applied");
						}
					}
				}
				if (attempt?.processState === "exited" && attempt?.candidate) await decide(operation.id, FIXED[operation.node], {});
			}
			continue;
		}

		for (const operation of pending) { await dispatch(operation.id); running.push({ ...operation, status: "running" }); }
		for (const operation of running) {
			const collected = await collect(operation.id);
			const attempt = collected.attempt;
			if (attempt?.processState !== "exited" || !attempt?.candidate) {
				const retried = await tool({ op: "retry", runId, operationId: operation.id });
				note("retry", { operationId: operation.id, error: retried.error ?? null });
				if (retried.error) throw new Error(`retry failed: ${retried.error}`);
				continue;
			}
			let verdict: string | undefined = FIXED[operation.node];
			if (VERDICTS[operation.node]) {
				const read = verdictFrom(answerOf(attempt), VERDICTS[operation.node]);
				if (!read) { note("no-verdict", { operationId: operation.id, node: operation.node }); throw new Error(`${operation.node} answer states no readable VERDICT line`); }
				verdict = read;
			}
			if ((attempt.candidate?.kind === "coding" || attempt.candidate?.kind === "operational") && attempt.observation?.manifest) {
				const changes = parseRuntimeStagingManifest(JSON.parse(new RuntimeContentStore(dbPath).read(attempt.observation.manifest, 16 * 1024 * 1024).toString("utf8"))).changes;
				if (changes.length) {
					const integrated = await tool({ op: "integrate", runId, operationId: operation.id });
					if (integrated.error) throw new Error(`integrate failed: ${integrated.error}`);
					note("integrate", { operationId: operation.id, state: integrated.integration?.state });
				}
			}
			const payload = operation.node === "thinker_plan" ? { slices: slices(repo) } : {};
			await decide(operation.id, verdict, payload);
		}
		await sleep(250);
	}

	const status = await tool({ op: "status", runId });
	const gitStatus = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout;
	mkdirSync(evidenceDir, { recursive: true });
	const summary = { measuredAt: new Date().toISOString(), runId, model, transport, root, repo, totalMs: Date.now() - started, findings, transcript, finalStatus: status.raw ?? status.state?.status ?? null, workspace: gitStatus, allPassed: findings.every((finding) => finding.pass) };
	writeFileSync(join(evidenceDir, "sibling-race-proof.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
	console.log(`\n=== ${findings.filter((finding) => finding.pass).length}/${findings.length} checks passed; evidence ${join(evidenceDir, "sibling-race-proof.json")}`);
	console.log(`run root retained at ${root}`);
	if (!summary.allPassed) process.exitCode = 1;
}

main().catch((error) => { console.error(`proof failed: ${error instanceof Error ? error.stack : String(error)}`); process.exitCode = 2; });
