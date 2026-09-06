import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifactsCurrent, auditCommands, EXPECTED_AUDIT_COMMANDS, EXPECTED_AUDIT_SUMMARIES, productionSourceDigest, runProductionAudit, summariesValid, summarizeAuditOutput, type AuditCommandRecord, type Runner } from "../scripts/production-audit.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runner(failing?: string): Runner {
	return (command, args) => {
		const name = args.some((arg) => arg.includes("production-token-cleanup")) ? "token-cleanup" : args.some((arg) => arg.includes("production-secret-scan")) ? "secret-scan" : args.some((arg) => arg.includes("production-cleanup-scan")) ? "cleanup-scan" : args.some((arg) => arg.endsWith("ledger.ts")) ? "ledger" : command === "node" && args.includes("--test") && args.filter((arg) => arg.endsWith(".test.ts")).length > 2 ? "full-node" : command === "bun" ? "bun-package" : args.includes("pack") ? "pack" : args.includes("publish") ? "publish" : args.some((arg) => arg.includes("package-install-rehearsal")) ? "install-rehearsal" : args.some((arg) => arg.includes("acpx-headless-real-matrix")) ? "real-headless-matrix" : args.some((arg) => arg.includes("acpx-real-matrix")) ? "real-lifecycle-matrix" : args.some((arg) => arg.includes("acpx-production-matrix")) ? "real-production-matrix" : command === "git" ? "diff-check" : command === "npm" ? "typecheck" : "full-node";
		const status = name === failing ? 1 : 0;
		const expected = EXPECTED_AUDIT_SUMMARIES[name] ?? {};
		const stdout = name === "full-node" || name === "install-rehearsal" || name === "real-lifecycle-matrix" || name === "real-production-matrix" || name === "real-headless-matrix" ? `# tests ${expected.tests}\n# pass ${expected.pass}\n# fail ${expected.fail}\n# skipped ${expected.skipped}\n` : name === "token-cleanup" ? JSON.stringify({ deleted: true, pathClass: "private-tmp-mode-600" }) : name === "secret-scan" ? JSON.stringify({ files: 30, findings: 0 }) : name === "cleanup-scan" ? JSON.stringify({ leakedTabs: [], agentFsProcesses: 0, temporaryDirectories: [], tokenFilePresent: false }) : name === "bun-package" ? `${expected.pass} pass\n${expected.fail} fail\n` : name === "pack" || name === "publish" ? JSON.stringify([{ files: Array.from({ length: Number(expected.files) }, (_, index) => ({ path: `file-${index}` })) }]) : name === "ledger" ? JSON.stringify({ valid: true, files: expected.files, findings: [] }) : "ok\n";
		return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
	};
}

