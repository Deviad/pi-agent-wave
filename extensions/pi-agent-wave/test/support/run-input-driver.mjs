import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import extension from "../../index.ts";
import { GraphStore } from "../../store.ts";
import { Database } from "../../sqlite.ts";
import { RuntimeContentStore } from "../../lib/runtime-content.ts";
import { createHeadlessAcpxAttemptIdentity } from "../../lib/acpx-types.ts";
import { BUILD_GRAPH, RESEARCH_GRAPH, OPERATIONS_GRAPH } from "../../graph-core.ts";

const [mode, root] = process.argv.slice(2);
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.DELEGATE_GRAPH_DB = join(root, "graph", "graph.db");
for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "PI_HOST_SERVICES", "PI_MODEL_ROUTING", "PI_MODEL_CATALOG"]) delete process.env[key];
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const model = "openai-codex/offline-resource-fixture";
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
	default_tier: "tools", tiers: { tools: { models: [model], thinking: "off", session: true } },
	roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])),
}));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "host-services.jsonc"), JSON.stringify({ services: { browser: {
	description: "Disposable test service", start: { [process.platform]: { executable: process.execPath, args: ["-e", "process.exit(0)"] } },
	env: { BROWSER_CDP_URL: "http://127.0.0.1:{port}" },
} } }));
const commands = new Map(); const hooks = new Map(); const messages = []; const prompts = [];
let tool;
let pickers = 0;
const context = { cwd: workspace, mode: "headless", ui: { select() { pickers++; throw new Error("unexpected picker"); }, notify() {}, input() { throw new Error("unexpected input"); } } };
const sourceDir = join(root, "unique-source-provenance"); mkdirSync(sourceDir);
const source = join(sourceDir, "archive"); writeFileSync(source, "frozen archive bytes");
const scripts = realpathSync(new URL("../../scripts", import.meta.url).pathname);

