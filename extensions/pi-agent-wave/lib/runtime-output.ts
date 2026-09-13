import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RuntimePublicCapture, type RuntimeCaptureIdentity, type RuntimeCaptureSummary } from "./runtime-capture.ts";
import { parseRuntimeOutcome, type RuntimeOutcome } from "./runtime-results.ts";

export interface RuntimeOutputResult {
	readonly schemaVersion: 1;
	readonly attemptKey: string;
	readonly sessionId: string;
	readonly outcome: RuntimeOutcome;
	readonly capture: RuntimeCaptureSummary;
	readonly stderrTruncated: boolean;
}
function write(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/** Exclusive per-attempt files; essential writes fail loudly and no report is read or generated. */
export class RuntimeOutputFiles {
	private readonly root: string;
	private readonly identity: Omit<RuntimeCaptureIdentity, "requestId">;
	private readonly fds: number[] = [];
	private readonly stdoutFd: number;
	private readonly stderrFd: number;
	private readonly capture: RuntimePublicCapture;
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private stderrTruncated = false;
	private result: RuntimeOutputResult | undefined;
	private closed = false;

	constructor(root: string, identity: Omit<RuntimeCaptureIdentity, "requestId"> & { requestId: string | null }) {
		this.root = root; this.identity = { attemptKey: identity.attemptKey, sessionId: identity.sessionId };
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const stat = lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("runtime output requires a private directory");
		try {
			this.stdoutFd = this.open("worker.stdout.ndjson");
			this.stderrFd = this.open("worker.stderr.txt");
			const answerFd = this.open("public-answer.txt");
			const provenanceFd = this.open("public-provenance.ndjson");
			this.capture = new RuntimePublicCapture(identity, (text, source) => {
				write(answerFd, Buffer.from(text)); write(provenanceFd, Buffer.from(JSON.stringify(source) + "\n"));
			});
		} catch (error) { this.close(); throw error; }
	}
	private open(name: string): number { const fd = openSync(join(this.root, name), "wx", 0o600); this.fds.push(fd); return fd; }
	private assertOpen(): void { if (this.closed) throw new Error("runtime output is closed"); }
	stdout(bytes: Buffer): void {
		this.assertOpen();
		const remaining = Math.max(0, 16 * 1024 * 1024 - this.stdoutBytes);
		const kept = bytes.subarray(0, remaining); write(this.stdoutFd, kept); this.stdoutBytes += kept.length;
		this.capture.write(bytes);
	}
	stderr(bytes: Buffer): void {
		this.assertOpen();
		const remaining = Math.max(0, 1024 * 1024 - this.stderrBytes);
		const kept = bytes.subarray(0, remaining); write(this.stderrFd, kept); this.stderrBytes += kept.length;
		this.stderrTruncated ||= kept.length < bytes.length;
	}
	finish(outcome: RuntimeOutcome): RuntimeOutputResult {
		if (this.result) return this.result;
		this.assertOpen();
		try {
			const result: RuntimeOutputResult = { schemaVersion: 1, ...this.identity, outcome: parseRuntimeOutcome(outcome), capture: this.capture.finish(), stderrTruncated: this.stderrTruncated };
			for (const fd of this.fds) fsyncSync(fd);
			const metadata = this.open("runtime-output.pending");
			write(metadata, Buffer.from(JSON.stringify(result, null, 2) + "\n")); fsyncSync(metadata);
			this.close();
			renameSync(join(this.root, "runtime-output.pending"), join(this.root, "runtime-output.json"));
			const directory = openSync(this.root, constants.O_RDONLY);
			try { fsyncSync(directory); } finally { closeSync(directory); }
			this.result = result; return result;
		} finally { this.close(); }
	}
	close(): void { if (this.closed) return; this.closed = true; for (const fd of this.fds.splice(0)) closeSync(fd); }
}
