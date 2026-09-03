#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAcpxAttemptIdentity, createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { parseWorkerTransportKind, type WorkerTransportKind } from "../lib/worker-transport.ts";

export interface AcpxPlanInput {
	runId: string;
	operationId: string;
	role: string;
	modelAttempt: number;
	transientAttempt: number;
	selectedModel: string;
	transport?: WorkerTransportKind;
	herdrAgent?: string;
	herdrTabId?: string;
	herdrPaneId?: string;
}

export function resolveAcpxPlan(input: AcpxPlanInput) {
	const core = { runId: input.runId, operationId: input.operationId, role: input.role, modelAttempt: input.modelAttempt, transientAttempt: input.transientAttempt, selectedModel: input.selectedModel, agent: selectAcpAgent(input.selectedModel) };
	if (input.transport === "headless") return createHeadlessAcpxAttemptIdentity(core);
	if (!input.herdrAgent || !input.herdrTabId || !input.herdrPaneId) throw new Error("Herdr plan requires agent, tab, and pane identity");
	return createAcpxAttemptIdentity({ ...core, herdrAgent: input.herdrAgent, herdrTabId: input.herdrTabId, herdrPaneId: input.herdrPaneId });
}

function main(): void {
	const [runId, operationId, role, modelAttempt, transientAttempt, selectedModel, herdrAgent, herdrTabId, herdrPaneId, transportValue] = process.argv.slice(2);
	const transport = transportValue === undefined ? "herdr" : parseWorkerTransportKind(transportValue);
	const plan = resolveAcpxPlan({
		runId,
		operationId,
		role,
		modelAttempt: Number(modelAttempt),
		transientAttempt: Number(transientAttempt),
		selectedModel,
		transport,
		herdrAgent,
		herdrTabId,
		herdrPaneId,
	});
	console.log(JSON.stringify(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); }
	catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
