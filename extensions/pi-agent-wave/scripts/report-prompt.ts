#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeName } from "../types.ts";

const VERDICTS: Record<NodeName, readonly string[]> = {
	thinker_plan: ["READY"],
	thinker_split: ["READY"],
	thinker_synthesize: ["DONE"],
	implement: ["DONE"],
	review: ["PASS", "FAIL"],
	test: ["GREEN", "NOT_OK"],
	audit: ["PASS", "FAIL"],
	search: ["DONE"],
	terminal: [],
};

function example(verdict: string, verification: "verified" | "unverified" | "unverified-recall") {
	return {
		schemaVersion: 1,
		verdict,
		claims: [{
			statement: verification === "verified" ? "The targeted check passed" : "The cause is inferred from the observed symptom",
			evidence: [{
				kind: verification === "verified" ? "command" : "inference",
				source: verification === "verified" ? "node --test targeted.test.ts" : "reasoning from captured output",
				detail: verification === "verified" ? "exit 0; all targeted tests passed" : "No direct source establishes the cause",
			}],
			verification,
		}],
	};
}

/** Build the shared JSON-only report contract used by every visible transport. */
export function buildReportPrompt(node: NodeName, reportPath: string): string {
	const verdicts = VERDICTS[node];
	if (!verdicts?.length) throw new Error(`no report verdict contract for ${node}`);
	const valid = example(verdicts[0], "verified");
	const unverified = example(verdicts[0], "unverified");
	const invalid = { schemaVersion: 1, verdict: verdicts[0], claims: [{ statement: "Unsupported claim", evidence: [], verification: "verified" }] };
	const corrected = example(verdicts[0], "unverified");
	return [
		"Write the assigned report as JSON only. Do not use Markdown, prose outside JSON, or code fences.",
		`Write exactly one JSON object to: ${reportPath}`,
		"The report file is the sole verdict source and must use schemaVersion 1.",
		`Allowed verdicts for ${node}: ${verdicts.join(", ")}.`,
		"Required shape: {schemaVersion:1, verdict:string, claims:[{statement:string, evidence:[{kind:command|file|output|inference, source:string, detail:string}], verification:verified|unverified|unverified-recall}]}",
		"Every string and array must be non-empty. Mark memory or inference as unverified or unverified-recall; never upgrade it to verified without direct evidence.",
		"Valid verified example:",
		JSON.stringify(valid, null, 2),
		"Valid unverified example:",
		JSON.stringify(unverified, null, 2),
		"Invalid example because evidence is empty:",
		JSON.stringify(invalid, null, 2),
		"Corrected form:",
		JSON.stringify(corrected, null, 2),
		"Before replying, write the JSON file and verify it exists. Reply only REPORT: <absolute-path>.",
	].join("\n\n");
}

export function buildRepairPrompt(reportPath: string, diagnostics: unknown): string {
	return [
		"Your report was not accepted. Repair the same assigned JSON file once; do not change task scope or model.",
		`Report path: ${reportPath}`,
		"Validator diagnostics:",
		JSON.stringify(diagnostics, null, 2),
		"Return JSON only in the file, with schemaVersion, verdict, and non-empty structured claims/evidence. Reply only REPORT: <absolute-path>.",
	].join("\n\n");
}

function parseCli(argv: string[]): { node: NodeName; report: string; repair?: unknown } {
	let node: NodeName | undefined;
	let report = "";
	let repair: unknown;
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--node") node = argv[++index] as NodeName;
		else if (argv[index] === "--report") report = argv[++index] ?? "";
		else if (argv[index] === "--repair-json") repair = JSON.parse(argv[++index] ?? "null");
		else throw new Error(`unknown argument ${argv[index]}`);
	}
	if (!node || !report) throw new Error("usage: report-prompt.ts --node <node> --report <path> [--repair-json <json>]");
	return { node, report, repair };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = parseCli(process.argv.slice(2));
		console.log(args.repair === undefined ? buildReportPrompt(args.node, args.report) : buildRepairPrompt(args.report, args.repair));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
