import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReport, validateReport } from "../scripts/report-audit.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { dir: string; report: string } {
	const dir = mkdtempSync(join(tmpdir(), "delegate-report-json-"));
	dirs.push(dir);
	return { dir, report: join(dir, "report.json") };
}

function valid(verdict = "PASS") {
	return {
		schemaVersion: 1,
		verdict,
		claims: [{
			statement: "The targeted check passed",
			evidence: [{ kind: "command", source: "node --test", detail: "exit 0" }],
			verification: "verified",
		}],
	};
}

describe("JSON delegate report audit", () => {
	test("accepts a valid role-specific report and normalizes BOM, whitespace, and mode", async () => {
		const { dir, report } = fixture();
		writeFileSync(report, `\uFEFF  ${JSON.stringify(valid("GREEN"), null, 2)}  \n`, { mode: 0o644 });
		const result = await auditReport(report, { node: "test", privateRoot: dir });
		assert.equal(result.valid, true);
		assert.equal(result.verdict, "GREEN");
		assert.equal(lstatSync(report).mode & 0o777, 0o600);
	});

	test("rejects malformed JSON with a stable diagnostic", async () => {
		const { dir, report } = fixture();
		writeFileSync(report, "{ not-json", { mode: 0o600 });
		const result = await auditReport(report, { privateRoot: dir });
		assert.equal(result.valid, false);
		assert.equal(result.errors[0]?.code, "JSON_PARSE");
		assert.equal(result.errors[0]?.path, "$");
	});

	test("rejects missing semantic fields and unknown fields", () => {
		const result = validateReport({ schemaVersion: 1, verdict: "PASS", claims: [{ statement: "", evidence: [], verification: "maybe", extra: true }] }, "review");
		assert.equal(result.valid, false);
		assert.deepEqual(new Set(result.errors.map((error) => error.code)), new Set(["UNKNOWN_FIELD", "CLAIM_STATEMENT", "VERIFICATION_STATE", "EVIDENCE_REQUIRED"]));
	});

	test("validates structured evidence fields", () => {
		const candidate = valid();
		candidate.claims[0].evidence = [{ kind: "unknown", source: "", detail: "" } as never];
		const result = validateReport(candidate, "review");
		assert.deepEqual(result.errors.map((error) => error.code), ["EVIDENCE_KIND", "EVIDENCE_SOURCE", "EVIDENCE_DETAIL"]);
	});

	test("enforces verdicts for every graph node", () => {
		const matrix: Array<[Parameters<typeof validateReport>[1], string, boolean]> = [
			["thinker_plan", "READY", true], ["thinker_split", "READY", true], ["thinker_synthesize", "DONE", true],
			["implement", "DONE", true], ["review", "PASS", true], ["review", "GREEN", false],
			["test", "NOT_OK", true], ["test", "FAIL", false], ["audit", "FAIL", true], ["search", "DONE", true],
		];
		for (const [node, verdict, expected] of matrix) assert.equal(validateReport(valid(verdict), node).valid, expected, `${node}/${verdict}`);
	});

	test("rejects symlinks before permission normalization", async () => {
		const { dir, report } = fixture();
		const target = join(dir, "target.json");
		writeFileSync(target, JSON.stringify(valid()), { mode: 0o600 });
		symlinkSync(target, report);
		const result = await auditReport(report, { privateRoot: dir });
		assert.equal(result.valid, false);
		assert.equal(result.errors[0]?.code, "REPORT_SYMLINK");
	});

	test("rejects a report outside the assigned private root", async () => {
		const one = fixture();
		const two = fixture();
		writeFileSync(one.report, JSON.stringify(valid()), { mode: 0o600 });
		const result = await auditReport(one.report, { privateRoot: two.dir });
		assert.equal(result.valid, false);
		assert.equal(result.errors[0]?.code, "REPORT_PATH");
	});
});
