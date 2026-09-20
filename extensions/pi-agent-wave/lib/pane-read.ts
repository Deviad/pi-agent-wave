import { spawnSync } from "node:child_process";

/** One `herdr pane read` invocation: the pane's recent terminal text, or null when the pane cannot be read. */
export type PaneReader = (paneId: string, lines: number) => string | null;

/**
 * Reads what the worker's terminal is showing right now.
 *
 * The pane is the live source: the launcher execs the ACPX worker with no redirection, so the pane carries
 * the worker's own rendered output. A display path therefore never opens the worker's stream file, which is
 * a capture sink rather than a view, lives inside the attempt directory, and disappears with it.
 */
export const readPane: PaneReader = (paneId, lines) => {
	const result = spawnSync("herdr", ["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", "text"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return null;
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