describe("production host audit bundle", () => {
	test("defines direct argv commands and parses stable summaries", () => {
		const commands = auditCommands(process.cwd());
		assert.ok(commands.every((command) => command.executable && Array.isArray(command.args) && command.cwd));
		assert.deepEqual(summarizeAuditOutput("full-node", "# tests 10\n# pass 9\n# fail 0\n# skipped 1\n"), { tests: 10, pass: 9, fail: 0, skipped: 1 });
		assert.deepEqual(summarizeAuditOutput("bun-package", "34 pass\n0 fail\n"), { pass: 34, fail: 0 });
	});

	test("rejects every unexpected expected-count or boolean baseline", () => {
		const unpinned: Record<string, Record<string, unknown>> = { "token-cleanup": { deleted: true }, "secret-scan": { findings: 0 }, "cleanup-scan": { leakedTabs: [], agentFsProcesses: 0, temporaryDirectories: [], tokenFilePresent: false }, typecheck: {}, "diff-check": {} };
		const records = EXPECTED_AUDIT_COMMANDS.map((name) => ({ name, executable: "test", args: [], cwd: process.cwd(), environmentKeys: [], startedAt: "now", durationMs: 0, exitCode: 0, signal: null, outputSha256: "0".repeat(64), summary: { ...(EXPECTED_AUDIT_SUMMARIES[name] ?? unpinned[name]) } })) as AuditCommandRecord[];
		assert.equal(summariesValid(records), true);
		assert.equal(summariesValid(records.slice(1)), false, "missing expected command");
		assert.equal(summariesValid([...records, records[0]]), false, "duplicate expected command");
		for (const [name, expected] of Object.entries(EXPECTED_AUDIT_SUMMARIES)) {
			for (const [key, value] of Object.entries(expected)) {
				const changed = records.map((record) => ({ ...record, summary: { ...record.summary } }));
				const target = changed.find((record) => record.name === name)!;
				target.summary[key] = typeof value === "boolean" ? !value : value + 1;
				assert.equal(summariesValid(changed), false, `${name}.${key}`);
			}
		}
	});

	test("rejects stale production-source evidence bindings", () => {
		assert.equal(artifactsCurrent([{ path: "matrix.json", bytes: 1, sha256: "0".repeat(64), mode: "600", productionSourceSha256: "stale", sourceCurrent: false }]), false);
	});

	test("writes a private hash-bound passing bundle", () => {
		const directory = mkdtempSync(join(tmpdir(), "production-audit-"));
		directories.push(directory);
		// The audit binds durable evidence to the production sources it was captured from, so a passing
		// bundle requires a host whose evidence was captured at that host's current digest. Build such a
		// host in a temporary root instead of asserting against this checkout, whose evidence is pinned to
		// the release it was captured for.
		const root = join(directory, "host");
		mkdirSync(join(root, "extensions/pi-agent-wave/lib"), { recursive: true });
		mkdirSync(join(root, "extensions/pi-agent-wave/scripts"), { recursive: true });
		mkdirSync(join(root, "extensions/pi-agent-wave/test"), { recursive: true });
		copyFileSync(join(process.cwd(), "extensions/pi-agent-wave/retry.ts"), join(root, "extensions/pi-agent-wave/retry.ts"));
		for (const prd of ["prd-production-acpx-worker-backend.md", "prd-production-acpx-lifecycle-hardening.md", "prd-production-acpx-final-audit.md", "prd-production-acpx-final-source-hardening.md", "prd-air-controlled-editor-independent-orchestration.md"]) {
			mkdirSync(join(root, "tasks"), { recursive: true });
			copyFileSync(join(process.cwd(), "tasks", prd), join(root, "tasks", prd));
		}
		const digest = productionSourceDigest(root);
		const sourceBound = [
			"agent-output/production-acpx-worker-backend/lifecycle-hardening-report.json",
			...["pi", "codex", "claude"].flatMap((agent) => [`agent-output/production-acpx-worker-backend/final-matrix/${agent}.json`, `agent-output/production-acpx-worker-backend/final-matrix/${agent}-production.json`]),
			...["pi", "codex", "claude"].map((agent) => `agent-output/air-headless-orchestration/final-matrix/${agent}-headless.json`),
		];
		const plain = [
			...["real-matrix-status.json", "real-matrix-report.json", "real-matrix-pi-report.json", "real-matrix-codex-report.json", "real-matrix-claude-report.json", "implementation-report.json"].map((name) => `agent-output/production-acpx-worker-backend/${name}`),
			"agent-output/air-headless-orchestration/implementation-report.json",
		];
		for (const relative of [...sourceBound, ...plain]) {
			const path = join(root, relative);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(sourceBound.includes(relative) ? { productionSourceSha256: digest } : { recorded: true })}\n`, { mode: 0o600 });
		}
		const output = join(directory, "audit.json");
		const bundle = runProductionAudit(root, output, runner());
		assert.equal(bundle.ok, true, JSON.stringify({ stale: bundle.artifacts.filter((artifact) => !artifact.sourceCurrent).map((artifact) => [artifact.path, artifact.productionSourceSha256]), cleanup: bundle.cleanup, secret: bundle.secretScan, changed: bundle.sourceChangedDuringAudit }));
		assert.equal(bundle.commands.length, 14);
		assert.ok(bundle.commands.every((command) => command.outputSha256.length === 64));
		assert.ok(bundle.artifacts.every((artifact) => artifact.sha256.length === 64 && artifact.mode === "600"));
		assert.ok(bundle.artifacts.every((artifact) => artifact.sourceCurrent));
		assert.equal(statSync(output).mode & 0o777, 0o600);
	});

	test("fails closed when any command fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "production-audit-fail-"));
		directories.push(directory);
		const bundle = runProductionAudit(process.cwd(), join(directory, "audit.json"), runner("typecheck"));
		assert.equal(bundle.ok, false);
		assert.equal(bundle.commands.find((command) => command.name === "typecheck")?.exitCode, 1);
	});
});
