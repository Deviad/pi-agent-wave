import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { summarizeAcpxStream } from "./lib/acpx-render.ts";
import { RuntimeContentStore } from "./lib/runtime-content.ts";
import type { RuntimeAttempt } from "./lib/runtime-results.ts";
import type { GraphStore } from "./store.ts";

/**
 * The session-local numbered agent list: it opens when the first worker of this Pi session registers, appends
 * later registrations with stable numbers, and shows each attempt's details inside the TUI. Numbers are
 * presentation state that lives only as long as the session; nothing here dispatches, cancels, settles,
 * retries or decides work, and nothing depends on a Herdr target still existing.
 */

export const AGENT_LIST_WIDGET = "delegate-graph-agents";
const STREAM_TAIL_BYTES = 64 * 1024;
const ANSWER_LIMIT_BYTES = 4 * 1024;
const TASK_LIMIT = 240;

export interface AgentListEntry {
	readonly number: number;
	readonly attemptKey: string;
	readonly runId: string;
	readonly operationId: string;
}

export interface AgentListRow {
	readonly number: number;
	readonly agentName: string;
	readonly node: string;
	readonly state: string;
	readonly model: string;
	readonly activity: string;
	/** False once the attempt settled or was superseded; such rows collapse into the settled summary. */
	readonly running: boolean;
}

export interface AgentDetail {
	readonly number: number;
	readonly agentName: string;
	readonly runId: string;
	readonly runStatus: string;
	readonly operationId: string;
	readonly node: string;
	readonly role: string;
	readonly transport: string;
	readonly model: string;
	readonly processState: string;
	readonly acceptance: string;
	readonly task: string;
	/** Rendered recent lines of the retained worker stream; empty when no stream exists or nothing renderable arrived. */
	readonly liveOutput: readonly string[];
	readonly liveOutputNote: string | null;
	/** The retained answer after settlement, bounded; null when none is retained. */
	readonly answer: string | null;
	readonly answerNote: string | null;
}

export interface CancelRunReport {
	readonly runId: string;
	readonly cancelled: readonly string[];
	readonly failed: readonly { agentName: string; error: string }[];
	readonly status: string;
}

/** The one mutation the views may trigger, supplied by the entry point so this module never executes anything itself. */
export interface AgentListActions {
	cancelRun(runId: string): Promise<CancelRunReport>;
}

export interface CancelConfirmation { readonly runId: string; readonly names: readonly string[] }

interface AgentListSession {
	readonly ctx: ExtensionContext;
	readonly store: GraphStore;
	readonly intervalMs: number;
	readonly actions: AgentListActions;
	timer: ReturnType<typeof setInterval> | null;
	unsubscribe: () => void;
	selected: number | null;
	pending: string;
	confirming: CancelConfirmation | null;
	cancelling: boolean;
	/** Settled rows are collapsed into one summary line unless the operator toggles them with s. */
	showSettled: boolean;
	/** The focused row while the operator walks the list with the arrows; null when the list is not focused. */
	cursor: CursorItem | null;
}

/** What the cursor can rest on: a worker's row, or the folded settled summary (Enter unfolds it). */
export type CursorItem = { readonly kind: "row"; readonly number: number } | { readonly kind: "summary" };

/** The items in display order the cursor may visit. */
export function visibleItems(rows: readonly AgentListRow[], showSettled: boolean): CursorItem[] {
	const items: CursorItem[] = rows.filter((row) => row.running || showSettled).map((row) => ({ kind: "row", number: row.number }));
	if (!showSettled && rows.some((row) => !row.running)) items.push({ kind: "summary" });
	return items;
}

function sameItem(a: CursorItem | null, b: CursorItem): boolean {
	return a !== null && a.kind === b.kind && (a.kind !== "row" || b.kind !== "row" || a.number === b.number);
}

const entries: AgentListEntry[] = [];
let session: AgentListSession | null = null;

