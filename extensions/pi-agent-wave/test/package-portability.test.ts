import { describe, expect, test } from "./test-api.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".mjs", ".js", ".py"]);

function walk(path: string): string[] {
	if (!existsSync(path)) return [];
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

function sourceFiles(): string[] {
	return walk(ROOT).filter((path) => {
		if (path.includes(`${join(ROOT, "test")}/`) || path.includes(`${join(ROOT, "node_modules")}/`)) return false;
		return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")));
	});
}

describe("package portability", () => {
	test("shipped source contains no host paths or escaped imports", () => {
		const forbidden = [/\/Users\/spotted/, /\/opt\/homebrew/, /\.\.\/\.\.\/npm\/node_modules/, /from\s+["']@mariozechner\/pi-coding-agent["']/, new RegExp("PIPELINE" + "_")];
		for (const path of sourceFiles()) {
			const source = readFileSync(path, "utf8");
			const packageRelative = relative(ROOT, path);
			for (const pattern of forbidden) expect(source, packageRelative).not.toMatch(pattern);
			if (packageRelative !== join("scripts", "migrate.mjs")) expect(source, packageRelative).not.toContain(join("extensions", "delegate-" + "graph"));
			for (const match of source.matchAll(/(?:from\s+|import\()["']([^"']+)["']/g)) {
				const specifier = match[1];
				if (!specifier.startsWith(".")) continue;
				const target = resolve(dirname(path), specifier);
				expect(relative(ROOT, target).startsWith(".."), `${relative(ROOT, path)} -> ${specifier}`).toBe(false);
			}
		}
	});

	test("shipped source contains no panel transport", () => {
		for (const path of sourceFiles()) {
			const source = readFileSync(path, "utf8");
			const packageRelative = relative(ROOT, path);
			expect(/\bpanel\b/i.test(source), packageRelative).toBe(false);
			expect(source.includes("PANEL_"), packageRelative).toBe(false);
		}
	});

	test("uses bare Pi package imports at the repaired boundaries", () => {
		expect(readFileSync(join(ROOT, "delegation-identity.ts"), "utf8")).toContain('from "@earendil-works/pi-tui"');
		expect(readFileSync(join(ROOT, "index.ts"), "utf8")).toContain('from "typebox"');
		expect(readFileSync(join(ROOT, "cmux-session.ts"), "utf8")).toContain('from "@earendil-works/pi-coding-agent"');
	});

	test("resolves routing from explicit overrides then PI_CODING_AGENT_DIR", async () => {
		const previous = { ...process.env };
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-wave-agent";
			process.env.PI_MODEL_ROUTING = "/tmp/explicit-routing.jsonc";
			process.env.PI_MODEL_CATALOG = "/tmp/explicit-models.json";
			delete process.env.PI_AGENT_DIR;
			const routePicker = await import(`../route-picker.ts?portability=${Date.now()}`);
			expect(routePicker.resolveAgentDir()).toBe("/tmp/pi-agent-wave-agent");
			expect(routePicker.resolveRoutingPath()).toBe("/tmp/explicit-routing.jsonc");
			expect(routePicker.resolveCatalogPath()).toBe("/tmp/explicit-models.json");
			delete process.env.PI_MODEL_ROUTING;
			delete process.env.PI_MODEL_CATALOG;
			expect(routePicker.resolveRoutingPath()).toBe("/tmp/pi-agent-wave-agent/model-routing.jsonc");
			expect(routePicker.resolveCatalogPath()).toBe("/tmp/pi-agent-wave-agent/models.json");
		} finally {
			process.env = previous;
		}
	});

	// A duplicated helper drifts: `lib/model-failover-native.mjs` existed here and in
	// `$PI_CODING_AGENT_DIR/lib` with different content, and only the package copy was covered by
	// tests. `lib/jsonc.mjs` is still present in both trees and is byte-identical, so the durable
	// invariant is "no diverged twin", not "no twin". Declaration files are skipped: they carry no
	// runtime behaviour and legitimately differ in extension between the trees.
	test("shipped lib code has no diverged twin in the agent directory", () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
		const agentLib = join(agentDir, "lib");
		if (!existsSync(agentLib)) return;
		const stem = (name: string) => name.replace(/\.(?:test\.)?(?:ts|mjs|js|py)(?:\.test)?$/, "").replace(/\.d$/, "");
		const shipped = readdirSync(join(ROOT, "lib"));
		const twins = readdirSync(agentLib).filter((name) => !name.includes(".test.") && !name.endsWith(".d.ts") && !name.endsWith(".d.mts"));
		for (const twin of twins) {
			const twinPath = join(agentLib, twin);
			if (!statSync(twinPath).isFile()) continue;
			const match = shipped.filter((name) => !name.includes(".test.") && !name.endsWith(".d.ts") && !name.endsWith(".d.mts") && stem(name) === stem(twin));
			for (const name of match) {
				const shippedText = readFileSync(join(ROOT, "lib", name), "utf8");
				expect(readFileSync(twinPath, "utf8"), `${twin} diverged from shipped ${name}`).toBe(shippedText);
			}
		}
	});
});
