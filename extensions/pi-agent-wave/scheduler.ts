import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandExecutor } from "./herdr.ts";

export interface DeferredJob {
	label: string;
	plistPath: string;
	runnerPath: string;
	runAt: Date;
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Parses an ISO timestamp or relative +Nm/+Nh deferral. */
export function parseDeferredTime(value: string, now = new Date()): Date {
	const relative = /^\+(\d+)(m|h)$/.exec(value.trim());
	if (relative) {
		const amount = Number(relative[1]);
		const multiplier = relative[2] === "h" ? 3_600_000 : 60_000;
		return new Date(now.getTime() + amount * multiplier);
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error("deferred time must be ISO-8601 or +Nm/+Nh");
	if (parsed.getTime() <= now.getTime()) throw new Error("deferred time must be in the future");
	return parsed;
}

/** Writes a private self-removing launchd job that resumes one operation exactly once. */
export function writeDeferredJob(input: {
	home: string;
	runId: string;
	operationId: string;
	policyDigest?: string;
	runAt: Date;
	piPath: string;
	uid: number;
}): DeferredJob {
	const suffix = `${input.runId}-${input.operationId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-100);
	const label = `se.pi.delegate-graph.${suffix}`;
	const dir = join(input.home, "deferred");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const plistPath = join(dir, `${label}.plist`);
	const runnerPath = fileURLToPath(new URL("./scripts/deferred-runner.ts", import.meta.url));
	const policyBinding = input.policyDigest
		? ` The frozen policy digest is ${input.policyDigest}; obtain modelPolicy, policyDigest, and route from op=next, pass them unchanged on dispatch, and never open a picker or re-resolve routes.`
		: " Obtain the stored modelPolicy, policyDigest, and route from op=next; never open a picker or re-resolve routes.";
	const prompt = `Resume Delegate Graph run ${input.runId}, operation ${input.operationId}.${policyBinding} Use the delegate_graph tool with op=status, then op=next, then op=record status=running when allowed.`;
	const programArguments = [
		process.execPath,
		"--experimental-strip-types",
		runnerPath,
		"--uid", String(input.uid),
		"--label", label,
		"--plist", plistPath,
		"--pi", input.piPath,
		"--prompt", prompt,
	];
	const d = input.runAt;
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${programArguments.map((argument) => `<string>${xml(argument)}</string>`).join("")}</array>
<key>StartCalendarInterval</key><dict>
<key>Month</key><integer>${d.getMonth() + 1}</integer>
<key>Day</key><integer>${d.getDate()}</integer>
<key>Hour</key><integer>${d.getHours()}</integer>
<key>Minute</key><integer>${d.getMinutes()}</integer>
</dict>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${xml(join(dir, `${label}.out.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir, `${label}.err.log`))}</string>
</dict></plist>
`;
	writeFileSync(plistPath, plist, { mode: 0o600 });
	chmodSync(plistPath, 0o600);
	return { label, plistPath, runnerPath, runAt: input.runAt };
}

/** Validates and installs a generated launchd job using direct argv boundaries. */
export async function installDeferredJob(job: DeferredJob, uid: number, exec: CommandExecutor): Promise<void> {
	const lint = await exec("plutil", ["-lint", job.plistPath]);
	if (lint.exitCode !== 0) throw new Error(lint.stderr || lint.stdout || "invalid launchd plist");
	const installed = await exec("launchctl", ["bootstrap", `gui/${uid}`, job.plistPath]);
	if (installed.exitCode !== 0) throw new Error(installed.stderr || installed.stdout || "launchctl bootstrap failed");
}
