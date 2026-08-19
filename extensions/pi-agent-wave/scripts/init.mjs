#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { resolveAgentDir, resolveCatalogPath, resolveFzfPath, resolveRoutingPath } from "../lib/agent-paths.mjs";
import { analyzeCatalog, isLocalModel, loadCatalog } from "../lib/catalog.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { detectPiFzf, mergeFzf, packageRoot, packageRoutePicker } from "../lib/pi-fzf.mjs";
import { DELEGATE_GRAPH_ROLES, OPTIONAL_TIERS, REQUIRED_TIERS, ROLE_CAPABILITY_FLOORS, ROLE_TIERS, generateRoutingTemplate } from "../lib/routing-template.mjs";
import { createBackup, defaultBackupId, finalizeBackup, restoreBackup, writeExact } from "../lib/safe-write.mjs";

const MODES = ["dry-run", "apply", "rollback"];

const TIER_FLAGS = new Map([
	["--tools", "tools"],
	["--coding", "coding"],
	["--test", "test"],
	["--review", "review"],
	["--reasoning", "reasoning"],
	["--long-context", "long-context"],
	["--local-fast", "local-fast"],
]);

function parseChain(value) {
	if (value === undefined || value === null) return [];
	return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function parseArgs(argv) {
	const args = {
		mode: "dry-run",
		agentDir: undefined,
		routing: undefined,
		models: undefined,
		force: false,
		backupId: undefined,
		manifest: undefined,
		nonInteractive: false,
		help: false,
		selections: {},
	};
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (MODES.includes(value)) args.mode = value;
		else if (value === "--agent-dir") args.agentDir = argv[++index];
		else if (value === "--routing") args.routing = argv[++index];
		else if (value === "--models") args.models = argv[++index];
		else if (value === "--force") args.force = true;
		else if (value === "--backup-id") args.backupId = argv[++index];
		else if (value === "--manifest") args.manifest = argv[++index];
		else if (value === "--non-interactive") args.nonInteractive = true;
		else if (value === "--help" || value === "-h") args.help = true;
		else if (TIER_FLAGS.has(value)) args.selections[TIER_FLAGS.get(value)] = parseChain(argv[++index]);
		else throw new Error(`unknown argument '${value}'`);
	}
	return args;
}

export function usage() {
	return [
		"usage: pi-agent-wave-init [dry-run|apply|rollback] [options]",
		"",
		"  Modes default to dry-run (no writes). `apply` is the only write mode;",
		"  `rollback --manifest <path>` restores a --force backup.",
		"",
		"  --agent-dir <path>        explicit Pi agent directory",
		"  --routing <path>          explicit model-routing.jsonc path",
		"  --models <path>           explicit models.json catalog path",
		"  --force                   back up and overwrite existing configuration",
		"  --backup-id <id>          override the backup id used by --force",
		"  --non-interactive         require explicit tier flags, never prompt",
		"  --tools <provider/model,...>   model chain for the tools tier",
		"  --coding <provider/model,...>  model chain for the coding tier",
		"  --test <provider/model,...>    model chain for the test tier",
		"  --review <provider/model,...>  model chain for the review tier",
		"  --reasoning <provider/model,...> model chain for the reasoning tier",
		"  --long-context <provider/model,...> model chain for the long-context tier",
		"  --local-fast <provider/model,...> model chain for the optional local-fast tier",
	].join("\n");
}

function createIo({ input, output } = {}) {
	const stream = input ?? process.stdin;
	const sink = output ?? process.stderr;
	const rl = createInterface({ input: stream, terminal: false });
	const lines = [];
	const waiters = [];
	rl.on("line", (line) => {
		const waiter = waiters.shift();
		if (waiter) waiter(line);
		else lines.push(line);
	});
	return {
		readLine: (prompt) =>
			new Promise((resolveLine) => {
				if (prompt) sink.write(prompt);
				if (lines.length) resolveLine(lines.shift());
				else waiters.push(resolveLine);
			}),
		write: (text) => sink.write(text),
		close: () => rl.close(),
	};
}

function validateSelections(analysis, selections) {
	const valid = new Set(analysis.selectable.map((model) => model.modelId));
	const errors = [];
	for (const [tier, models] of Object.entries(selections)) {
		if (!Array.isArray(models)) {
			errors.push(`tier '${tier}': selection is not a list`);
			continue;
		}
		if (new Set(models).size !== models.length) errors.push(`tier '${tier}': duplicate model in chain`);
		for (const model of models) {
			if (!valid.has(model)) errors.push(`tier '${tier}': unavailable model '${model}'`);
		}
	}
	return errors;
}

