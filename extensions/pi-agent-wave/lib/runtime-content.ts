import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRuntimeContent, type RuntimeContent } from "./runtime-results.ts";

/** Private content-addressed storage; references never contain caller-supplied paths. */
export class RuntimeContentStore {
	private readonly root: string;

	constructor(dbPath: string) {
		this.root = join(realpathSync(dirname(dbPath)), "runtime-content");
	}

	private directory(): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const stat = lstatSync(this.root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("runtime content directory must be a regular directory");
		if ((stat.mode & 0o077) !== 0) throw new Error("runtime content directory must be private");
		const parentFd = openSync(dirname(this.root), constants.O_RDONLY);
		try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
	}

	path(reference: RuntimeContent): string {
		const content = parseRuntimeContent(reference);
		return join(this.root, content.sha256);
	}

	/** Reads and verifies the same opened file, with an explicit allocation bound. */
	read(reference: RuntimeContent, limit: number): Buffer {
		const content = parseRuntimeContent(reference);
		if (!Number.isSafeInteger(limit) || limit < 0 || content.bytes > limit) throw new Error("runtime content exceeds read limit");
		this.directory();
		const fd = openSync(this.path(content), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error("runtime content must be a private single regular file");
			if (stat.size !== content.bytes) throw new Error("runtime content digest mismatch");
			const bytes = Buffer.alloc(content.bytes); let offset = 0;
			while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
			if (offset !== content.bytes || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || createHash("sha256").update(bytes).digest("hex") !== content.sha256) throw new Error("runtime content digest mismatch");
			return bytes;
		} finally { closeSync(fd); }
	}

	verify(reference: RuntimeContent): void {
		this.directory();
		const path = this.path(reference);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runtime content must be a regular file, not a symlink");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.nlink !== 1) throw new Error("runtime content must be a single regular file");
			if ((opened.mode & 0o077) !== 0) throw new Error("runtime content must be private");
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let bytes = 0;
			for (;;) {
				const size = readSync(fd, buffer, 0, buffer.length, null);
				if (size === 0) break;
				bytes += size;
				hash.update(buffer.subarray(0, size));
			}
			if (bytes !== reference.bytes || hash.digest("hex") !== reference.sha256) throw new Error("runtime content digest mismatch");
		} finally { closeSync(fd); }
	}

	retain(bytes: Uint8Array): RuntimeContent {
		this.directory();
		const reference = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
		const temporary = join(this.root, `.pending-${randomUUID()}`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			let offset = 0;
			while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
			fsyncSync(fd);
		} catch (error) {
			closeSync(fd); unlinkSync(temporary); throw error;
		}
		closeSync(fd);
		try {
			try { linkSync(temporary, this.path(reference)); }
			catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
		} finally { unlinkSync(temporary); }
		const directoryFd = openSync(this.root, constants.O_RDONLY);
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		this.verify(reference);
		return reference;
	}
}
