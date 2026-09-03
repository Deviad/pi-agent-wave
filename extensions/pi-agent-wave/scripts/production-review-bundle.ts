#!/usr/bin/env -S node --experimental-strip-types
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REVIEW_PATHS = [
	"tasks/prd-production-acpx-worker-backend.md",
	"tasks/prd-production-acpx-lifecycle-hardening.md",
	"tasks/prd-production-acpx-final-audit.md",
	"tasks/prd-production-acpx-final-source-hardening.md",
	"tasks/prd-production-acpx-final-bundle-completeness.md",
	"tasks/prd-air-controlled-editor-independent-orchestration.md",
	"tasks/prd-package-delegate-graph.md",
	"agent-output/production-acpx-worker-backend/final-audit.json",
	"agent-output/production-acpx-worker-backend/real-matrix-status.json",
	"agent-output/production-acpx-worker-backend/real-matrix-report.json",
	"agent-output/production-acpx-worker-backend/final-matrix/pi.json",
	"agent-output/production-acpx-worker-backend/final-matrix/codex.json",
	"agent-output/production-acpx-worker-backend/final-matrix/claude.json",
	"agent-output/production-acpx-worker-backend/final-matrix/pi-production.json",
	"agent-output/production-acpx-worker-backend/final-matrix/codex-production.json",
	"agent-output/production-acpx-worker-backend/final-matrix/claude-production.json",
	"agent-output/production-acpx-worker-backend/lifecycle-hardening-report.json",
	"agent-output/production-acpx-worker-backend/final-source-hardening-report.json",
	"agent-output/production-acpx-worker-backend/implementation-report.json",
	"agent-output/production-acpx-worker-backend/final-review-discard-attempt-3.json",
	"agent-output/production-acpx-worker-backend/final-review-remediated-fail.json",
	"agent-output/production-acpx-worker-backend/final-source-hardening-review-attempt-1.json",
	"agent-output/production-acpx-worker-backend/final-source-hardening-review-attempt-2.json",
	"agent-output/production-acpx-worker-backend/final-source-hardening-review-attempt-3.json",
	"agent-output/production-acpx-worker-backend/final-bundle-completeness-review-attempt-1.json",
	"agent-output/air-headless-orchestration/copy-manifest.json",
	"agent-output/air-headless-orchestration/implementation-report.json",
	"agent-output/air-headless-orchestration/final-matrix/pi-headless.json",
	"agent-output/air-headless-orchestration/final-matrix/codex-headless.json",
	"agent-output/air-headless-orchestration/final-matrix/claude-headless.json",
	"agent-output/air-headless-orchestration/air-e2e.json",
	"agent-output/air-headless-orchestration/air-e2e-transcript.jsonl",
	"agent-output/air-headless-orchestration/original-isolation-final.json",
	"agent-output/air-headless-orchestration/pi-stdio/root-cause-bisection.json",
	"agent-output/air-headless-orchestration/air-e2e-artifacts/v2/audit-report.json",
	"agent-output/air-headless-orchestration/delegate-ledger/01-phase1-blocked.json",
	"extensions/pi-agent-wave/package.json",
	"extensions/pi-agent-wave/require-runtime.ts",
	"extensions/pi-agent-wave/require-acpx.ts",
	"extensions/pi-agent-wave/require-agentfs.ts",
	"extensions/pi-agent-wave/index.ts",
	"extensions/pi-agent-wave/store.ts",
	"extensions/pi-agent-wave/herdr.ts",
	"extensions/pi-agent-wave/contract.ts",
	"extensions/pi-agent-wave/lib/acpx-types.ts",
	"extensions/pi-agent-wave/lib/worker-transport.ts",
	"extensions/pi-agent-wave/lib/acpx-events.ts",
	"extensions/pi-agent-wave/lib/acpx-settlement.ts",
	"extensions/pi-agent-wave/lib/acpx-settlement-evidence.ts",
	"extensions/pi-agent-wave/lib/agentfs-sandbox.ts",
	"extensions/pi-agent-wave/scripts/acpx-worker.ts",
	"extensions/pi-agent-wave/scripts/delegate_core.py",
	"extensions/pi-agent-wave/scripts/headless_delegate.py",
	"extensions/pi-agent-wave/scripts/herdr_delegate.py",
	"extensions/pi-agent-wave/scripts/acpx-cancel.ts",
	"extensions/pi-agent-wave/scripts/acpx-plan.ts",
	"extensions/pi-agent-wave/scripts/agentfs-export.ts",
	"extensions/pi-agent-wave/scripts/herdr_delegate.py",
	"extensions/pi-agent-wave/scripts/production-audit.ts",
	"extensions/pi-agent-wave/scripts/production-review-bundle.ts",
	"extensions/pi-agent-wave/test/acpx-cancellation.test.ts",
	"extensions/pi-agent-wave/test/acpx-headless-transport.test.ts",
	"extensions/pi-agent-wave/test/acpx-headless-real-matrix.test.ts",
	"extensions/pi-agent-wave/test/air-acp-control.test.ts",
	"extensions/pi-agent-wave/test/worker-transport.test.ts",
	"extensions/pi-agent-wave/test/headless-requirement.test.ts",
	"extensions/pi-agent-wave/test/doctor.test.ts",
	"e2e/tests/test_us007_air_headless_control.py",
	"extensions/pi-agent-wave/test/acpx-cleanup.test.ts",
	"extensions/pi-agent-wave/test/support/acpx-cleanup-driver.py",
	"extensions/pi-agent-wave/test/acpx-focus-cancellation.test.ts",
	"extensions/pi-agent-wave/test/acpx-herdr-bridge.test.ts",
	"extensions/pi-agent-wave/test/acpx-settlement-manifest.test.ts",
	"extensions/pi-agent-wave/test/acpx-store-migration.test.ts",
	"extensions/pi-agent-wave/test/acpx-real-matrix.test.ts",
	"extensions/pi-agent-wave/test/acpx-production-matrix.test.ts",
	"extensions/pi-agent-wave/test/production-audit.test.ts",
	"extensions/pi-agent-wave/test/production-review-bundle.test.ts",
	"extensions/pi-agent-wave/test/commands.test.ts",
	"extensions/pi-agent-wave/test/acpx-real-report-evidence.test.ts",
	"extensions/pi-agent-wave/test/agentfs-sandbox.test.ts",
	"extensions/pi-agent-wave/test/package-artifact.test.ts",
	"extensions/pi-agent-wave/test/package-install-rehearsal.test.ts",
	"extensions/pi-agent-wave/test/package-docs.test.ts",
	"README.md",
	"extensions/pi-agent-wave/README.md",
] as const;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function buildProductionReviewBundle(root: string, outputPath: string, paths: readonly string[] = REVIEW_PATHS): { sections: number; bytes: number; sha256: string } {
	const sections = paths.map((path) => {
		const content = readFileSync(join(root, path), "utf8");
		return { path, content, bytes: Buffer.byteLength(content), sha256: sha256(content) };
	});
	const index = sections.map((section) => `- ${section.path} | ${section.bytes} bytes | sha256 ${section.sha256}`).join("\n");
	const body = sections.map((section) => `\n## ${section.path}\n\n\`\`\`text\n${section.content}\n\`\`\`\n`).join("");
	const bundle = `# Production ACPX final review bundle\n\nGenerated from current repository files. Each section is path- and SHA-256-bound. Treat historical failed reports as immutable evidence, not current truth. Host command truth is final-audit.json.\n\n## Section index\n\n${index}\n${body}`;
	if (/\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/.test(bundle)) throw new Error("review bundle contains credential material");
	writeFileSync(outputPath, bundle, { mode: 0o600 });
	chmodSync(outputPath, 0o600);
	return { sections: sections.length, bytes: Buffer.byteLength(bundle), sha256: sha256(bundle) };
}

function main(): void {
	const root = resolve(process.cwd());
	const output = resolve(process.argv[2] ?? join(root, "agent-output/production-acpx-worker-backend/final-review-bundle.md"));
	console.log(JSON.stringify(buildProductionReviewBundle(root, output)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