/** The last bytes of a file, so a long stream is summarized without reading all of it. */
function readTail(path: string, limit: number): string {
	const size = statSync(path).size;
	const start = Math.max(0, size - limit);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally { closeSync(fd); }
}

function shortModel(model: string | null): string {
	return model ? model.slice(model.lastIndexOf("/") + 1) : "?";
}

function truncate(text: string, limit: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** A human label that distinguishes process outcome from task acceptance and never calls a settled attempt running. */
export function processLabel(attempt: RuntimeAttempt): string {
	if (attempt.supersededAt) return `superseded (${attempt.processState})`;
	if (attempt.processState === "running") return "running";
	const outcome = attempt.outcome;
	if (!outcome) return `settled (${attempt.processState})`;
	switch (outcome.kind) {
		case "exited": return `settled (exited ${outcome.exitCode})`;
		case "failed": return `settled (failed${outcome.exitCode === null ? "" : ` ${outcome.exitCode}`})`;
		case "cancelled": return "settled (cancelled)";
		case "interrupted": return "settled (interrupted)";
	}
}

function streamPathFor(store: GraphStore, attempt: RuntimeAttempt): string | null {
	const agent = attempt.agentId ? store.agents(attempt.runId).find((row) => row.id === attempt.agentId) : undefined;
	if (!agent?.acpx_cancel_script) return null;
	const candidate = join(dirname(agent.acpx_cancel_script), "runtime-output", "worker.stdout.ndjson");
	return existsSync(candidate) ? candidate : null;
}

/** Everything the detail view shows for one attempt, read from runtime state and retained content only. */
export function attemptDetail(store: GraphStore, entry: AgentListEntry): AgentDetail {
	const attempt = store.runtimeAttempt(entry.attemptKey);
	const operation = store.getOperation(entry.operationId);
	const state = store.getState(entry.runId);
	const agent = attempt.agentId ? store.agents(entry.runId).find((row) => row.id === attempt.agentId) : undefined;
	const streamPath = streamPathFor(store, attempt);
	let liveOutput: readonly string[] = [];
	let liveOutputNote: string | null = streamPath ? null : "(no stream retained for this attempt)";
	if (streamPath) {
		const summary = summarizeAcpxStream(readTail(streamPath, STREAM_TAIL_BYTES), 12);
		liveOutput = summary.recent;
		if (!summary.recent.length) liveOutputNote = "(stream exists but nothing renderable has arrived)";
	}
	let answer: string | null = null;
	let answerNote: string | null = null;
	const retained = attempt.candidate?.answer ?? null;
	if (retained && retained.bytes > 0) {
		const content = new RuntimeContentStore(store.dbPath);
		const text = content.read(retained, ANSWER_LIMIT_BYTES).toString("utf8");
		answer = text;
		if (retained.bytes > ANSWER_LIMIT_BYTES) answerNote = `(showing the first ${ANSWER_LIMIT_BYTES} of ${retained.bytes} bytes)`;
	} else if (attempt.processState === "running") {
		answerNote = "(no answer yet: the worker is still running)";
	} else {
		answerNote = "(no retained answer for this attempt)";
	}
	return {
		number: entry.number,
		agentName: agent?.name ?? entry.operationId,
		runId: entry.runId,
		runStatus: state.status,
		operationId: entry.operationId,
		node: operation.node,
		role: agent?.role ?? operation.node,
		transport: agent?.transport ?? "?",
		model: agent?.selected_model ?? "?",
		processState: processLabel(attempt),
		acceptance: attempt.acceptance,
		task: truncate(operation.task, TASK_LIMIT),
		liveOutput,
		liveOutputNote,
		answer,
		answerNote,
	};
}

/** One list row per entry; a missing attempt is shown as such rather than dropped, so numbers stay stable. */
export function listRows(store: GraphStore): AgentListRow[] {
	return entries.map((entry) => {
		try {
			const attempt = store.runtimeAttempt(entry.attemptKey);
			const agent = attempt.agentId ? store.agents(entry.runId).find((row) => row.id === attempt.agentId) : undefined;
			const streamPath = streamPathFor(store, attempt);
			const activity = streamPath ? summarizeAcpxStream(readTail(streamPath, STREAM_TAIL_BYTES), 1).lastActivity ?? "(no output yet)" : "(no stream)";
			return { number: entry.number, agentName: agent?.name ?? entry.operationId, node: store.getOperation(entry.operationId).node, state: processLabel(attempt), model: shortModel(agent?.selected_model ?? null), activity, running: attempt.processState === "running" && !attempt.supersededAt };
		} catch (error) {
			return { number: entry.number, agentName: entry.operationId, node: "?", state: `unavailable (${error instanceof Error ? error.message : String(error)})`, model: "?", activity: "", running: false };
		}
	});
}

export const LIST_KEYS = "keys: Enter opens the running worker or focuses the list, up/down move, number then Enter opens by number, s shows or hides settled, r refresh, q close, Esc cancels the run's workers";
export const FOCUSED_KEYS = "focused: up/down move, Enter opens, q unfocuses, Esc cancels the run's workers";

/** The one line settled workers fold into; their numbers stay valid and still open details. */
export function renderSettledSummary(rows: readonly AgentListRow[]): string | null {
	const settled = rows.filter((row) => !row.running);
	return settled.length ? `settled (${settled.length}): ${settled.map((row) => row.number).join(", ")} | s shows them` : null;
}
export const DETAIL_KEYS = "keys: q back to list, r refresh, Esc cancels the run's workers";

/** The confirmation the operator must answer before anything is cancelled; it names every worker it would stop. */
export function renderCancelConfirmation(confirmation: CancelConfirmation, cancelling = false): string[] {
	const workers = `${confirmation.names.length} running worker${confirmation.names.length === 1 ? "" : "s"}: ${confirmation.names.join(", ")}`;
	return [cancelling ? `cancelling run ${confirmation.runId}: ${workers} | please wait` : `cancel run ${confirmation.runId}? ${workers} | Enter confirms, q or Esc aborts`];
}

/** A key repeat (kitty protocol event type 2) of a key that acts once must not act again; arrows may repeat. */
export function isKeyRepeat(data: string): boolean {
	return /;\d+:2[u~]$/.test(data);
}

/** The running workers of a run, as the operator would name them; empty when nothing is running. */
export function runningWorkerNames(store: GraphStore, runId: string): string[] {
	const agents = store.agents(runId);
	return store.operations(runId, true).filter((operation) => operation.status === "running").map((operation) => agents.find((agent) => agent.id === operation.agent_id)?.name ?? operation.id);
}

export function renderAgentList(rows: readonly AgentListRow[], pending: string, confirmation: CancelConfirmation | null = null, showSettled = false, cursor: CursorItem | null = null, cancelling = false): string[] {
	const lines = [`agents (${rows.length}) | ${cursor ? FOCUSED_KEYS : LIST_KEYS}`];
	const mark = (item: CursorItem) => (cursor ? (sameItem(cursor, item) ? "\u203a " : "  ") : "");
	for (const row of rows) if (row.running || showSettled) lines.push(`${mark({ kind: "row", number: row.number })}${row.number}. ${row.agentName} | ${row.node} | ${row.state} | ${row.model} | ${row.activity}`);
	if (!showSettled) { const summary = renderSettledSummary(rows); if (summary) lines.push(`${mark({ kind: "summary" })}${summary}`); }
	if (pending) lines.push(`selecting: ${pending}_ (Enter opens, Esc clears)`);
	if (confirmation) lines.push(...renderCancelConfirmation(confirmation, cancelling));
	return lines;
}

export function renderAgentDetail(detail: AgentDetail, confirmation: CancelConfirmation | null = null, cancelling = false): string[] {
	const lines = [
		`agent ${detail.number}: ${detail.agentName} | ${DETAIL_KEYS}`,
		`run ${detail.runId} (${detail.runStatus}) | operation ${detail.operationId}`,
		`node ${detail.node} | role ${detail.role} | transport ${detail.transport} | model ${detail.model}`,
		`process ${detail.processState} | acceptance ${detail.acceptance}`,
		`task: ${detail.task}`,
		"live output:",
	];
	if (detail.liveOutput.length) for (const line of detail.liveOutput) lines.push(`  ${line}`);
	if (detail.liveOutputNote) lines.push(`  ${detail.liveOutputNote}`);
	lines.push("retained answer:");
	if (detail.answer !== null) for (const line of detail.answer.split("\n")) lines.push(`  ${line}`);
	if (detail.answerNote) lines.push(`  ${detail.answerNote}`);
	if (confirmation) lines.push(...renderCancelConfirmation(confirmation, cancelling));
	return lines;
}

function anyRunning(store: GraphStore): boolean {
	return entries.some((entry) => { try { return store.runtimeAttempt(entry.attemptKey).processState === "running"; } catch { return false; } });
}

function draw(): void {
	const current = session;
	if (!current) return;
	let content: string[];
	if (current.selected !== null) {
		const entry = entries.find((item) => item.number === current.selected);
		if (!entry) { current.selected = null; content = renderAgentList(listRows(current.store), current.pending, current.confirming, current.showSettled, current.cursor, current.cancelling); }
		else {
			try { content = renderAgentDetail(attemptDetail(current.store, entry), current.confirming, current.cancelling); }
			catch (error) { content = [`agent ${entry.number}: details unavailable (${error instanceof Error ? error.message : String(error)}) | ${DETAIL_KEYS}`, ...(current.confirming ? renderCancelConfirmation(current.confirming, current.cancelling) : [])]; }
		}
	} else {
		const rows = listRows(current.store);
		// The cursor follows the worker, not the position: a row that folded away moves the cursor to the summary.
		if (current.cursor) {
			const items = visibleItems(rows, current.showSettled);
			if (!items.some((item) => sameItem(current.cursor, item))) current.cursor = items.find((item) => item.kind === "summary") ?? items[0] ?? null;
		}
		content = renderAgentList(rows, current.pending, current.confirming, current.showSettled, current.cursor, current.cancelling);
	}
	current.ctx.ui.setWidget(AGENT_LIST_WIDGET, content);
	if (!anyRunning(current.store) && current.timer) { clearInterval(current.timer); current.timer = null; }
}

function ensureTimer(): void {
	const current = session;
	if (!current || current.timer || !anyRunning(current.store)) return;
	const timer = setInterval(draw, current.intervalMs);
	timer.unref?.();
	current.timer = timer;
}

/** Closes the view: widget, input subscription and timer go away; the entries and their numbers stay for reopening. */
export function closeAgentList(reason: string): void {
	const current = session;
	if (!current) return;
	session = null;
	if (current.timer) clearInterval(current.timer);
	current.unsubscribe();
	current.ctx.ui.setWidget(AGENT_LIST_WIDGET, undefined);
	current.ctx.ui.notify(`agent list closed (${reason})`, "info");
}

function handleInput(data: string): { consume: true } | undefined {
	const current = session;
	if (!current) return undefined;
	// The list opens unprompted, so it must never steal keys from a message the operator is composing: keys
	// reach the list only while the editor is empty (2026-09-13 terminal proof: digits, r and q vanished from a
	// typed /graph command).
	if (current.ctx.ui.getEditorText?.()) return undefined;
	// Under the kitty keyboard protocol a terminal may report the release of a key as well as its press, and the
	// release still matches the key (2026-09-13: one Escape press showed the cancel prompt and its release
	// aborted it). Releases are never actions here.
	if (isKeyRelease(data)) return undefined;
	if (isKeyRepeat(data) && !matchesKey(data, "up") && !matchesKey(data, "down")) return { consume: true };
	// A cancellation in flight cannot be aborted or confirmed twice; keys are answered, not acted on, until it reports.
	if (current.cancelling && (matchesKey(data, "escape") || matchesKey(data, "enter") || parseKey(data) === "q")) {
		current.ctx.ui.notify(`cancellation of run ${current.confirming?.runId ?? "?"} is in progress; wait for its report`, "info");
		return { consume: true };
	}
	// Keys are matched through pi-tui so the CSI-u encodings Pi enables (Escape as an escape sequence, not a
	// bare byte) are recognised the same as their legacy forms (2026-09-13 terminal proof: a bare-byte compare
	// let Escape fall through to the editor).
	const key = parseKey(data) ?? data;
	if (/^[0-9]$/.test(key)) {
		if (current.selected !== null) return undefined;
		current.pending += key;
		draw();
		return { consume: true };
	}
	if (matchesKey(data, "enter")) {
		if (current.confirming) { confirmCancellation(current); return { consume: true }; }
		if (current.pending) {
			const number = Number(current.pending);
			current.pending = "";
			if (entries.some((entry) => entry.number === number)) current.selected = number;
			else current.ctx.ui.notify(`no agent ${number} in the list`, "warning");
			draw();
			return { consume: true };
		}
		if (current.selected !== null) return { consume: true };
		// Enter alone (operator decision 2026-09-13): open the only running worker, or focus the list when several
		// are running so the arrows choose; numbers are labels, not something to type as the session grows.
		if (current.cursor) {
			if (current.cursor.kind === "row") current.selected = current.cursor.number;
			else { current.showSettled = true; const first = listRows(current.store).find((row) => !row.running); current.cursor = first ? { kind: "row", number: first.number } : null; }
			draw();
			return { consume: true };
		}
		const running = listRows(current.store).filter((row) => row.running);
		if (running.length === 1) current.selected = running[0]!.number;
		else if (running.length === 0) current.ctx.ui.notify("no running worker to open; type a settled worker's number to see its details", "info");
		else current.cursor = { kind: "row", number: running[0]!.number };
		draw();
		return { consume: true };
	}
	if (matchesKey(data, "up") || matchesKey(data, "down")) {
		if (!current.cursor || current.selected !== null) return undefined;
		const items = visibleItems(listRows(current.store), current.showSettled);
		const index = items.findIndex((item) => sameItem(current.cursor, item));
		const next = Math.min(items.length - 1, Math.max(0, (index < 0 ? 0 : index) + (matchesKey(data, "down") ? 1 : -1)));
		current.cursor = items[next] ?? null;
		draw();
		return { consume: true };
	}
	if (matchesKey(data, "escape")) {
		// Escape is the cancel key (operator decision 2026-09-13): it clears a pending number, aborts a pending
		// confirmation, or asks to cancel every running worker of the run in view. It never closes the view; q does.
		if (current.pending) { current.pending = ""; draw(); return { consume: true }; }
		if (current.confirming) { abortCancellation(current); return { consume: true }; }
		const runId = targetRunId(current);
		if (!runId) { current.ctx.ui.notify("no run in the list to cancel", "warning"); return { consume: true }; }
		const names = runningWorkerNames(current.store, runId);
		if (!names.length) { current.ctx.ui.notify(`run ${runId} has no running workers to cancel`, "info"); return { consume: true }; }
		current.confirming = { runId, names };
		draw();
		return { consume: true };
	}
	if (key === "q") {
		if (current.pending) { current.pending = ""; draw(); return { consume: true }; }
		if (current.confirming) { abortCancellation(current); return { consume: true }; }
		if (current.selected !== null) { current.selected = null; draw(); return { consume: true }; }
		if (current.cursor) { current.cursor = null; draw(); return { consume: true }; }
		closeAgentList("closed by operator");
		return { consume: true };
	}
	if (key === "r") { draw(); return { consume: true }; }
	if (key === "s") { current.showSettled = !current.showSettled; draw(); return { consume: true }; }
	return undefined;
}

/** The run the operator is looking at: the selected worker's run, otherwise the most recently registered one. */
function targetRunId(current: AgentListSession): string | null {
	const entry = current.selected !== null ? entries.find((item) => item.number === current.selected) : entries.at(-1);
	return entry?.runId ?? null;
}

function abortCancellation(current: AgentListSession): void {
	const runId = current.confirming?.runId;
	current.confirming = null;
	draw();
	if (runId) current.ctx.ui.notify(`cancellation of run ${runId} aborted; nothing was cancelled`, "info");
}

/** Runs the confirmed cancellation through the injected action, reports the outcome, and redraws whatever remains. */
function confirmCancellation(current: AgentListSession): void {
	const confirmation = current.confirming;
	if (!confirmation || current.cancelling) return;
	current.cancelling = true;
	draw();
	current.actions.cancelRun(confirmation.runId).then((report) => {
		const failures = report.failed.length ? `; ${report.failed.length} could not be confirmed stopped: ${report.failed.map((item) => `${item.agentName} (${item.error})`).join("; ")}` : "";
		current.ctx.ui.notify(`run ${report.runId} ${report.status}: cancelled ${report.cancelled.length} worker${report.cancelled.length === 1 ? "" : "s"}${report.cancelled.length ? ` (${report.cancelled.join(", ")})` : ""}${failures}`, report.failed.length ? "warning" : "info");
	}).catch((error: unknown) => {
		current.ctx.ui.notify(`cancellation of run ${confirmation.runId} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}).finally(() => {
		if (session === current) { current.cancelling = false; current.confirming = null; draw(); }
	});
}

function open(store: GraphStore, ctx: ExtensionContext, intervalMs: number, actions: AgentListActions): void {
	if (session) return;
	const unsubscribe = ctx.ui.onTerminalInput(handleInput);
	session = { ctx, store, intervalMs, actions, timer: null, unsubscribe, selected: null, pending: "", confirming: null, cancelling: false, showSettled: false, cursor: null };
	ensureTimer();
	draw();
}

/**
 * Called after a worker registered successfully in this session. Appends the attempt (once) with the next
 * number and opens the list if it is not on screen. A manual close does not block a later registration
 * from reopening it. Non-TUI contexts get nothing: no widget, no subscription, no timer.
 */
export function noteRegisteredAttempt(store: GraphStore, ctx: ExtensionContext, registration: { attemptKey: string; runId: string; operationId: string }, intervalMs: number, actions: AgentListActions): void {
	if (ctx.mode !== "tui") return;
	if (!entries.some((entry) => entry.attemptKey === registration.attemptKey)) {
		entries.push({ number: entries.length + 1, attemptKey: registration.attemptKey, runId: registration.runId, operationId: registration.operationId });
	}
	if (session) { ensureTimer(); draw(); return; }
	open(store, ctx, intervalMs, actions);
}

/** Explicit reopening of the overview for the attempts this session has seen; nothing to show is reported, not invented. */
export function reopenAgentList(store: GraphStore, ctx: ExtensionContext, intervalMs: number, actions: AgentListActions): boolean {
	if (ctx.mode !== "tui" || !entries.length) return false;
	if (session) { session.selected = null; session.pending = ""; session.confirming = null; draw(); return true; }
	open(store, ctx, intervalMs, actions);
	return true;
}

/** Read-only view of the session state, for tests and diagnostics. */
export function agentListState(): { entries: readonly AgentListEntry[]; open: boolean; selected: number | null; pending: string; timerActive: boolean; confirming: CancelConfirmation | null; showSettled: boolean; cursor: CursorItem | null } {
	return { entries: [...entries], open: session !== null, selected: session?.selected ?? null, pending: session?.pending ?? "", timerActive: session !== null && session.timer !== null, confirming: session?.confirming ?? null, showSettled: session?.showSettled ?? false, cursor: session?.cursor ?? null };
}

/** Test-only: forgets every entry and closes the view without notifying. */
export function resetAgentListForTests(): void {
	const current = session;
	session = null;
	if (current) { if (current.timer) clearInterval(current.timer); current.unsubscribe(); current.ctx.ui.setWidget(AGENT_LIST_WIDGET, undefined); }
	entries.length = 0;
}