function validateRouting(routingText, includeLocalFast) {
	const errors = [];
	let parsed;
	try {
		parsed = parseJsonc(routingText, "generated routing");
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
	}
	const tiers = [...REQUIRED_TIERS, ...(includeLocalFast ? OPTIONAL_TIERS : [])];
	for (const tier of tiers) {
		const entry = parsed?.tiers?.[tier];
		if (!entry) {
			errors.push(`generated routing missing tier '${tier}'`);
			continue;
		}
		if (!Array.isArray(entry.models) || entry.models.length === 0) errors.push(`generated routing tier '${tier}' has an empty model chain`);
	}
	for (const role of DELEGATE_GRAPH_ROLES) {
		if (!parsed?.roles?.[role]) errors.push(`generated routing missing role '${role}'`);
	}
	return { ok: errors.length === 0, errors };
}

async function promptModel(io, tier, models) {
	io.write(`\nSelect a model for tier '${tier}':\n`);
	models.forEach((model, index) => {
		const context = model.contextWindow === undefined ? "" : ` (${model.contextWindow.toLocaleString("en-US")} tokens)`;
		const name = model.name ? ` — ${model.name}` : "";
		io.write(`  ${index + 1}. ${model.modelId}${name}${context}\n`);
	});
	for (;;) {
		const line = await io.readLine(`  enter a number 1-${models.length}: `);
		const index = Number.parseInt(String(line ?? "").trim(), 10);
		if (Number.isInteger(index) && index >= 1 && index <= models.length) return models[index - 1].modelId;
		io.write(`  invalid selection '${String(line ?? "").trim()}'.\n`);
	}
}

async function promptYesNo(io, promptText) {
	for (;;) {
		const line = await io.readLine(`${promptText} [y/N]: `);
		const value = String(line ?? "").trim().toLowerCase();
		if (value === "y" || value === "yes") return true;
		if (value === "" || value === "n" || value === "no") return false;
		io.write(`  invalid answer '${value}'.\n`);
	}
}

async function interactiveSelect(io, selectable, catalog) {
	const sorted = [...selectable].sort((a, b) => a.modelId.localeCompare(b.modelId));
	if (sorted.length === 0) throw new Error("no selectable models available in the catalog");
	const selections = {};
	for (const tier of REQUIRED_TIERS) selections[tier] = [await promptModel(io, tier, sorted)];
	const hasLocalModel = sorted.some((model) => catalog && isLocalModel(model.modelId, catalog));
	if (hasLocalModel && (await promptYesNo(io, "Configure the optional local-fast tier?"))) {
		selections["local-fast"] = [await promptModel(io, "local-fast", sorted)];
	}
	return selections;
}

function roleMappings() {
	return DELEGATE_GRAPH_ROLES.map((role) => ({ role, tier: ROLE_TIERS[role], capabilityFloor: ROLE_CAPABILITY_FLOORS[role] }));
}

function baseResult(args, context) {
	return {
		schemaVersion: 1,
		mode: args.mode,
		agentDir: context.agentDir,
		routingPath: context.routingPath,
		modelsPath: context.modelsPath,
		fzfPath: context.fzfPath,
		models: context.models,
		selectedModels: context.selections,
		roles: roleMappings(),
		piFzf: {
			installed: context.fzfPlan.installed,
			action: context.fzfPlan.action,
			reason: context.fzfPlan.reason ?? null,
			collisions: context.fzfPlan.collisions ?? [],
		},
		warnings: context.warnings ?? [],
		validation: context.routingValidation,
	};
}

