import { afterEach, describe, expect, test } from "./test-api.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATE = join(ROOT, "scripts", "migrate.mjs");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const temporaryRoots: string[] = [];

function hashPath(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const hash = createHash("sha256");
	function visit(current: string): void {
		const stat = lstatSync(current);
		hash.update(`${relative(path, current) || "."}\0${stat.isDirectory() ? "d" : "f"}\0`);
		if (stat.isDirectory()) for (const entry of readdirSync(current).sort()) visit(join(current, entry));
		else hash.update(readFileSync(current));
	}
	visit(path);
	return hash.digest("hex");
}

async function fixture(): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-wave-migration-"));
	temporaryRoots.push(agentDir);
	await mkdir(join(agentDir, "extensions", "delegate-graph"), { recursive: true });
	await writeFile(join(agentDir, "extensions", "delegate-graph", "index.ts"), "delegate graph\n");
	for (const [name, content] of [["questionnaire.ts", "questionnaire\n"], ["cmux-session.ts", "cmux\n"], ["model-failover.ts", "failover\n"], ["herdr-agent-state.ts", "herdr-owned\n"]]) {
		await writeFile(join(agentDir, "extensions", name), content);
	}
	await writeFile(join(agentDir, "settings.json"), '{"packages":["npm:existing"]}\n');
	await writeFile(join(agentDir, "fzf.json"), `${JSON.stringify({
		commands: {
			route: {
				list: "node --experimental-strip-types ~/.pi/agent/extensions/delegate-graph/route-picker.ts --list",
				preview: "node --experimental-strip-types ~/.pi/agent/extensions/delegate-graph/route-picker.ts --preview '{{selected}}'",
			},
			"delegate-model": {
				list: "node --experimental-strip-types ~/.pi/agent/extensions/delegate-graph/route-picker.ts --list",
				preview: "node --experimental-strip-types ~/.pi/agent/extensions/delegate-graph/route-picker.ts --preview '{{selected}}'",
			},
			unrelated: { list: "printf unchanged" },
		},
	}, null, 2)}\n`);
	await writeFile(join(agentDir, "model-routing.jsonc"), `${JSON.stringify({
		tiers: { tools: { models: ["fixture/local"], thinking: "off", session: false } },
		roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])),
	}, null, 2)}\n`);
	await writeFile(join(agentDir, "models.json"), '{"providers":{"fixture":{"baseUrl":"http://127.0.0.1:1/v1"}}}\n');
	return agentDir;
}

function invoke(args: string[]) {
	return spawnSync("node", [MIGRATE, ...args], { encoding: "utf8" });
}

