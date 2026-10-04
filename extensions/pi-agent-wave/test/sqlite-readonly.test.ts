import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../sqlite.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a readonly Database reads but refuses to write", () => {
	const root = mkdtempSync(join(tmpdir(), "sqlite-readonly-"));
	dirs.push(root);
	const path = join(root, "graph.db");
	const writer = new Database(path);
	writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
	writer.close();

	const reader = new Database(path, { readonly: true });
	try {
		assert.equal(reader.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()?.n, 1);
		assert.throws(() => reader.exec("INSERT INTO t VALUES (2)"), /readonly/);
	} finally { reader.close(); }

	const check = new Database(path);
	try { assert.equal(check.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()?.n, 1); } finally { check.close(); }
});
