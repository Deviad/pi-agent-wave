import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

interface AgentListSession {
	readonly ctx: ExtensionContext;
	readonly store: GraphStore;
	readonly intervalMs: number;
	timer: ReturnType<typeof setInterval> | null;
	unsubscribe: () => void;
	selected: number | null;
	pending: string;
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
			return { number: entry.number, agentName: agent?.name ?? entry.operationId, node: store.getOperation(entry.operationId).node, state: processLabel(attempt), model: shortModel(agent?.selected_model ?? null), activity };
		} catch (error) {
			return { number: entry.number, agentName: entry.operationId, node: "?", state: `unavailable (${error instanceof Error ? error.message : String(error)})`, model: "?", activity: "" };
		}
	});
}

export function renderAgentList(rows: readonly AgentListRow[], pending: string): string[] {
	const lines = [`agents (${rows.length}) | keys: number then Enter opens details, r refresh, q or Esc close`];
	for (const row of rows) lines.push(`${row.number}. ${row.agentName} | ${row.node} | ${row.state} | ${row.model} | ${row.activity}`);
	if (pending) lines.push(`selecting: ${pending}_ (Enter opens, Esc clears)`);
	return lines;
}

export function renderAgentDetail(detail: AgentDetail): string[] {
	const lines = [
		`agent ${detail.number}: ${detail.agentName} | keys: q or Esc back to list, r refresh`,
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
		if (!entry) { current.selected = null; content = renderAgentList(listRows(current.store), current.pending); }
		else {
			try { content = renderAgentDetail(attemptDetail(current.store, entry)); }
			catch (error) { content = [`agent ${entry.number}: details unavailable (${error instanceof Error ? error.message : String(error)}) | keys: q or Esc back to list, r refresh`]; }
		}
	} else {
		content = renderAgentList(listRows(current.store), current.pending);
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
	if (/^[0-9]$/.test(data)) {
		if (current.selected !== null) return undefined;
		current.pending += data;
		draw();
		return { consume: true };
	}
	if (data === "\r" || data === "\n") {
		if (!current.pending) return undefined;
		const number = Number(current.pending);
		current.pending = "";
		if (entries.some((entry) => entry.number === number)) current.selected = number;
		else current.ctx.ui.notify(`no agent ${number} in the list`, "warning");
		draw();
		return { consume: true };
	}
	if (data === "q" || data === "") {
		if (current.pending) { current.pending = ""; draw(); return { consume: true }; }
		if (current.selected !== null) { current.selected = null; draw(); return { consume: true }; }
		closeAgentList("closed by operator");
		return { consume: true };
	}
	if (data === "r") { draw(); return { consume: true }; }
	return undefined;
}

function open(store: GraphStore, ctx: ExtensionContext, intervalMs: number): void {
	if (session) return;
	const unsubscribe = ctx.ui.onTerminalInput(handleInput);
	session = { ctx, store, intervalMs, timer: null, unsubscribe, selected: null, pending: "" };
	ensureTimer();
	draw();
}

/**
 * Called after a worker registered successfully in this session. Appends the attempt (once) with the next
 * number and opens the list if it is not on screen. A manual close does not block a later registration
 * from reopening it. Non-TUI contexts get nothing: no widget, no subscription, no timer.
 */
export function noteRegisteredAttempt(store: GraphStore, ctx: ExtensionContext, registration: { attemptKey: string; runId: string; operationId: string }, intervalMs: number): void {
	if (ctx.mode !== "tui") return;
	if (!entries.some((entry) => entry.attemptKey === registration.attemptKey)) {
		entries.push({ number: entries.length + 1, attemptKey: registration.attemptKey, runId: registration.runId, operationId: registration.operationId });
	}
	if (session) { ensureTimer(); draw(); return; }
	open(store, ctx, intervalMs);
}

/** Explicit reopening of the overview for the attempts this session has seen; nothing to show is reported, not invented. */
export function reopenAgentList(store: GraphStore, ctx: ExtensionContext, intervalMs: number): boolean {
	if (ctx.mode !== "tui" || !entries.length) return false;
	if (session) { session.selected = null; session.pending = ""; draw(); return true; }
	open(store, ctx, intervalMs);
	return true;
}

/** Read-only view of the session state, for tests and diagnostics. */
export function agentListState(): { entries: readonly AgentListEntry[]; open: boolean; selected: number | null; pending: string; timerActive: boolean } {
	return { entries: [...entries], open: session !== null, selected: session?.selected ?? null, pending: session?.pending ?? "", timerActive: session !== null && session.timer !== null };
}

/** Test-only: forgets every entry and closes the view without notifying. */
export function resetAgentListForTests(): void {
	const current = session;
	session = null;
	if (current) { if (current.timer) clearInterval(current.timer); current.unsubscribe(); current.ctx.ui.setWidget(AGENT_LIST_WIDGET, undefined); }
	entries.length = 0;
}
