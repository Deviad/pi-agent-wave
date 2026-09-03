#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveCatalogPath, resolveFzfPath, resolveRoutingPath } from "../lib/agent-paths.mjs";
import { analyzeCatalog, isLocalModel, loadCatalog } from "../lib/catalog.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { detectPiFzf, fzfCommandTargets, packageRoutePicker } from "../lib/pi-fzf.mjs";
import { DELEGATE_GRAPH_ROLES, REQUIRED_TIERS } from "../lib/routing-template.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ENTRY_POINTS = ["index.ts", "questionnaire.ts", "cmux-session.ts", "model-failover.ts"];
const FZF_TARGET_COMMANDS = ["route", "delegate-model"];
const FZF_TARGET_FIELDS = ["list", "preview"];

export function parseArgs(argv) {
	const args = { agentDir: undefined, routing: undefined, models: undefined, json: false, help: false };
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--agent-dir") args.agentDir = argv[++index];
		else if (value === "--routing") args.routing = argv[++index];
		else if (value === "--models") args.models = argv[++index];
		else if (value === "--json") args.json = true;
		else if (value === "--help" || value === "-h") args.help = true;
		else throw new Error(`unknown argument '${value}'`);
	}
	return args;
}

function check(name, status, detail) {
	return { check: name, status, detail };
}

