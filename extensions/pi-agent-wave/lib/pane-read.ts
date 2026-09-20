import { spawnSync } from "node:child_process";

/** One `herdr pane read` invocation: the pane's recent terminal text, or null when the pane cannot be read. */
export type PaneReader = (paneId: string, lines: number) => string | null;

/**
 * How long a single pane read may take before the view gives up on it.
 *
 * This runs synchronously on the UI thread, once per worker per redraw (`PI_GRAPH_WATCH_INTERVAL_MS`,
 * default 2000 ms), so it must always return well inside one interval. Without a bound, a `herdr` that
 * hangs freezes the whole Pi terminal for as long as it hangs; an unreadable pane is only a missing view.
 */
const PANE_READ_TIMEOUT_MS = 1_000;

/**
 * Reads what the worker's terminal is showing right now.
 *
 * The pane is the live source: the launcher execs the ACPX worker with no redirection, so the pane carries
 * the worker's own rendered output. A display path therefore never opens the worker's stream file, which is
 * a capture sink rather than a view, lives inside the attempt directory, and disappears with it.
 *
 * Failure is always `null` and never an exception or a wait: this is a read-only view, so a missing,
 * closed, slow or hung pane costs the operator that pane's output and nothing else.
 */
export const readPane: PaneReader = (paneId, lines) => {
	const result = spawnSync("herdr", ["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", "text"], { encoding: "utf8", timeout: PANE_READ_TIMEOUT_MS, killSignal: "SIGKILL" });
	// A timeout reports the signal that killed it rather than an error, and may still carry partial
	// output; a partially rendered pane is not what the operator asked for, so it is dropped too.
	if (result.error || result.signal || result.status !== 0) return null;
	return result.stdout;
};

let active: PaneReader = readPane;

/** The reader every display path uses; tests replace it so no test shells out to Herdr. */
export function currentPaneReader(): PaneReader { return active; }

/** Replaces the process-wide pane reader. Test-only: production code passes no reader and gets `readPane`. */
export function setPaneReaderForTests(reader: PaneReader | null): void { active = reader ?? readPane; }

/** The pane's text as display lines, newest last, blank lines dropped and long lines truncated. */
export function paneLines(paneId: string | null, limit: number, reader: PaneReader = active, lineLimit = 160): readonly string[] | null {
	if (!paneId) return null;
	const text = reader(paneId, limit);
	if (text === null) return null;
	return text.split("\n").map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.trim().length > 0)
		.map((line) => line.length > lineLimit ? `${line.slice(0, lineLimit - 1)}\u2026` : line)
		.slice(-limit);
}