function runNode(args, env = {}) {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function withTempRouting(routingText, run) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-wave-validate-"));
	const tempRouting = join(tempDir, "model-routing.jsonc");
	await writeFile(tempRouting, routingText);
	try {
		return await run(tempRouting);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function validateViaResolver(routingText, modelsPath) {
	return withTempRouting(routingText, (tempRouting) => {
		const result = runNode([
			join(packageRoot(), "scripts", "policy-resolver.mjs"),
			"--config", tempRouting,
			"--models", modelsPath,
			"--roles", DELEGATE_GRAPH_ROLES.join(","),
			"--input", JSON.stringify({ kind: "auto" }),
		]);
		if (result.status !== 0) return { ok: false, errors: [`policy-resolver rejected the generated routing: ${result.stderr.trim()}`] };
		let resolved = null;
		try {
			resolved = JSON.parse(result.stdout);
		} catch {
			resolved = null;
		}
		if (!resolved || resolved.ok !== true || !Array.isArray(resolved.roles)) return { ok: false, errors: ["policy-resolver did not return a valid resolution"] };
		const emptyRoles = resolved.roles.filter((route) => !Array.isArray(route.models) || route.models.length === 0).map((route) => route.role);
		if (emptyRoles.length) return { ok: false, errors: [`policy-resolver produced empty chains for: ${emptyRoles.join(", ")}`] };
		return { ok: true, errors: [] };
	});
}

async function validateViaRoutePicker(routingText, modelsPath) {
	return withTempRouting(routingText, (tempRouting) => {
		const result = runNode(["--experimental-strip-types", packageRoutePicker(), "--list"], { PI_MODEL_ROUTING: tempRouting, PI_MODEL_CATALOG: modelsPath });
		if (result.status === 0) {
			const listed = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
			const missing = DELEGATE_GRAPH_ROLES.filter((role) => !listed.includes(role));
			if (missing.length) return { ok: false, errors: [`route-picker missing roles: ${missing.join(", ")}`] };
			return { ok: true, errors: [] };
		}
		if (result.stderr.includes("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")) return { ok: true, errors: [] };
		return { ok: false, errors: [`route-picker rejected the generated routing: ${result.stderr.trim()}`] };
	});
}

async function runRollback(args) {
	if (!args.manifest) throw new Error("rollback requires --manifest");
	const result = await restoreBackup(args.manifest);
	return { schemaVersion: 1, mode: "rollback", ok: true, manifest: args.manifest, restored: result.restored.map((entry) => entry.destination) };
}

export async function runInit(argv = process.argv.slice(2), io = createIo()) {
	const args = parseArgs(argv);
	if (args.help) return { schemaVersion: 1, mode: args.mode, ok: true, help: usage() };
	if (args.mode === "rollback") return runRollback(args);

	const agentDir = resolveAgentDir(args.agentDir);
	const routingPath = resolveRoutingPath(agentDir, args.routing);
	const modelsPath = resolveCatalogPath(agentDir, args.models);
	const fzfPath = resolveFzfPath(agentDir);

	let catalog;
	try {
		catalog = loadCatalog(modelsPath);
	} catch (error) {
		return { schemaVersion: 1, mode: args.mode, ok: false, agentDir, routingPath, modelsPath, fzfPath, error: error instanceof Error ? error.message : String(error) };
	}
	const analysis = analyzeCatalog(catalog);
	if (analysis.problems.length > 0) {
		return {
			schemaVersion: 1,
			mode: args.mode,
			ok: false,
			agentDir,
			routingPath,
			modelsPath,
			fzfPath,
			errors: analysis.problems,
		};
	}

	const requiredMissing = REQUIRED_TIERS.filter((tier) => !args.selections[tier] || args.selections[tier].length === 0);
	let selections;
	let interactive = false;
	if (requiredMissing.length > 0) {
		if (args.nonInteractive) {
			return {
				schemaVersion: 1,
				mode: args.mode,
				ok: false,
				agentDir,
				routingPath,
				modelsPath,
				fzfPath,
				error: `non-interactive mode requires explicit model flags for: ${requiredMissing.join(", ")}`,
			};
		}
		selections = await interactiveSelect(io, analysis.selectable, catalog);
		interactive = true;
	} else {
		selections = { ...args.selections };
	}

	const selectionErrors = validateSelections(analysis, selections);
	if (selectionErrors.length > 0) {
		return {
			schemaVersion: 1,
			mode: args.mode,
			ok: false,
			agentDir,
			routingPath,
			modelsPath,
			fzfPath,
			selectedModels: selections,
			errors: selectionErrors,
		};
	}

	const chains = {};
	for (const tier of REQUIRED_TIERS) chains[tier] = selections[tier] ?? [];
	const includeLocalFast = Array.isArray(selections["local-fast"]) && selections["local-fast"].length > 0;
	if (includeLocalFast) chains["local-fast"] = selections["local-fast"];

	const routingText = generateRoutingTemplate({ chains, includeLocalFast });
	const routingBytes = Buffer.from(routingText, "utf8");
	const routingValidation = validateRouting(routingText, includeLocalFast);
	if (!routingValidation.ok) {
		return {
			schemaVersion: 1,
			mode: args.mode,
			ok: false,
			agentDir,
			routingPath,
			modelsPath,
			fzfPath,
			selectedModels: selections,
			errors: routingValidation.errors,
		};
	}

	const routingExists = existsSync(routingPath);
	const existingRoutingBytes = routingExists ? await readFile(routingPath) : undefined;
	const existingRoutingMode = routingExists ? (await stat(routingPath)).mode : undefined;

	const piFzf = detectPiFzf(agentDir);
	let fzfPlan = { installed: piFzf.installed, action: "skip", reason: piFzf.reason ?? "pi-fzf not installed", changed: false, collisions: [] };
	if (piFzf.installed) {
		const fzfBytes = existsSync(fzfPath) ? await readFile(fzfPath) : undefined;
		let originalParsed;
		if (fzfBytes) {
			try {
				originalParsed = JSON.parse(fzfBytes.toString("utf8"));
			} catch {
				return {
					schemaVersion: 1,
					mode: args.mode,
					ok: false,
					agentDir,
					routingPath,
					modelsPath,
					fzfPath,
					error: `existing fzf.json is not valid JSON; refusing to merge into '${fzfPath}'`,
				};
			}
		}
		const merged = mergeFzf(originalParsed, packageRoutePicker());
		fzfPlan = {
			installed: true,
			action: merged.changed ? "merge" : "no-change",
			reason: fzfBytes ? undefined : "creating a minimal fzf.json",
			changed: merged.changed,
			collisions: merged.collisions,
			bytes: merged.bytes,
			originalBytes: fzfBytes,
			originalParsed,
			existingMode: fzfBytes ? (await stat(fzfPath)).mode : undefined,
		};
	}

	const routingConflict = routingExists && existingRoutingBytes && !existingRoutingBytes.equals(routingBytes);
	const fzfConflict = fzfPlan.collisions.length > 0;
	const idempotent = Boolean(routingExists && existingRoutingBytes && existingRoutingBytes.equals(routingBytes) && !fzfPlan.changed);
	const needsForce = routingConflict || fzfConflict;
	const wouldWriteRouting = !routingExists || routingConflict;
	const wouldWriteFzf = fzfPlan.changed === true;

	const context = { agentDir, routingPath, modelsPath, fzfPath, selections, fzfPlan, routingValidation, warnings: analysis.warnings, models: analysis.selectable.map((model) => ({ modelId: model.modelId, name: model.name ?? null, contextWindow: model.contextWindow ?? null })) };
	const result = {
		...baseResult(args, context),
		ok: true,
		interactive,
		force: args.force,
		needsForce,
		routingExists,
		wouldChangeRouting: routingConflict,
		wouldWriteRouting,
		wouldWriteFzf,
		idempotent,
	};

	if (args.mode === "dry-run") return result;

	// apply is the only write mode
	if (needsForce && !args.force) {
		return { ...result, ok: false, error: "existing configuration differs; re-run with --force to back up and overwrite" };
	}
	if (idempotent) {
		return { ...result, ok: true, changed: false, idempotent: true, backupPath: null, routingWritten: false, fzfWritten: false };
	}

	// FR-15: validate the generated routing through the real policy resolver
	// and route picker before committing any files.
	const resolverValidation = await validateViaResolver(routingText, modelsPath);
	if (!resolverValidation.ok) return { ...result, ok: false, errors: resolverValidation.errors };
	const pickerValidation = await validateViaRoutePicker(routingText, modelsPath);
	if (!pickerValidation.ok) return { ...result, ok: false, errors: pickerValidation.errors };

	const backupEntries = [];
	if (wouldWriteRouting && routingExists && existingRoutingBytes) {
		backupEntries.push({ relativePath: "model-routing.jsonc", path: routingPath, existed: true, bytes: existingRoutingBytes, mode: existingRoutingMode });
	}
	if (wouldWriteFzf && fzfPlan.originalBytes) {
		backupEntries.push({ relativePath: "fzf.json", path: fzfPath, existed: true, bytes: fzfPlan.originalBytes, mode: fzfPlan.existingMode });
	}

	let backupPath = null;
	if (backupEntries.length > 0) {
		const id = args.backupId ?? defaultBackupId();
		const backup = await createBackup({ agentDir, id, entries: backupEntries });
		backupPath = backup.manifestPath;
	}

	let routingWritten = false;
	let fzfWritten = false;
	try {
		if (wouldWriteRouting) {
			await writeExact(routingPath, routingBytes, 0o600);
			routingWritten = true;
		}
		if (wouldWriteFzf) {
			await writeExact(fzfPath, fzfPlan.bytes, 0o600);
			fzfWritten = true;
		}
		if (backupPath) await finalizeBackup(backupPath, "applied");
		return { ...result, ok: true, changed: true, idempotent: false, backupPath, routingWritten, fzfWritten };
	} catch (error) {
		// FR-11: a write failure must leave prior state intact. Pre-existing files
		// are restored from the backup; a file this run created that did not exist
		// before (and therefore has no backup entry) is removed, so a partial
		// write cannot leave a half-configured routing or fzf file behind.
		if (backupPath) await restoreBackup(backupPath).catch(() => undefined);
		if (routingWritten && !routingExists) await unlink(routingPath).catch(() => undefined);
		if (fzfWritten && !fzfPlan.originalBytes) await unlink(fzfPath).catch(() => undefined);
		throw error;
	}
}

const isMain = ["init.mjs", "pi-agent-wave-init"].includes(basename(process.argv[1] ?? ""));
if (isMain) {
	(async () => {
		const io = createIo();
		try {
			const result = await runInit(process.argv.slice(2), io);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			process.exitCode = result.ok === false ? 1 : 0;
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		} finally {
			io.close();
		}
	})();
}