function runNode(args, env = {}) {
	const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env } });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runExternal(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", env: process.env, shell: false });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function observedVersion(result) {
	return `${result.stdout}${result.stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
}

export function runDoctor(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const agentDir = resolveAgentDir(args.agentDir);
	const routingPath = resolveRoutingPath(agentDir, args.routing);
	const modelsPath = resolveCatalogPath(agentDir, args.models);
	const fzfPath = resolveFzfPath(agentDir);
	const checks = [];

	// Optional Herdr presentation capability
	const herdr = runExternal("herdr", ["--version"]);
	const herdrIdentityComplete = process.env.HERDR_ENV === "1" && !!process.env.HERDR_WORKSPACE_ID?.trim() && !!process.env.HERDR_TAB_ID?.trim();
	if (herdr.error || herdr.status !== 0) checks.push(check("herdr-presentation", "warn", "optional Herdr presentation is unavailable; headless transport remains available"));
	else if (herdrIdentityComplete) checks.push(check("herdr-presentation", "ok", "optional Herdr presentation is active"));
	else checks.push(check("herdr-presentation", "warn", "optional Herdr presentation is installed but inactive; headless transport remains available"));

	// Mandatory external execution and sandbox runtimes
	const acpx = runExternal("acpx", ["--version"]);
	if (acpx.error || acpx.status !== 0) checks.push(check("acpx-executable", "fail", "acpx is unavailable"));
	else {
		const version = observedVersion(acpx);
		checks.push(check("acpx-executable", "ok", "acpx"));
		checks.push(version === "0.13.2" ? check("acpx-version", "ok", version) : check("acpx-version", "fail", `expected 0.13.2, found ${version}`));
		for (const agent of ["pi", "codex", "claude"]) {
			const probe = runExternal("acpx", [agent, "--help"]);
			checks.push(probe.status === 0 ? check(`acpx-${agent}-adapter`, "ok", `${agent} registered`) : check(`acpx-${agent}-adapter`, "fail", `${agent} adapter unavailable`));
		}
		try {
			const tokenPath = process.env.PI_CLAUDE_OAUTH_TOKEN_FILE;
			if (!tokenPath) throw new Error("missing");
			const metadata = statSync(tokenPath);
			const token = readFileSync(tokenPath, "utf8").trim();
			checks.push(metadata.isFile() && (metadata.mode & 0o077) === 0 && token.startsWith("sk-ant-oat")
				? check("claude-setup-token", "ok", "mode-600 token file is ready")
				: check("claude-setup-token", "warn", "token file is invalid or not private"));
		} catch {
			checks.push(check("claude-setup-token", "warn", "PI_CLAUDE_OAUTH_TOKEN_FILE is not configured"));
		}
	}
	const agentfs = runExternal("agentfs", ["--version"]);
	if (agentfs.error || agentfs.status !== 0) checks.push(check("agentfs-executable", "fail", "agentfs is unavailable"));
	else {
		const version = observedVersion(agentfs);
		checks.push(check("agentfs-executable", "ok", "agentfs"));
		checks.push(version === "0.6.4" ? check("agentfs-version", "ok", version) : check("agentfs-version", "fail", `expected 0.6.4, found ${version}`));
		const sandbox = runExternal("agentfs", ["run", "--help"]);
		checks.push(["darwin", "linux"].includes(process.platform) && sandbox.status === 0 ? check("agentfs-platform-sandbox", "ok", process.platform) : check("agentfs-platform-sandbox", "fail", `unsupported or unavailable on ${process.platform}`));
	}

	// Agent-directory resolution
	if (!existsSync(agentDir)) checks.push(check("agent-dir", "fail", `agent directory '${agentDir}' does not exist`));
	else if (!statSync(agentDir).isDirectory()) checks.push(check("agent-dir", "fail", `agent path '${agentDir}' is not a directory`));
	else checks.push(check("agent-dir", "ok", agentDir));

	// Model catalog readability
	let catalog = null;
	let catalogProblems = [];
	let catalogWarnings = [];
	let selectableIds = new Set();
	try {
		catalog = loadCatalog(modelsPath);
		const analysis = analyzeCatalog(catalog);
		catalogProblems = analysis.problems;
		catalogWarnings = analysis.warnings;
		selectableIds = new Set(analysis.selectable.map((model) => model.modelId));
		if (catalogProblems.length > 0) checks.push(check("catalog", "fail", catalogProblems.join("; ")));
		else if (catalogWarnings.length > 0) checks.push(check("catalog", "warn", `${analysis.selectable.length} selectable models; ${catalogWarnings.length} excluded: ${catalogWarnings.join("; ")}`));
		else checks.push(check("catalog", "ok", `${analysis.selectable.length} selectable models`));
	} catch (error) {
		checks.push(check("catalog", "fail", error instanceof Error ? error.message : String(error)));
	}

	// Routing JSONC parseability
	let routing = null;
	if (!existsSync(routingPath)) {
		checks.push(check("routing-parse", "fail", `missing routing file '${routingPath}'`));
	} else {
		try {
			routing = parseJsonc(readFileSync(routingPath, "utf8"), routingPath);
			checks.push(check("routing-parse", "ok", routingPath));
		} catch (error) {
			checks.push(check("routing-parse", "fail", error instanceof Error ? error.message : String(error)));
		}
	}

	// Required tiers, roles, chains, membership, loopback
	if (routing) {
		const tiers = routing.tiers ?? {};
		const roles = routing.roles ?? {};
		const missingTiers = REQUIRED_TIERS.filter((tier) => !tiers[tier]);
		const missingRoles = DELEGATE_GRAPH_ROLES.filter((role) => !roles[role]);
		checks.push(missingTiers.length ? check("required-tiers", "fail", `missing tiers: ${missingTiers.join(", ")}`) : check("required-tiers", "ok", REQUIRED_TIERS.join(", ")));
		checks.push(missingRoles.length ? check("required-roles", "fail", `missing roles: ${missingRoles.join(", ")}`) : check("required-roles", "ok", DELEGATE_GRAPH_ROLES.join(", ")));

		const chainProblems = [];
		const membershipProblems = [];
		const localModels = new Set();
		for (const tier of REQUIRED_TIERS) {
			const models = Array.isArray(tiers[tier]?.models) ? tiers[tier].models.map(String).filter(Boolean) : [];
			if (models.length === 0) chainProblems.push(`tier '${tier}' has an empty model chain`);
			for (const model of models) {
				if (!selectableIds.has(model)) membershipProblems.push(`'${model}' in tier '${tier}' is not in the catalog`);
				if (catalog && isLocalModel(model, catalog)) localModels.add(model);
			}
		}
		checks.push(chainProblems.length ? check("non-empty-chains", "fail", chainProblems.join("; ")) : check("non-empty-chains", "ok", "all required tiers have non-empty chains"));
		checks.push(membershipProblems.length ? check("catalog-membership", "fail", membershipProblems.join("; ")) : check("catalog-membership", "ok", "every chain entry is in the catalog"));

		const localFastModels = Array.isArray(tiers["local-fast"]?.models) ? tiers["local-fast"].models.map(String).filter(Boolean) : [];
		const nonLocalFast = localFastModels.filter((model) => !(catalog && isLocalModel(model, catalog)));
		if (localFastModels.length > 0 && nonLocalFast.length > 0) checks.push(check("loopback", "warn", `local-fast tier contains non-local models: ${nonLocalFast.join(", ")}`));
		else checks.push(check("loopback", "ok", localModels.size ? `local models: ${[...localModels].join(", ")}` : "no local models detected"));
	}

	// pi-fzf detection and command targets
	const piFzf = detectPiFzf(agentDir);
	if (!piFzf.installed) {
		checks.push(check("pi-fzf", "warn", piFzf.reason ?? "pi-fzf not installed"));
	} else if (!existsSync(fzfPath)) {
		checks.push(check("pi-fzf", "warn", `pi-fzf installed but '${fzfPath}' is absent`));
	} else {
		const targets = fzfCommandTargets(packageRoutePicker());
		const mismatches = [];
		try {
			const fzf = JSON.parse(readFileSync(fzfPath, "utf8"));
			for (const commandName of FZF_TARGET_COMMANDS) {
				const command = fzf?.commands?.[commandName];
				if (!command || typeof command !== "object") {
					mismatches.push(`${commandName} command missing`);
					continue;
				}
				for (const field of FZF_TARGET_FIELDS) {
					if (command[field] !== targets[commandName][field]) mismatches.push(`${commandName}.${field} does not target the package route picker`);
				}
			}
		} catch (error) {
			mismatches.push(`fzf.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		checks.push(mismatches.length ? check("pi-fzf-targets", "warn", mismatches.join("; ")) : check("pi-fzf-targets", "ok", "route and delegate-model commands target the package route picker"));
	}

	// Package entry points
	const missingEntries = PACKAGE_ENTRY_POINTS.filter((entry) => !existsSync(join(PACKAGE_ROOT, entry)));
	checks.push(missingEntries.length ? check("entry-points", "fail", `missing package entry points: ${missingEntries.join(", ")}`) : check("entry-points", "ok", PACKAGE_ENTRY_POINTS.join(", ")));

	// Real policy-resolver execution
	if (routing && existsSync(modelsPath)) {
		const resolver = runNode([
			join(PACKAGE_ROOT, "scripts", "policy-resolver.mjs"),
			"--config", routingPath,
			"--models", modelsPath,
			"--roles", DELEGATE_GRAPH_ROLES.join(","),
			"--input", JSON.stringify({ kind: "auto" }),
		]);
		if (resolver.status !== 0) {
			checks.push(check("resolver", "fail", `policy-resolver exited ${resolver.status}: ${resolver.stderr.trim()}`));
		} else {
			let resolved = null;
			try {
				resolved = JSON.parse(resolver.stdout);
			} catch {
				resolved = null;
			}
			if (!resolved || resolved.ok !== true || !Array.isArray(resolved.roles) || resolved.roles.length !== DELEGATE_GRAPH_ROLES.length) {
				checks.push(check("resolver", "fail", "policy-resolver did not resolve all six roles"));
			} else {
				const emptyRoles = resolved.roles.filter((route) => !Array.isArray(route.models) || route.models.length === 0).map((route) => route.role);
				checks.push(emptyRoles.length ? check("resolver", "fail", `resolver produced empty chains for: ${emptyRoles.join(", ")}`) : check("resolver", "ok", "policy-resolver resolved all six roles with non-empty chains"));
			}
		}
	} else {
		checks.push(check("resolver", "fail", "skipped: routing or catalog unreadable"));
	}

	// Real route-picker --list execution. Honor the same --routing/--models
	// overrides the resolver check uses so the picker probe reads the diagnosed
	// configuration rather than the inherited environment.
	const pickerEnv = {};
	if (routing && existsSync(routingPath)) pickerEnv.PI_MODEL_ROUTING = routingPath;
	if (existsSync(modelsPath)) pickerEnv.PI_MODEL_CATALOG = modelsPath;
	const picker = runNode(["--experimental-strip-types", join(PACKAGE_ROOT, "route-picker.ts"), "--list"], pickerEnv);
	if (picker.status !== 0) {
		if (picker.stderr.includes("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")) {
			// Node refuses to strip types for files under node_modules; in a real
			// npm install the picker loads through Pi's own loader, so the
			// standalone --list probe is unavailable rather than broken.
			checks.push(check("route-picker", "warn", "standalone route-picker CLI unavailable under node_modules; verify via the /route command"));
		} else {
			checks.push(check("route-picker", "fail", `route-picker exited ${picker.status}: ${picker.stderr.trim()}`));
		}
	} else {
		const listed = picker.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		const missingRoles = DELEGATE_GRAPH_ROLES.filter((role) => !listed.includes(role));
		checks.push(missingRoles.length ? check("route-picker", "fail", `route-picker missing roles: ${missingRoles.join(", ")}`) : check("route-picker", "ok", DELEGATE_GRAPH_ROLES.join(", ")));
	}

	const fatal = checks.filter((entry) => entry.status === "fail");
	const warnings = checks.filter((entry) => entry.status === "warn");
	return {
		schemaVersion: 1,
		ok: fatal.length === 0,
		agentDir,
		routingPath,
		modelsPath,
		fzfPath,
		fatal: fatal.map(({ check: name, detail }) => ({ check: name, detail })),
		warnings: warnings.map(({ check: name, detail }) => ({ check: name, detail })),
		checks,
	};
}

export function renderHuman(result) {
	const lines = [];
	lines.push(`pi-agent-wave-doctor: ${result.ok ? "OK" : "FAILED"}`);
	lines.push(`  agent directory: ${result.agentDir}`);
	lines.push(`  routing: ${result.routingPath}`);
	lines.push(`  catalog: ${result.modelsPath}`);
	lines.push(`  fzf: ${result.fzfPath}`);
	lines.push("");
	for (const entry of result.checks) {
		const mark = entry.status === "ok" ? "ok" : entry.status === "warn" ? "warn" : "FAIL";
		lines.push(`  [${mark}] ${entry.check}: ${entry.detail}`);
	}
	return lines.join("\n");
}

const isMain = ["doctor.mjs", "pi-agent-wave-doctor"].includes(basename(process.argv[1] ?? ""));

if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write("usage: pi-agent-wave-doctor [--json] [--agent-dir <path>] [--routing <path>] [--models <path>]\n");
		process.exitCode = 0;
	} else {
		const result = runDoctor(process.argv.slice(2));
		if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else process.stdout.write(`${renderHuman(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
	}
}
