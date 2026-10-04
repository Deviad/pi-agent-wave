import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseRuntimeContent } from "./runtime-results.ts";
import type { RunInput, RunInputDeclaration } from "../types.ts";

export const INPUT_FILE_LIMIT = 10 * 1024 * 1024;
export const INPUT_TOTAL_LIMIT = 32 * 1024 * 1024;
export const INPUT_COUNT_LIMIT = 32;
const INPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CapturedRunInput {
	readonly name: string;
	readonly sourcePath: string;
	readonly content: Buffer;
}

function inputName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !INPUT_NAME.test(name)) throw new Error("invalid input name; use 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
}

/** Captures a complete bounded set before any content is retained or run created. */
export function captureRunInputs(declarations: readonly RunInputDeclaration[], home = homedir()): CapturedRunInput[] {
	if (declarations.length > INPUT_COUNT_LIMIT) throw new Error("at most 32 inputs may be declared; choose a smaller required file set");
	const names = new Set<string>(); const paths = new Set<string>(); const identities = new Set<string>();
	const captured: CapturedRunInput[] = [];
	let total = 0;
	for (const declaration of declarations) {
		let fd: number | undefined;
		try {
			inputName(declaration.name);
			if (names.has(declaration.name)) throw new Error("duplicate name");
			names.add(declaration.name);
			const expanded = declaration.path.replace(/^(?:~|\$HOME|\$\{HOME\})\//, `${home}/`);
			if (!isAbsolute(expanded)) throw new Error("path must be absolute or start with a host HOME reference");
			const sourcePath = join(realpathSync(dirname(expanded)), basename(expanded));
			if (paths.has(sourcePath)) throw new Error("duplicate canonical path");
			paths.add(sourcePath);
			fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const before = fstatSync(fd);
			if (!before.isFile()) throw new Error("source must be a regular file, not a directory or other resource");
			if ((before.mode & 0o444) === 0) throw new Error("source is unreadable");
			if (before.size > INPUT_FILE_LIMIT) throw new Error("source exceeds 10 MiB per-file limit; choose a smaller required file");
			total += before.size;
			if (total > INPUT_TOTAL_LIMIT) throw new Error("inputs exceed 32 MiB total limit; choose a smaller required file set");
			const identity = `${before.dev}:${before.ino}`;
			if (identities.has(identity)) throw new Error("duplicate opened file identity");
			identities.add(identity);
			const content = Buffer.alloc(before.size);
			let offset = 0;
			while (offset < content.length) {
				const count = readSync(fd, content, offset, content.length - offset, null);
				if (!count) break;
				offset += count;
			}
			const after = fstatSync(fd); const entry = lstatSync(sourcePath);
			if (offset !== before.size || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 ||
				after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
				entry.isSymbolicLink() || entry.dev !== before.dev || entry.ino !== before.ino) throw new Error("source changed during capture");
			captured.push({ name: declaration.name, sourcePath, content });
		} catch (error) {
			throw new Error(`input ${declaration.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		} finally { if (fd !== undefined) closeSync(fd); }
	}
	return captured;
}

/** Validates persisted references without interpreting caller provenance as a worker path. */
export function parseRunInputs(value: unknown): RunInput[] {
	if (!Array.isArray(value) || value.length > INPUT_COUNT_LIMIT) throw new Error("invalid run inputs");
	const names = new Set<string>(); let total = 0;
	return value.map((item: unknown) => {
		if (!item || typeof item !== "object" || !("name" in item) || !("sourcePath" in item)) throw new Error("invalid run input record");
		inputName(item.name);
		if (names.has(item.name)) throw new Error("duplicate run input name");
		names.add(item.name);
		if (typeof item.sourcePath !== "string" || !isAbsolute(item.sourcePath)) throw new Error("invalid input provenance");
		const content = parseRuntimeContent(item);
		total += content.bytes;
		if (content.bytes > INPUT_FILE_LIMIT || total > INPUT_TOTAL_LIMIT) throw new Error("run input size limit exceeded");
		return { name: item.name, sourcePath: item.sourcePath, ...content };
	});
}
