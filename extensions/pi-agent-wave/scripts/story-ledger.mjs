#!/usr/bin/env node
/**
 * The story ledger's command surface: `write` appends one entry, `audit` reports one story.
 *
 * Both go through the graph store, which is the single writer for a story's execution record. The
 * sequence is computed inside the inserting transaction, so two concurrent writers cannot take the
 * same number; the old file ledger needed a `.sequence-lock` for that, and produced files that a
 * `prune` of the run would orphan. Nothing here writes a ledger file.
 *
 * Usage:
 *   story-ledger write <story> <topic> --run <runId> --tier <tier> --model <model>
 *                      --outcome accepted|blocked|failed --task <task>
 *                      [--claim '<claim>::<evidence>::verified|unverified|unverified-recall']...
 *                      [--aggregate '<name>::<numerator>::<denominator>::<percentage>']...
 *   story-ledger audit <story>
 *   story-ledger read  <story>
 *
 * The store is `DELEGATE_GRAPH_DB`, or the default graph home when that is unset.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
	process.stderr.write(`story-ledger: ${message}\n`);
	process.exit(1);
}

function takeOption(args, name) {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined) fail(`--${name} needs a value`);
	args.splice(index, 2);
	return value;
}

function takeAll(args, name) {
	const values = [];
	for (let value = takeOption(args, name); value !== undefined; value = takeOption(args, name)) values.push(value);
	return values;
}

/** `<claim>::<evidence>::<status>`; `::` rather than a comma because evidence routinely contains commas. */
function parseClaim(value) {
	const parts = value.split("::");
	if (parts.length !== 3) fail(`--claim expects '<claim>::<evidence>::<status>', got ${JSON.stringify(value)}`);
	return { claim: parts[0], evidence: parts[1], status: parts[2] };
}

function parseAggregate(value) {
	const parts = value.split("::");
	if (parts.length !== 4) fail(`--aggregate expects '<name>::<numerator>::<denominator>::<percentage>', got ${JSON.stringify(value)}`);
	const [name, numerator, denominator, percentage] = parts;
	return { name, numerator: Number(numerator), denominator: Number(denominator), percentage: Number(percentage) };
}

const args = process.argv.slice(2);
const command = args.shift();
if (!command || !["write", "audit", "read"].includes(command)) fail("usage: story-ledger <write|audit|read> <story> [...]");

const { GraphStore } = await import(join(PACKAGE_ROOT, "store.ts"));
const store = new GraphStore({});

try {
	if (command === "write") {
		const story = args.shift();
		const topic = args.shift();
		if (!story || !topic) fail("write needs a story and a topic");
		const claims = takeAll(args, "claim").map(parseClaim);
		const aggregates = takeAll(args, "aggregate").map(parseAggregate);
		const entry = store.recordLedgerEntry({
			story,
			topic,
			runId: takeOption(args, "run") ?? "",
			tier: takeOption(args, "tier") ?? "",
			model: takeOption(args, "model") ?? "",
			outcome: takeOption(args, "outcome") ?? "accepted",
			task: takeOption(args, "task") ?? "",
			claims,
			aggregates,
		});
		process.stdout.write(`${JSON.stringify({ action: "ledger_entry_recorded", store: store.dbPath, id: entry.id, story: entry.story, sequence: entry.sequence, topic: entry.topic, claims: entry.claims.length, aggregates: entry.aggregates.length })}\n`);
	} else if (command === "audit") {
		const story = args.shift();
		if (!story) fail("audit needs a story");
		const audit = store.auditStoryLedger(story);
		process.stdout.write(`${JSON.stringify({ action: "ledger_audited", store: store.dbPath, ...audit }, null, 2)}\n`);
		if (!audit.valid) process.exitCode = 2;
	} else {
		const story = args.shift();
		if (!story) fail("read needs a story");
		process.stdout.write(`${JSON.stringify({ action: "ledger_read", store: store.dbPath, entries: store.storyLedger(story) }, null, 2)}\n`);
	}
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
} finally {
	store.close();
}