/** Calls real prompt assembly; only paid provider execution is replaced. */
function observePrompt(args, cwd) {
	const offset = args.indexOf("start"); const runDir = args[offset + 1];
	const preparation = `import os,sys,json\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(scripts)})\nimport delegate_core as core\ncore.ACTIVE_TRANSPORT='headless'\nargs=core.build_parser().parse_args(${JSON.stringify(args.slice(offset))})\nrun_dir=Path(args.run_dir)\nhome=run_dir/'fixture-provider-home'\n(home/'.codex').mkdir(parents=True)\n(home/'.codex'/'auth.json').write_text(json.dumps({'OPENAI_API_KEY':'offline-not-a-credential'}))\nos.environ['HOME']=str(home)\nos.environ['CODEX_HOME']=str(home/'.codex')\nos.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE',None)\nos.chdir(${JSON.stringify(cwd)})\nresource,_=core.prepare_acpx_attempt(run_dir,args,{'run_label':'fixture'},'fixture-worker',args.model,Path(args.task_file_option),args.node)\nprint(Path(resource['prompt_file']).read_text())\n`;
	const result = spawnSync("python3", ["-c", preparation], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	const input = readFileSync(join(runDir, "runtime-evidence", "inputs", "archive"), "utf8");
	const ledger = readFileSync(join(runDir, "runtime-evidence", "ledger.json"), "utf8");
	const task = readFileSync(join(runDir, "task.md"), "utf8");
	assert.equal(input, "frozen archive bytes");
	assert.deepEqual(JSON.parse(ledger).inputs, [{ name: "archive", sha256: createHash("sha256").update(input).digest("hex"), bytes: Buffer.byteLength(input) }]);
	for (const text of [result.stdout, ledger, task]) assert.ok(!text.includes(sourceDir), "source provenance leaked to worker evidence");
	assert.ok(result.stdout.includes(join(runDir, "runtime-evidence", "inputs", "archive")));
	assert.ok(result.stdout.includes("Work from the working directory, the run evidence and the declared input paths listed above."));
	assert.ok(result.stdout.includes("do not replace it with a filesystem-wide search"));
	prompts.push({ node: args[args.indexOf("--node") + 1], cwd, runDir, services: args.includes("--host-services-json") });
}

extension({
	registerTool(definition) { tool = definition; },
	registerCommand(name, definition) { commands.set(name, definition); },
	on(event, callback) { hooks.set(event, callback); },
	setSessionName() {}, sendUserMessage(message) { messages.push(message); },
	async exec(command, args, options) {
		if (mode === "legacy" && args.includes("start") && args.includes("--task-file")) {
			prompts.push({ cwd: options.cwd });
			return { code: 1, stdout: "", stderr: "worker preflight: offline provider execution disabled", killed: false };
		}
		if (mode === "delivery" && args.includes("start") && args.includes("--task-file")) {
			observePrompt(args, options.cwd);
			return { code: 1, stdout: "", stderr: "worker preflight: offline provider execution disabled", killed: false };
		}
		const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
		return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
	},
});
const call = async (params, ctx = context) => (await tool.execute("fixture", params, undefined, () => {}, ctx)).details;
function runCount() { const db = new Database(process.env.DELEGATE_GRAPH_DB); try { return db.query("SELECT COUNT(*) AS n FROM runs").get().n; } finally { db.close(); } }
function contentInventory() { try { return readdirSync(join(root, "graph", "runtime-content")); } catch { return []; } }

try {
	if (mode === "slash") {
		await commands.get("delegate").handler("--policy auto research Read ~/archive/script; use $HOME/browser/bin; keep ${HOME}/private/database unopened", context);
		assert.equal(runCount(), 0, "slash initialization must not bypass preparation");
		assert.equal(messages.length, 1); assert.equal(pickers, 0);
		assert.ok(messages[0].includes("Prepare resources before initializing"));
		assert.ok(messages[0].includes(workspace));
		console.log("slash initialization hands resource preparation to the supervisor");
	} else if (mode === "initialization") {
		const task = "Read ~/archive/script; use $HOME/browser/bin; never open ${HOME}/private/database";
		const result = await call({ op: "init", story: "unprepared", graph: "research", task });
		assert.ok(result.error?.includes("resource preparation required"));
		assert.deepEqual(result.pathIssues.map((issue) => issue.token), ["~/archive/script", "$HOME/browser/bin", "${HOME}/private/database"]);
		assert.equal(runCount(), 0); assert.deepEqual(contentInventory(), []);
		const inventory = contentInventory();
		symlinkSync(source, join(root, "symlink")); linkSync(source, join(root, "hardlink"));
		writeFileSync(join(root, "unreadable"), "private"); chmodSync(join(root, "unreadable"), 0);
		writeFileSync(join(root, "large"), ""); truncateSync(join(root, "large"), 10 * 1024 * 1024 + 1);
		assert.equal(spawnSync("mkfifo", [join(root, "fifo")]).status, 0);
		const aggregate = Array.from({ length: 4 }, (_, index) => {
			const path = join(root, `aggregate-${index}`); writeFileSync(path, ""); truncateSync(path, 10 * 1024 * 1024);
			return { name: `aggregate-${index}`, path };
		});
		const invalidInputs = [
			[{ name: "directory", path: root }], [{ name: "symlink", path: join(root, "symlink") }],
			[{ name: "large", path: join(root, "large") }], [{ name: "fifo", path: join(root, "fifo") }],
			[{ name: "unreadable", path: join(root, "unreadable") }], [{ name: "bad/name", path: source }],
			[{ name: "duplicate", path: source }, { name: "duplicate", path: source }],
			[{ name: "first", path: source }, { name: "second", path: source }],
			[{ name: "first", path: source }, { name: "second", path: join(root, "hardlink") }],
			Array.from({ length: 33 }, (_, index) => ({ name: `count-${index}`, path: source })), aggregate,
		];
		for (const inputs of invalidInputs) {
			const invalid = await call({ op: "init", story: "invalid-input", graph: "research", task: "Read archive", inputs });
			assert.ok(invalid.error); assert.equal(runCount(), 0); assert.deepEqual(contentInventory(), inventory);
		}
		for (const params of [
			{ story: "invalid", inputs: [{ name: "ok", path: source }, { name: "missing", path: join(root, "absent") }] },
			{ story: "", inputs: [{ name: "ok", path: source }] },
			{ story: "invalid-graph", graph: "operations", inputs: [{ name: "ok", path: source }] },
		]) {
			const invalid = await call({ op: "init", graph: "research", task: "Read archive", ...params });
			assert.ok(invalid.error); assert.equal(runCount(), 0); assert.deepEqual(contentInventory(), inventory);
		}
		await commands.get("delegate").handler(`--policy auto research ${task}`, context);
		assert.equal(runCount(), 0); assert.equal(pickers, 0); assert.equal(messages.length, 1);
		const message = messages[0];
		const template = JSON.parse(message.slice(message.indexOf("{"), message.indexOf("\nFor each needed file")));
		assert.equal(template.task, task); assert.equal(template.graph, "research");
		assert.deepEqual(template.modelPolicy, { kind: "auto" }); assert.equal(template.dispatchWorkspaceRoot, workspace);
		const prepared = await call({ op: "init", story: template.story, graph: template.graph, task: "Read declared input archive. Required service browser for browser operations. Keep the private database unopened.", modelPolicy: template.modelPolicy, dispatchWorkspaceRoot: template.dispatchWorkspaceRoot, inputs: [{ name: "archive", path: source }] }, { ...context, cwd: elsewhere });
		assert.ok(!prepared.error, JSON.stringify(prepared)); assert.equal(runCount(), 1); assert.equal(pickers, 0);
		assert.ok(prepared.supervisorInstructions.includes("relevant dispatches and retries"));
		const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
		assert.equal(store.getRun(prepared.state.runId).dispatch_workspace_root, workspace); assert.deepEqual(store.policy(prepared.state.runId).input, { kind: "auto" }); store.close();
		await commands.get("delegate").handler("research Read workspace", context);
		assert.equal(runCount(), 2); assert.equal(messages.length, 2);
		console.log("tool and slash initialization share preparation; prepared initialization succeeds without a second picker");
	} else if (mode === "legacy") {
		const init = await call({ op: "init", story: "legacy", graph: "research", task: "Read workspace" });
		assert.ok(!init.error, JSON.stringify(init));
		const db = new Database(process.env.DELEGATE_GRAPH_DB);
		db.query("UPDATE runs SET dispatch_workspace_root=NULL WHERE id=?").run(init.state.runId); db.close();
		const dispatch = await call({ op: "dispatch", runId: init.state.runId, operationId: init.next.operations[0].id, transport: "headless" }, { ...context, cwd: elsewhere });
		assert.equal(dispatch.blocked, "preflight", JSON.stringify(dispatch));
		assert.equal(prompts.length, 1); assert.equal(prompts[0].cwd, elsewhere);
		console.log("legacy runs still dispatch in the session workspace");
	} else if (mode === "delivery") {
		for (const argv of [["init", "-q"], ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]]) assert.equal(spawnSync("git", argv, { cwd: workspace }).status, 0);
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
		const commandCwd = join(root, "operational-workspace"); mkdirSync(commandCwd);
		for (const graph of [BUILD_GRAPH, RESEARCH_GRAPH, OPERATIONS_GRAPH]) {
			writeFileSync(source, "frozen archive bytes");
			const init = await call({ op: "init", story: graph.name, graph: graph.name, task: "Read declared input archive. Required service browser.", inputs: [{ name: "archive", path: source }], ...(graph.name === "operations" ? { commands: [{ id: "source", name: "Read archive", command: { executable: "true", args: [], cwd: commandCwd }, ownedPaths: ["checkpoint"] }] } : {}) });
			assert.ok(!init.error, JSON.stringify(init));
			writeFileSync(source, "changed source"); rmSync(source);
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			try {
				for (const node of graph.nodes) {
					let operation = store.next(init.state.runId).operations[0]; assert.equal(operation.node, node.name);
					const dispatched = await call({ op: "dispatch", runId: init.state.runId, operationId: operation.id, transport: "headless", hostServices: ["browser"] }, { ...context, cwd: elsewhere });
					assert.equal(dispatched.blocked, "preflight", JSON.stringify(dispatched));
					assert.equal(prompts.at(-1).cwd, node.name === "source_search" ? commandCwd : workspace);
					assert.equal(prompts.at(-1).services, true);
					if (node.name === "thinker_split") {
						const db = new Database(store.dbPath); db.query("UPDATE operations SET retry_not_before=NULL WHERE id=?").run(operation.id); db.close();
						const retry = await call({ op: "dispatch", runId: init.state.runId, operationId: operation.id, transport: "headless", hostServices: ["browser"] }, { ...context, cwd: elsewhere });
						assert.equal(retry.blocked, "preflight"); assert.notEqual(prompts.at(-1).runDir, prompts.at(-2).runDir);
					}
					const db = new Database(store.dbPath); db.query("UPDATE operations SET retry_not_before=NULL WHERE id=?").run(operation.id); db.close();
					operation = store.getOperation(operation.id);
					const identity = createHeadlessAcpxAttemptIdentity({ runId: init.state.runId, operationId: operation.id, role: node.role, modelAttempt: operation.model_attempt, transientAttempt: operation.transient_attempts, selectedModel: model, agent: "codex" });
					store.beginRuntimeAttempt({ identity, sessionId: identity.sessionName, requestId: null, policyDigest: store.policy(init.state.runId).digest });
					const content = new RuntimeContentStore(store.dbPath); const answer = content.retain(Buffer.from("offline provider answer"));
					let candidate = { kind: "research", answer, sources: [] }; let manifest = null;
					if (!node.readOnly) {
						manifest = content.retain(Buffer.from(JSON.stringify({ version: 1, attemptKey: identity.attemptKey, workspace: node.name === "source_search" ? commandCwd : workspace, baseRevision: head, snapshotDigest: "0".repeat(64), ownedPaths: ["owned.txt"], changes: [], readOnly: false })));
						candidate = { kind: node.name === "source_search" ? "operational" : "coding", answer, artifacts: [manifest], baseRevision: head, ...(node.name === "source_search" ? { checkpoint: null } : {}) };
					}
					store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate, observation: { sessionId: "offline-session", requestId: "fixture", sessionOrigin: "created", captureStatus: "complete", manifest } });
					store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "offline fixture advances delivery coverage", verdict: node.name === "test" ? "GREEN" : ["review", "audit"].includes(node.name) ? "PASS" : "DONE", ...(["thinker_plan", "thinker_split"].includes(node.name) ? { payload: { slices: [{ id: "one", name: "One", task: "Read archive", ownedPaths: ["owned.txt"] }] } } : {}) });
				}
				assert.equal(store.getState(init.state.runId).status, "terminal");
			} finally { store.close(); }
		}
		console.log(JSON.stringify({ nodes: prompts.map((prompt) => prompt.node), result: "dispatch delivers inputs to every graph node and replacement attempt" }));
	} else throw new Error("unknown test mode");
} finally {
	await hooks.get("session_shutdown")?.({}, context);
}
