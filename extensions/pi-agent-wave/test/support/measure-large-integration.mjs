import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, dirname, sep } from 'node:path';

// Count at the real filesystem and digest boundaries in this subprocess only.
const [dbPath, id] = process.argv.slice(2);
const root = join(fs.realpathSync(dirname(dbPath)), 'runtime-content') + sep;
const descriptors = new Set();
let contentBytes = 0;
const { openSync, readSync, closeSync } = fs;
fs.openSync = function(path, ...args) {
	const fd = openSync(path, ...args);
	if (typeof path === 'string' && path.startsWith(root)) descriptors.add(fd);
	return fd;
};
fs.readSync = function(fd, ...args) {
	const bytes = readSync(fd, ...args);
	if (descriptors.has(fd)) contentBytes += bytes;
	return bytes;
};
fs.closeSync = function(fd) { descriptors.delete(fd); return closeSync(fd); };
syncBuiltinESMExports();

const results = new URL('../../lib/runtime-results.ts', import.meta.url).href;
let manifestDigests = 0;
globalThis.countIntegrationDigest = value => { if (value.entries || value.manifest) manifestDigests++; };
registerHooks({ resolve(specifier, context, next) {
	if (specifier === './runtime-results.ts' && context.parentURL?.endsWith('/runtime-integration.ts')) {
		const wrapper = `export * from ${JSON.stringify(results)}; import {runtimeDigest as digest} from ${JSON.stringify(results)}; export function runtimeDigest(value) { globalThis.countIntegrationDigest(value); return digest(value); }`;
		return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(wrapper) };
	}
	return next(specifier, context);
} });
const { RuntimeIntegration } = await import('../../lib/runtime-integration.ts');
const journal = new RuntimeIntegration(dbPath);
try {
	const start = performance.now();
	const { state } = journal.apply(id);
	console.log(JSON.stringify({ state, elapsed: performance.now() - start, manifestDigests, contentBytes }));
} finally { journal.close(); }
