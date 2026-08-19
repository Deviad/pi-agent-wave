import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditLedger, writeLedgerEntry } from "../scripts/ledger.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "delegate-ledger-json-"));
	dirs.push(dir);
	const report = join(dir, "report.json");
	writeFileSync(report, JSON.stringify({
		schemaVersion: 1,
		verdict: "PASS",
		claims: [{ statement: "check passed", evidence: [{ kind: "command", source: "node --test", detail: "exit 0" }], verification: "verified" }],
	}), { mode: 0o600 });
	return { dir, report, base: join(dir, "output") };
}

function options(base: string, reportPath: string, topic = "review") {
	return { story: "story", topic, runId: "run-1", tier: "review", model: "provider/model", outcome: "accepted" as const, task: "Review output", reportPath, base, now: new Date("2026-08-17T00:00:00Z") };
}

describe("JSON evidence ledger", () => {
	test("writes private sequenced entries and audits them", async () => {
		const { base, report } = fixture();
		const first = await writeLedgerEntry(options(base, report));
		const second = await writeLedgerEntry(options(base, report, "tester result"));
		assert.match(first, /01-review\.json$/);
		assert.match(second, /02-tester-result\.json$/);
		assert.equal(statSync(first).mode & 0o777, 0o600);
		const parsed = JSON.parse(readFileSync(first, "utf8"));
		assert.equal(parsed.schemaVersion, 1);
		assert.equal(parsed.report.verdict, "PASS");
		assert.deepEqual(await auditLedger("story", base), { valid: true, findings: [], files: 2, summary: "PASS: audited 2 ledger files" });
	});

	test("serializes concurrent writers without overwriting", async () => {
		const { base, report } = fixture();
		const paths = await Promise.all(Array.from({ length: 4 }, (_, index) => writeLedgerEntry(options(base, report, `topic ${index}`))));
		assert.equal(new Set(paths).size, 4);
		assert.deepEqual(paths.map((path) => Number.parseInt(path.match(/\/(\d+)-/)?.[1] ?? "0", 10)).sort((a, b) => a - b), [1, 2, 3, 4]);
	});

	test("requires rejected-candidate marking for failed positive verdicts", async () => {
		const { base, report } = fixture();
		await assert.rejects(() => writeLedgerEntry({ ...options(base, report), outcome: "failed", task: "ordinary failure" }), /rejected candidate/);
		const path = await writeLedgerEntry({ ...options(base, report), outcome: "failed", task: "rejected candidate: malformed first result" });
		assert.ok(path.endsWith("01-review.json"));
	});

	test("preserves a malformed rejected candidate inside a valid JSON ledger entry", async () => {
		const { base, report } = fixture();
		writeFileSync(report, "not json", { mode: 0o600 });
		const path = await writeLedgerEntry({ ...options(base, report), outcome: "failed", task: "rejected candidate: malformed JSON" });
		const entry = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(entry.report, undefined);
		assert.equal(entry.rejectedCandidate.raw, "not json");
		assert.equal(entry.rejectedCandidate.diagnostics[0].code, "JSON_PARSE");
		assert.equal((await auditLedger("story", base)).valid, true);
	});

	test("rejects invalid outcomes before writing", async () => {
		const { base, report } = fixture();
		await assert.rejects(() => writeLedgerEntry({ ...options(base, report), outcome: "unknown" as never }), /unsupported ledger outcome/);
	});

	test("audits historical Markdown without rewriting it", async () => {
		const { base } = fixture();
		const directory = join(base, "legacy", "delegate-ledger");
		const legacy = join(directory, "01-old.md");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
		writeFileSync(legacy, "Run: old | Tier: review | Model: model | Outcome: accepted\n## Claim: old\nEvidence: command output\nVerified: yes\n", { mode: 0o600 });
		const before = readFileSync(legacy, "utf8");
		assert.deepEqual(await auditLedger("legacy", base), { valid: true, findings: [], files: 1, summary: "PASS: audited 1 ledger files" });
		assert.equal(readFileSync(legacy, "utf8"), before);
	});

	test("recomputes declared aggregates from their components", async () => {
		const { base, report } = fixture();
		const path = await writeLedgerEntry({ ...options(base, report), aggregates: [{ name: "matched", numerator: 9, denominator: 10, percentage: 100 }] });
		const result = await auditLedger("story", base);
		assert.equal(result.valid, false);
		assert.equal(result.findings[0]?.code, "AGGREGATE_MISMATCH");
		assert.match(result.findings[0]?.message ?? "", /does not equal 90/);
		assert.ok(path.endsWith("01-review.json"));
	});

	test("reports malformed JSON ledger entries", async () => {
		const { base } = fixture();
		const path = join(base, "broken", "delegate-ledger", "01-broken.json");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
		writeFileSync(path, "{", { mode: 0o644 });
		const result = await auditLedger("broken", base);
		assert.equal(result.valid, false);
		assert.deepEqual(new Set(result.findings.map((finding) => finding.code)), new Set(["LEDGER_MODE", "LEDGER_JSON"]));
	});
});
