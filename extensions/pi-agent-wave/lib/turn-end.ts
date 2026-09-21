import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Whether a worker's turn has ended, for display only.
 *
 * Between the end of a worker's turn and `op=collect` the attempt is still `running`, because the store
 * records the process outcome at settlement and nothing rewrites it before then. The operator sees a
 * finished agent and a running operation, and cannot tell a stalled run from a mid-flight one.
 *
 * The worker's own result file answers this without a new store state: `scripts/acpx-worker.ts` renames
 * `worker-result.json` into the attempt directory once its prompt run is over, on both transports, so its
 * presence is exactly "the turn ended and nobody has collected it". The headless supervisor's status file
 * adds the exit code when there is one; the Herdr transport has no equivalent, which is why it is optional
 * rather than the signal itself.
 *
 * Nothing here decides, settles or retries anything, and no reader waits: a file that cannot be read is
 * reported as a turn that has not ended, which is the same thing the view showed before.
 */

export interface TurnEnd {
	/** True once the worker wrote its result, i.e. its turn is over and only collection remains. */
	readonly ended: boolean;
	/** The supervisor's recorded exit code, when the transport records one. */
	readonly exitCode: number | null;
}

const NOT_ENDED: TurnEnd = { ended: false, exitCode: null };
const STATUS_SUFFIX = ".status.json";
/** How far above the attempt directory the run directory may sit; the same bound the stream reader uses. */
const RUN_DIRECTORY_LEVELS = 5;

function isFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

/** The supervisor's exit code for this attempt, or null when the transport publishes none. */
function supervisorExitCode(attemptDirectory: string): number | null {
	let candidate = attemptDirectory;
	for (let level = 0; level < RUN_DIRECTORY_LEVELS; level += 1) {
		let names: string[];
		try { names = readdirSync(candidate); } catch { return null; }
		const status = names.find((name) => name.endsWith(STATUS_SUFFIX));
		if (status) {
			try {
				const record: unknown = JSON.parse(readFileSync(join(candidate, status), "utf8"));
				if (typeof record !== "object" || record === null) return null;
				const value = (record as Record<string, unknown>).exitCode;
				return typeof value === "number" && Number.isInteger(value) ? value : null;
			} catch { return null; }
		}
		candidate = dirname(candidate);
	}
	return null;
}

/**
 * Reads whether the worker registered with this cancel script has finished its turn. Synchronous and
 * bounded: it stats one file and, only once that file exists, reads one small JSON record.
 */
export function turnEndFor(cancelScript: string | null | undefined): TurnEnd {
	if (!cancelScript) return NOT_ENDED;
	const attemptDirectory = dirname(cancelScript);
	if (!isFile(join(attemptDirectory, "worker-result.json"))) return NOT_ENDED;
	return { ended: true, exitCode: supervisorExitCode(attemptDirectory) };
}

/** The label a display path shows for a worker whose turn ended but whose attempt is still unsettled. */
export function awaitingCollectLabel(turnEnd: TurnEnd): string {
	return turnEnd.exitCode === null ? "process exited, awaiting collect" : `process exited ${turnEnd.exitCode}, awaiting collect`;
}
