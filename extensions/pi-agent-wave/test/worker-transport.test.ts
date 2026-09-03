import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	WORKER_TRANSPORT_KINDS,
	headlessPresentationIdentity,
	herdrPresentationIdentity,
	parseWorkerPresentationIdentity,
	parseWorkerTransportKind,
	presentationIdentityEquals,
	workerAttemptIdentity,
	type WorkerPresentationIdentity,
	type WorkerTransportPort,
} from "../lib/worker-transport.ts";

type MixedHeadlessIsValid = { kind: "headless"; agent: string } extends WorkerPresentationIdentity ? true : false;
type PartialHerdrIsValid = { kind: "herdr"; agent: string } extends WorkerPresentationIdentity ? true : false;
const mixedHeadlessIsValid: MixedHeadlessIsValid = false;
const partialHerdrIsValid: PartialHerdrIsValid = false;

const identity = workerAttemptIdentity({
	runId: "run-1",
	operationId: "operation-1",
	role: "reviewer",
	modelAttempt: 1,
	transientAttempt: 2,
	acpAgent: "codex",
	acpxSessionId: "session-1",
	acpxRecordId: "record-1",
	acpxAttemptKey: "run-1:operation-1:reviewer:1:2:model:codex",
	agentFsSessionId: "agentfs-1",
	agentFsDbPath: "/tmp/agentfs-1.db",
});

const headlessAdapter = {
	kind: "headless",
	async launch(request) { return { identity: request.identity, presentation: headlessPresentationIdentity() }; },
	async wait(handle) { return { identity: handle.identity, verdict: "PASS", reportPath: "/tmp/report.json", settlementEvidencePath: "/tmp/settlement.json", cleanupEvidencePath: "/tmp/cleanup.json" }; },
	async cancel() {},
	async cleanup() {},
	async observeProgress(handle, listener) { listener({ identity: handle.identity, kind: "progress", detail: "running" }); },
} satisfies WorkerTransportPort;

const herdrAdapter = {
	...headlessAdapter,
	kind: "herdr",
	async launch(request) { return { identity: request.identity, presentation: herdrPresentationIdentity("agent", "tab", "pane") }; },
	async focus() {},
} satisfies WorkerTransportPort;

describe("worker transport Value Objects", () => {
	test("freezes the finite transport set and parses only allowed values", () => {
		assert.deepEqual(WORKER_TRANSPORT_KINDS, ["headless", "herdr"]);
		assert.equal(Object.isFrozen(WORKER_TRANSPORT_KINDS), true);
		assert.equal(parseWorkerTransportKind("headless"), "headless");
		assert.equal(parseWorkerTransportKind("herdr"), "herdr");
		assert.throws(() => parseWorkerTransportKind("panel"), /unsupported worker transport/);
	});

	test("constructs immutable value-equal headless and Herdr identities", () => {
		const headless = headlessPresentationIdentity();
		const herdr = herdrPresentationIdentity("agent", "tab", "pane");
		assert.equal(Object.isFrozen(headless), true);
		assert.equal(Object.isFrozen(herdr), true);
		assert.equal(presentationIdentityEquals(headless, headlessPresentationIdentity()), true);
		assert.equal(presentationIdentityEquals(herdr, herdrPresentationIdentity("agent", "tab", "pane")), true);
		assert.equal(presentationIdentityEquals(headless, herdr), false);
	});

	test("rejects mixed, partial, empty, and unsupported presentation states", () => {
		assert.equal(mixedHeadlessIsValid, false);
		assert.equal(partialHerdrIsValid, false);
		assert.throws(() => parseWorkerPresentationIdentity({ kind: "headless", agent: "wrong" }), /cannot contain Herdr fields/);
		assert.throws(() => parseWorkerPresentationIdentity({ kind: "herdr", agent: "agent", tabId: "tab" }), /Herdr pane required/);
		assert.throws(() => parseWorkerPresentationIdentity({ kind: "herdr", agent: "", tabId: "tab", paneId: "pane" }), /Herdr agent required/);
		assert.throws(() => parseWorkerPresentationIdentity({ kind: "panel" }), /unsupported presentation identity/);
	});

	test("retains exact transport-independent attempt identity", () => {
		assert.equal(Object.isFrozen(identity), true);
		assert.deepEqual(identity, {
			runId: "run-1", operationId: "operation-1", role: "reviewer", modelAttempt: 1, transientAttempt: 2,
			acpAgent: "codex", acpxSessionId: "session-1", acpxRecordId: "record-1",
			acpxAttemptKey: "run-1:operation-1:reviewer:1:2:model:codex", agentFsSessionId: "agentfs-1", agentFsDbPath: "/tmp/agentfs-1.db",
		});
		assert.equal("transport" in identity, false);
		assert.equal("paneId" in identity, false);
	});
});

describe("worker transport port", () => {
	test("supports a headless adapter without focus", async () => {
		const handle = await headlessAdapter.launch({ identity, taskFile: "/tmp/task.md", reportPath: "/tmp/report.json", readOnly: true, ownedPaths: [] });
		assert.equal(handle.presentation.kind, "headless");
		assert.equal(headlessAdapter.focus, undefined);
		assert.equal((await headlessAdapter.wait(handle)).verdict, "PASS");
	});

	test("supports a focus-capable Herdr adapter", async () => {
		const handle = await herdrAdapter.launch({ identity, taskFile: "/tmp/task.md", reportPath: "/tmp/report.json", readOnly: false, ownedPaths: ["src"] });
		assert.equal(handle.presentation.kind, "herdr");
		await herdrAdapter.focus(handle);
	});
});
