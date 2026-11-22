import { Worker } from "node:worker_threads";
import type { GraphStore } from "../store.ts";
import type { IntegrationProgress, IntegrationStatus } from "./runtime-integration.ts";

/** A progress callback can cancel before the executor is allowed to take another checkpoint. */
export async function executeIntegration(dbPath: string, args: Parameters<GraphStore["runtimeIntegrationSteps"]>, signal: AbortSignal | undefined, progress: (step: IntegrationProgress) => void): Promise<IntegrationStatus> {
	signal?.throwIfAborted();
	const worker = new Worker(new URL("./integration-executor-worker.mjs", import.meta.url), { workerData: { dbPath, args }, execArgv: [] });
	let abort: (() => void) | undefined;
	try {
		return await new Promise<IntegrationStatus>((resolve, reject) => {
			abort = () => reject(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			worker.on("error", reject);
			worker.on("exit", code => reject(new Error(`integration executor exited without a result (${code})`)));
			worker.on("message", (message: IteratorResult<IntegrationProgress, IntegrationStatus>) => {
				try {
					if (message.done) resolve(message.value);
					else if (!signal?.aborted) {
						progress(message.value);
						if (!signal?.aborted) worker.postMessage("advance");
					}
				} catch (error) { reject(error); }
			});
		});
	} finally {
		if (abort) signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}
