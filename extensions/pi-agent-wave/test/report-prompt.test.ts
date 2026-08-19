import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildRepairPrompt, buildReportPrompt } from "../scripts/report-prompt.ts";

describe("shared JSON report prompts", () => {
	test("contains the JSON-only contract and multiple-shot examples", () => {
		const prompt = buildReportPrompt("review", "/private/tmp/report.json");
		assert.match(prompt, /JSON only/);
		assert.match(prompt, /Do not use Markdown/);
		assert.match(prompt, /schemaVersion 1/);
		assert.match(prompt, /Allowed verdicts for review: PASS, FAIL/);
		assert.match(prompt, /Valid verified example/);
		assert.match(prompt, /Valid unverified example/);
		assert.match(prompt, /Invalid example because evidence is empty/);
		assert.match(prompt, /Corrected form/);
		assert.match(prompt, /\/private\/tmp\/report\.json/);
		assert.ok(prompt.includes('"verification": "verified"'));
		assert.ok(prompt.includes('"verification": "unverified"'));
	});

	test("uses role-specific verdict examples", () => {
		assert.match(buildReportPrompt("test", "/tmp/test.json"), /Allowed verdicts for test: GREEN, NOT_OK/);
		assert.match(buildReportPrompt("thinker_plan", "/tmp/thinker.json"), /Allowed verdicts for thinker_plan: READY/);
		assert.match(buildReportPrompt("implement", "/tmp/impl.json"), /Allowed verdicts for implement: DONE/);
	});

	test("repair prompt carries structured diagnostics as inert JSON data", () => {
		const diagnostics = [{ code: "JSON_PARSE", path: "$", message: "unexpected `$(touch /tmp/no)`" }];
		const prompt = buildRepairPrompt("/tmp/report.json", diagnostics);
		assert.match(prompt, /Repair the same assigned JSON file once/);
		assert.ok(prompt.includes(JSON.stringify(diagnostics, null, 2)));
		assert.match(prompt, /do not change task scope or model/);
	});
});