function run(args: string[]): any {
	const result = invoke(args);
	if (result.status !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout);
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("loose-install migration", () => {
	test("preflight and default dry-run are read-only and exclude Herdr-managed files", async () => {
		const agentDir = await fixture();
		const before = hashPath(agentDir);
		const preflight = run(["preflight", "--agent-dir", agentDir, "--backup-id", "fixture"]);
		expect(preflight.mode).toBe("preflight");
		expect(preflight.conflicts.map((entry: any) => entry.relativePath)).toEqual([
			"extensions/delegate-graph",
			"extensions/questionnaire.ts",
			"extensions/cmux-session.ts",
			"extensions/model-failover.ts",
		]);
		expect(preflight.excluded).toEqual([{ relativePath: "extensions/herdr-agent-state.ts", exists: true }]);
		expect(preflight.configChanges).toHaveLength(1);
		expect(preflight.configChanges[0]).toMatchObject({ relativePath: "fzf.json", replacements: 4 });
		expect(preflight.operations.some((operation: any) => operation.type === "rewrite-config" && operation.path === join(agentDir, "fzf.json"))).toBe(true);
		expect(hashPath(agentDir)).toBe(before);

		const dryRun = run(["--agent-dir", agentDir, "--backup-id", "fixture"]);
		expect(dryRun.mode).toBe("dry-run");
		expect(dryRun.operations.at(-1)).toMatchObject({ type: "enable-package", source: "npm:@dpugliese/pi-agent-wave" });
		expect(hashPath(agentDir)).toBe(before);
		expect(existsSync(join(agentDir, "migration-backups"))).toBe(false);
	});

	test("apply backs up conflicts and rollback restores exact files and settings", async () => {
		const agentDir = await fixture();
		const settingsPath = join(agentDir, "settings.json");
		const originalSettings = await readFile(settingsPath);
		const fzfPath = join(agentDir, "fzf.json");
		const originalFzf = await readFile(fzfPath);
		const originals = new Map([
			["extensions/delegate-graph", hashPath(join(agentDir, "extensions", "delegate-graph"))],
			["extensions/questionnaire.ts", hashPath(join(agentDir, "extensions", "questionnaire.ts"))],
			["extensions/cmux-session.ts", hashPath(join(agentDir, "extensions", "cmux-session.ts"))],
			["extensions/model-failover.ts", hashPath(join(agentDir, "extensions", "model-failover.ts"))],
		]);
		const herdrHash = hashPath(join(agentDir, "extensions", "herdr-agent-state.ts"));

		const applied = run(["apply", "--agent-dir", agentDir, "--backup-id", "fixture"]);
		expect(applied.status).toBe("applied");
		expect(applied.manifestPath.startsWith(join(agentDir, "extensions"))).toBe(false);
		for (const relativePath of originals.keys()) expect(existsSync(join(agentDir, relativePath))).toBe(false);
		expect(hashPath(join(agentDir, "extensions", "herdr-agent-state.ts"))).toBe(herdrHash);
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(settings.packages.filter((entry: unknown) => entry === "npm:@dpugliese/pi-agent-wave")).toHaveLength(1);
		const fzf = JSON.parse(await readFile(fzfPath, "utf8"));
		const packageRoutePicker = join(ROOT, "route-picker.ts");
		for (const name of ["route", "delegate-model"]) {
			expect(fzf.commands[name].list).toContain(packageRoutePicker);
			expect(fzf.commands[name].preview).toContain(packageRoutePicker);
			expect(fzf.commands[name].list).not.toContain("extensions/delegate-graph");
		}
		expect(fzf.commands.unrelated).toEqual({ list: "printf unchanged" });
		const routeList = spawnSync("bash", ["-lc", fzf.commands["delegate-model"].list], {
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		expect(routeList.status).toBe(0);
		expect(routeList.stdout.trim().split("\n")).toEqual(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"]);
		const afterApplyPlan = run(["--agent-dir", agentDir, "--backup-id", "second-preview"]);
		expect(afterApplyPlan.configChanges).toEqual([]);

		const rolledBack = run(["rollback", "--manifest", applied.manifestPath]);
		expect(rolledBack.status).toBe("rolled-back");
		for (const [relativePath, hash] of originals) expect(hashPath(join(agentDir, relativePath))).toBe(hash);
		expect(await readFile(settingsPath)).toEqual(originalSettings);
		expect(await readFile(fzfPath)).toEqual(originalFzf);
		expect(hashPath(join(agentDir, "extensions", "herdr-agent-state.ts"))).toBe(herdrHash);
	});

	test("rejects unsafe backup identifiers without changing the target", async () => {
		const agentDir = await fixture();
		const before = hashPath(agentDir);
		const result = invoke(["apply", "--agent-dir", agentDir, "--backup-id", "../extensions/escape"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("backup id");
		expect(hashPath(agentDir)).toBe(before);
	});

	test("writes private backup metadata and rejects a tampered rollback manifest", async () => {
		const agentDir = await fixture();
		const applied = run(["apply", "--agent-dir", agentDir, "--backup-id", "private-fixture"]);
		expect(lstatSync(applied.backupRoot).mode & 0o777).toBe(0o700);
		expect(lstatSync(applied.manifestPath).mode & 0o777).toBe(0o600);
		const originalManifest = await readFile(applied.manifestPath);
		const tampered = JSON.parse(originalManifest.toString("utf8"));
		tampered.moved[0].source = join(tmpdir(), "outside-agent-dir");
		await writeFile(applied.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
		const rejected = invoke(["rollback", "--manifest", applied.manifestPath]);
		expect(rejected.status).not.toBe(0);
		expect(rejected.stderr).toContain("manifest path");
		expect(existsSync(join(agentDir, "extensions", "delegate-graph"))).toBe(false);
		await writeFile(applied.manifestPath, originalManifest, { mode: 0o600 });
		run(["rollback", "--manifest", applied.manifestPath]);
	});

	test("fake-home migration never mutates the real Pi installation", async () => {
		const realAgentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent");
		const protectedPaths = ["extensions/delegate-graph", "extensions/questionnaire.ts", "extensions/cmux-session.ts", "extensions/model-failover.ts", "extensions/herdr-agent-state.ts", "settings.json", "fzf.json"];
		const before = protectedPaths.map((path) => hashPath(join(realAgentDir, path)));
		const agentDir = await fixture();
		const applied = run(["apply", "--agent-dir", agentDir, "--backup-id", "real-install-guard"]);
		run(["rollback", "--manifest", applied.manifestPath]);
		expect(protectedPaths.map((path) => hashPath(join(realAgentDir, path)))).toEqual(before);
	});

	test("manifest lists Delegate Graph and each selected companion exactly once", () => {
		expect(manifest.pi.extensions).toEqual(["index.ts", "questionnaire.ts", "cmux-session.ts", "model-failover.ts"]);
		expect(new Set(manifest.pi.extensions).size).toBe(4);
	});
});
