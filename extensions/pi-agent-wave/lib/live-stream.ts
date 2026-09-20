import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/**
 * The live view for a worker that has no terminal to read.
 *
 * A headless worker publishes its output on the loopback endpoint its supervisor owns (see
 * `scripts/stream_endpoint.py`), so this is what the view reads instead of the capture file. Reading is
 * asynchronous, deadline-bounded and cached: the renderers stay synchronous, so a worker, a socket or a
 * `herdr` process can never stall the terminal, and the redraw interval decides freshness.
 *
 * The reader polls the endpoint's bounded backlog rather than holding a long-lived subscriber open. That
 * is deliberate: the publisher drops a subscriber whose socket buffer fills, so a view that held one open
 * and fell behind would lose its stream, while a poll that reads promptly and disconnects always finds
 * the recent window waiting.
 */

export interface LiveView {
	/** The most recent lines the worker published, oldest first; empty when there is nothing to show. */
	readonly lines: readonly string[];
	/** Why there is nothing to show, or null when `lines` carries the worker's output. */
	readonly note: string | null;
}

export const LIVE_VIEW_PENDING = "(reading the worker's live stream\u2026)";
export const LIVE_VIEW_QUIET = "(the worker's stream is open and has published nothing yet)";
export const LIVE_VIEW_UNAVAILABLE = "(no live stream: this worker is not publishing one, or the attempt has settled)";

const REFRESH_BUDGET_MS = 1_200;
/** How long the stream must be silent before the backlog is taken as complete. */
const QUIET_MS = 150;
const MAX_BYTES = 256 * 1024;
const LINE_LIMIT = 160;
const ENDPOINT_SUFFIX = ".stream-endpoint.json";
const TOKEN_SUFFIX = ".stream-token";

const views = new Map<string, LiveView>();

/** The cached view for one attempt, or null when it has never been read. Never blocks. */
export function liveViewFor(attemptKey: string): LiveView | null {
	return views.get(attemptKey) ?? null;
}

/** Forgets every cached view. Test-only: production state is per-attempt and lives as long as the session. */
export function resetLiveViewsForTests(): void {
	views.clear();
}

/**
 * The run directory that holds a worker's published stream, found by searching upward from the agent's
 * cancel script for the descriptor rather than by counting directories: one operation has one worker, so
 * its run directory carries at most one. The search is what keeps a layout change a missing view instead
 * of a silent read of the wrong directory.
 */
export function streamRunDirectory(cancelScript: string | null | undefined, levels = 5): string | null {
	if (!cancelScript) return null;
	let candidate = dirname(cancelScript);
	for (let level = 0; level < levels; level += 1) {
		try {
			if (readdirSync(candidate).some((name) => name.endsWith(ENDPOINT_SUFFIX))) return candidate;
		} catch {
			return null;
		}
		candidate = dirname(candidate);
	}
	return null;
}

interface StreamEndpoint {
	readonly host: string;
	readonly port: number;
	readonly token: string;
}

/** The published endpoint in one run directory, or null when this worker publishes nothing. */
export function streamEndpointIn(runDirectory: string): StreamEndpoint | null {
	let names: string[];
	try {
		names = readdirSync(runDirectory);
	} catch {
		return null;
	}
	const endpointName = names.find((name) => name.endsWith(ENDPOINT_SUFFIX));
	if (!endpointName) return null;
	const tokenName = `${endpointName.slice(0, -ENDPOINT_SUFFIX.length)}${TOKEN_SUFFIX}`;
	if (!names.includes(tokenName)) return null;
	try {
		const descriptor: unknown = JSON.parse(readFileSync(join(runDirectory, endpointName), "utf8"));
		if (typeof descriptor !== "object" || descriptor === null) return null;
		const record = descriptor as Record<string, unknown>;
		// The resolver's backend is part of the handshake: a descriptor this reader does not understand is
		// not something to guess at.
		if (record.backend !== "loopback-tcp") return null;
		const host = record.host;
		const port = record.port;
		const token = readFileSync(join(runDirectory, tokenName), "utf8").trim();
		if (typeof host !== "string" || typeof port !== "number" || !token) return null;
		return { host, port, token };
	} catch {
		return null;
	}
}

/** Strips the terminal colouring the stream carries, so a view renders text rather than escape sequences. */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function toLines(text: string, limit: number): readonly string[] {
	return stripAnsi(text)
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.trim().length > 0)
		.map((line) => line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}\u2026` : line)
		.slice(-limit);
}

function readBacklog(endpoint: StreamEndpoint): Promise<string | null> {
	return new Promise((resolve) => {
		const socket = connect({ host: endpoint.host, port: endpoint.port });
		let text = "";
		let finished = false;
		let quiet: NodeJS.Timeout | null = null;
		const finish = (value: string | null): void => {
			if (finished) return;
			finished = true;
			if (quiet) clearTimeout(quiet);
			clearTimeout(budget);
			socket.destroy();
			resolve(value);
		};
		const budget = setTimeout(() => finish(text || null), REFRESH_BUDGET_MS);
		budget.unref?.();
		const settle = (): void => {
			if (quiet) clearTimeout(quiet);
			quiet = setTimeout(() => finish(text || null), QUIET_MS);
			quiet.unref?.();
		};
		socket.on("connect", () => socket.write(`${endpoint.token}\n`));
		socket.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.length >= MAX_BYTES) finish(text);
			else settle();
		});
		// An error or a timeout still reports whatever arrived, and the caller decides what it means.
		socket.on("error", () => finish(text || null));
		socket.on("timeout", () => finish(text || null));
		socket.on("close", () => finish(text || null));
		socket.setTimeout(REFRESH_BUDGET_MS);
		settle();
	});
}

/**
 * Reads one attempt's published stream into the cache. Never throws and never rejects: any failure leaves
 * the last view in place, so a settled attempt whose directory is gone does not blank a view the operator
 * is reading.
 */
export async function refreshLiveView(attemptKey: string, runDirectory: string | null, lineLimit = 12): Promise<void> {
	const endpoint = runDirectory ? streamEndpointIn(runDirectory) : null;
	if (!endpoint) {
		if (!views.has(attemptKey)) views.set(attemptKey, { lines: [], note: LIVE_VIEW_UNAVAILABLE });
		return;
	}
	const text = await readBacklog(endpoint);
	if (text === null || text.trim() === "unauthorized") {
		if (!views.has(attemptKey)) views.set(attemptKey, { lines: [], note: LIVE_VIEW_UNAVAILABLE });
		return;
	}
	const lines = toLines(text, lineLimit);
	views.set(attemptKey, { lines, note: lines.length ? null : LIVE_VIEW_QUIET });
}