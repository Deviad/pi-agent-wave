import { parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

// Node does not strip TypeScript inside installed npm packages. Limit the loader to our own sources.
const root = new URL('../', import.meta.url).href;
if (root.includes('/node_modules/')) registerHooks({ load(url, context, next) {
	if (url.startsWith(root) && url.endsWith('.ts') && !url.slice(root.length).includes('node_modules/')) {
		return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true };
	}
	return next(url, context);
} });
const { GraphStore } = await import('../store.ts');
const store = new GraphStore({ dbPath: workerData.dbPath });
try {
	const steps = store.runtimeIntegrationSteps(...workerData.args);
	for (;;) {
		const result = steps.next();
		parentPort.postMessage(result);
		if (result.done) break;
		await once(parentPort, 'message');
	}
} finally { store.close(); }
