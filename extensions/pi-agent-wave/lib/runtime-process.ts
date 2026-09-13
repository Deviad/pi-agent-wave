import { spawn } from "node:child_process";
import { RuntimeOutputFiles, type RuntimeOutputResult } from "./runtime-output.ts";
import type { RuntimeCaptureIdentity } from "./runtime-capture.ts";
import type { RuntimeOutcome } from "./runtime-results.ts";

interface RuntimeProcessInput {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly outputDir: string;
	readonly identity: Omit<RuntimeCaptureIdentity, "requestId"> & { requestId: string | null };
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/** Observes stdout bytes after they are retained; an observer failure never affects capture or the outcome. */
	readonly onStdout?: (bytes: Buffer) => void;
}

/** Captures one real child process. Protocol interpretation never changes its recorded exit outcome. */
export async function runRuntimeProcess(input: RuntimeProcessInput): Promise<RuntimeOutputResult> {
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("runtime process requires a positive timeout");
	const output = new RuntimeOutputFiles(input.outputDir, input.identity);
	if (input.signal?.aborted) return output.finish({ kind: "cancelled", signal: null });
	return new Promise((resolve, reject) => {
		const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let failure: Error | undefined;
		let essentialFailure: Error | undefined;
		let cancelled = false;
		let timedOut = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const stop = () => { child.kill("SIGTERM"); escalation ??= setTimeout(() => child.kill("SIGKILL"), 2000); };
		const abort = () => { cancelled = true; stop(); };
		input.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);
		const consume = (bytes: Buffer, stream: "stdout" | "stderr") => {
			if (essentialFailure) return;
			try { output[stream](bytes); }
			catch (error) { essentialFailure = error instanceof Error ? error : new Error(String(error)); stop(); return; }
			if (stream === "stdout" && input.onStdout) { try { input.onStdout(bytes); } catch { /* presentation only */ } }
		};
		child.stdout.on("data", (bytes: Buffer) => consume(bytes, "stdout"));
		child.stderr.on("data", (bytes: Buffer) => consume(bytes, "stderr"));
		child.once("error", (error) => { failure = error; });
		child.once("close", (code, signal) => {
			clearTimeout(timeout); if (escalation) clearTimeout(escalation); input.signal?.removeEventListener("abort", abort);
			if (essentialFailure) { output.close(); reject(essentialFailure); return; }
			const outcome: RuntimeOutcome = cancelled ? { kind: "cancelled", signal }
				: failure || timedOut || signal || code !== 0 ? { kind: "failed", exitCode: code !== null && code >= 0 ? code : null, error: failure?.message ?? (timedOut ? "worker timeout" : signal ? `worker terminated by ${signal}` : `worker exited ${code}`) }
				: { kind: "exited", exitCode: 0 };
			try { resolve(output.finish(outcome)); } catch (error) { reject(error); }
		});
	});
}
