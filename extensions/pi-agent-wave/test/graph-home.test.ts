import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_DB_PATH, DEFAULT_GRAPH_HOME, GraphStore } from "../store.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { packageRoot } from "./support/repoRoot.ts";

/** Shipped sources and configuration, never the test tree or an installed dependency. */
function shippedFiles(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "test" || entry.name === "node_modules" || entry.name === ".git") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) shippedFiles(path, found);
		// Python is walked too: the lifecycle in scripts/delegate_core.py resolves /tmp itself, and a
		// retired storage path reintroduced there would otherwise pass this guard.
		else if (/\.(ts|mjs|py)$/.test(entry.name)) found.push(path);
	}
	return found;
}

describe("graph home durability", () => {
	test("the default home is durable rather than a reclamable cache directory", () => {
		assert.equal(DEFAULT_GRAPH_HOME, join(homedir(), ".local", "share", "delegate-graph"));
		assert.equal(DEFAULT_DB_PATH, join(DEFAULT_GRAPH_HOME, "delegate-graph.db"));
		assert.ok(!DEFAULT_DB_PATH.includes(".cache"), "a cache directory invites reclamation, and prune cascades");
	});

	test("no shipped module resolves the retired cache home", () => {
		// The README deliberately names the old path as history; shipped code must not resolve it. The walk
		// covers .py as well as .ts/.mjs, so the Python lifecycle is held to the same rule.
		const walked = shippedFiles(packageRoot);
		assert.ok(walked.some((path) => path.endsWith("delegate_core.py")), "the walk must really reach Python sources");
		const offenders = walked.filter((path) => readFileSync(path, "utf8").includes(".cache/delegate-graph"));
		assert.deepEqual(offenders.map((path) => relative(packageRoot, path)), []);
	});

	test("retained content is created beside the configured database, wherever that is", () => {
		const root = mkdtempSync(join(tmpdir(), "graph-home-"));
		const dbPath = join(root, "nested", "graph.db");
		const saved = process.env.DELEGATE_GRAPH_DB;
		process.env.DELEGATE_GRAPH_DB = dbPath;
		try {
			const store = new GraphStore();
			try {
				assert.equal(store.dbPath, dbPath, "the configured database wins over the default home");
				const content = new RuntimeContentStore(store.dbPath);
				content.retain(Buffer.from("retained\n"));
				assert.ok(readdirSync(join(root, "nested")).includes("runtime-content"), "content lives beside the database, not under the default home");
			} finally { store.close(); }
		} finally {
			if (saved === undefined) delete process.env.DELEGATE_GRAPH_DB; else process.env.DELEGATE_GRAPH_DB = saved;
			rmSync(root, { recursive: true, force: true });
		}
	});
});