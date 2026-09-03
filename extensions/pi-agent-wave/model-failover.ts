/**
 * Same-tier runtime failover. Delegate Graph workers are armed from their frozen
 * route; interactive sessions opt in with `/failover enable <tier>`.
 */
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireRuntime } from "./require-runtime.ts";
import {
	MODEL_FAILOVER_BLOCKED,
	MODEL_FAILOVER_RETRY,
	MODEL_FAILOVER_TRANSPORT_RETRY,
	classifyFailoverError,
	findNextFailoverCandidate,
	loadTierRoute,
	parseFailoverRoute,
	sanitizeAssistantError,
} from "./lib/model-failover-native.mjs";

const READY_ENTRY_TYPE = "model-failover-ready-v1";
const READY_CODE = "MODEL_FAILOVER_READY";
const EVENT_ENTRY_TYPE = "model-failover-event-v1";
const EVENT_CODE = "MODEL_FAILOVER_EVENT";

type SettingsSnapshot = { path: string; bytes: Buffer | undefined };

function modelKey(model: any): string {
	return model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : "";
}

function assistantModelKey(message: any): string {
	return message && typeof message.provider === "string" && typeof message.model === "string" ? `${message.provider}/${message.model}` : "";
}

function modelProvider(model: any): string {
	return model && typeof model.provider === "string" ? model.provider : "";
}

function agentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function routingPath(): string {
	return process.env.PI_MODEL_ROUTING?.trim() || join(agentDirectory(), "model-routing.jsonc");
}

function captureSettings(): SettingsSnapshot {
	const path = join(agentDirectory(), "settings.json");
	return { path, bytes: existsSync(path) ? readFileSync(path) : undefined };
}

function restoreSettings(snapshot: SettingsSnapshot): void {
	if (snapshot.bytes === undefined) rmSync(snapshot.path, { force: true });
	else writeFileSync(snapshot.path, snapshot.bytes);
	const restored = snapshot.bytes === undefined
		? !existsSync(snapshot.path)
		: existsSync(snapshot.path) && readFileSync(snapshot.path).equals(snapshot.bytes);
	if (!restored) throw new Error("global settings restoration failed");
}

function visibleRoleJson(role: string, tier: string | undefined): string {
	return JSON.stringify({ status: "blocked", error: MODEL_FAILOVER_BLOCKED, role, tier, outcome: "route-exhausted" });
}

function statusText(state: any): string {
	return JSON.stringify({
		correlationId: state.correlationId,
		enabled: state.enabled,
		role: state.role,
		tier: state.tier,
		routeIndex: state.cursor,
		currentModel: state.route[state.cursor] ?? undefined,
		nextModel: state.route[state.cursor + 1] ?? undefined,
		lock: state.explicitLock ? "explicit" : state.manualLock ? "manual" : "none",
		decision: state.transientStatus?.decision,
		outcome: state.transientStatus?.outcome,
		recovery: state.latestRecovery,
	});
}

export default function modelFailoverExtension(pi: any): void {
	requireRuntime();
	const state: any = {
		enabled: false,
		explicitLock: process.env.PI_FAILOVER_LOCKED === "1",
		manualLock: false,
		role: process.env.PI_DELEGATION_KIND === "role" ? process.env.PI_FAILOVER_ROLE?.trim() || undefined : "main",
		tier: process.env.PI_FAILOVER_TIER?.trim() || undefined,
		route: [],
		cursor: -1,
		excludedProviders: new Set<string>(),
		pendingOwnSwitch: undefined,
		readySequence: 0,
		pendingReady: undefined,
		lastProviderResponse: undefined,
		latestRecovery: undefined,
		correlationId: Math.random().toString(36).slice(2, 14),
		transientStatus: undefined,
	};
	let activeContext: any;

	function setStatus(ctx: any, decision: string, outcome: string): void {
		state.transientStatus = { decision, outcome };
		try { ctx?.ui?.setStatus?.("model-failover", statusText(state)); } catch { /* UI is best effort. */ }
	}

	function clearStatus(ctx: any): void {
		state.transientStatus = undefined;
		try { ctx?.ui?.setStatus?.("model-failover", undefined); } catch { /* UI is best effort. */ }
	}

	function nextCorrelationId(): string {
		return `${state.correlationId}:${++state.readySequence}`;
	}

	function clearPendingReady(): void {
		state.pendingReady = undefined;
	}

	function recoveryDetails(classification: any, sourceModel: string, destinationModel: string | undefined, routeIndex: number, correlationId: string): any {
		return {
			correlationId,
			role: state.role || "main",
			tier: state.tier,
			sourceModel,
			destinationModel,
			classification: classification.category,
			statusCode: classification.statusCode,
			routeIndex,
		};
	}

	function appendRecoveryEvent(ctx: any, decision: string, outcome: string, details: any): void {
		const payload = { version: 1, code: EVENT_CODE, ...details, outcome };
		state.latestRecovery = payload;
		try { pi.appendEntry?.(EVENT_ENTRY_TYPE, payload); } catch { /* Evidence persistence is best effort. */ }
		setStatus(ctx, decision, outcome);
	}

	function armPendingReady(details: any): void {
		if (!state.pendingReady) state.pendingReady = { correlationId: details.correlationId, attempts: [] };
		state.pendingReady.current = details;
		state.pendingReady.attempts.push({ ...details, outcome: "retrying" });
	}

	function appendReadyReceipt(ctx: any, message: any): void {
		const pending = state.pendingReady;
		const acceptedModel = assistantModelKey(message);
		if (!pending || acceptedModel !== pending.current?.destinationModel) {
			if (pending) clearPendingReady();
			return;
		}
		clearPendingReady();
		const current = pending.current;
		const payload = {
			version: 1,
			code: READY_CODE,
			...current,
			from: current.sourceModel,
			to: current.destinationModel,
			attempts: pending.attempts,
			outcome: "success",
		};
		state.latestRecovery = payload;
		try { pi.appendEntry?.(READY_ENTRY_TYPE, payload); } catch { /* Receipt persistence is best effort. */ }
		setStatus(ctx, "recovered", "success");
	}

	function armRoute(route: string[], tier: string): boolean {
		const current = modelKey(activeContext?.model);
		const cursor = route.indexOf(current);
		if (cursor < 0) return false;
		state.route = route;
		state.tier = tier;
		state.cursor = cursor;
		state.enabled = true;
		state.transientStatus = undefined;
		return true;
	}

	function emitStatus(ctx: any): void {
		try { ctx?.ui?.notify?.(statusText(state), "info"); } catch { /* UI is best effort. */ }
	}

	function appendLockIntent(locked: boolean, source: string): void {
		try { pi.appendEntry?.("model-failover-lock", { locked, source }); } catch { /* Persistence is best effort. */ }
	}

	function latestPersistedManualLock(ctx: any): boolean {
		const entries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry?.type !== "custom" || entry.customType !== "model-failover-lock") continue;
			return entry.data?.locked === true;
		}
		return false;
	}

	pi.on?.("session_start", async (event: any, ctx: any) => {
		activeContext = ctx;
		state.enabled = false;
		state.manualLock = event?.reason === "reload" || event?.reason === "restore" ? latestPersistedManualLock(ctx) : false;
		state.pendingOwnSwitch = undefined;
		clearPendingReady();
		state.excludedProviders.clear();
		state.lastProviderResponse = undefined;
		state.latestRecovery = undefined;
		state.transientStatus = undefined;
		const isRole = process.env.PI_DELEGATION_KIND === "role";
		if (!isRole || state.explicitLock) return;
		try {
			const route = parseFailoverRoute(process.env.PI_FAILOVER_ROUTE ?? "");
			const tier = process.env.PI_FAILOVER_TIER?.trim() ?? "";
			const role = process.env.PI_FAILOVER_ROLE?.trim() ?? "";
			if (!tier || !role || process.env.PI_FAILOVER_LOCKED !== "0" || state.manualLock) return;
			state.role = role;
			if (!armRoute(route, tier)) {
				state.enabled = false;
				state.route = [];
			}
		} catch {
			state.enabled = false;
			state.route = [];
		}
	});

	pi.on?.("before_agent_start", async (_event: any, ctx: any) => {
		activeContext = ctx;
		clearPendingReady();
		state.excludedProviders.clear();
		state.lastProviderResponse = undefined;
		clearStatus(ctx);
	});

	pi.on?.("before_provider_request", async (_event: any, ctx: any) => {
		activeContext = ctx;
		state.lastProviderResponse = undefined;
	});

	pi.on?.("after_provider_response", async (event: any, ctx: any) => {
		activeContext = ctx;
		state.lastProviderResponse = {
			provider: modelProvider(ctx?.model),
			status: Number.isInteger(event?.status) ? event.status : undefined,
		};
	});

	pi.on?.("model_select", async (event: any, _ctx: any) => {
		const from = modelKey(event?.previousModel);
		const to = modelKey(event?.model);
		if (event?.source === "restore") { clearPendingReady(); return; }
		if (event?.source === "set" && state.pendingOwnSwitch && state.pendingOwnSwitch.from === from && state.pendingOwnSwitch.to === to) {
			state.pendingOwnSwitch = undefined;
			return;
		}
		clearPendingReady();
		state.manualLock = true;
		appendLockIntent(true, event.source);
		setStatus(activeContext, "manual-lock", "external-model-selection");
	});

	pi.on?.("message_end", async (event: any, ctx: any) => {
		activeContext = ctx;
		const message = event?.message;
		if (message?.role !== "assistant") return undefined;
		const response = state.lastProviderResponse;
		state.lastProviderResponse = undefined;
		if (message.stopReason !== "error") {
			appendReadyReceipt(ctx, message);
			state.excludedProviders.clear();
			clearStatus(ctx);
			return undefined;
		}
		if (!state.enabled || state.explicitLock || state.manualLock) { clearPendingReady(); return undefined; }
		const classification = classifyFailoverError(message, {
			contextWindow: ctx?.model?.contextWindow ?? 0,
			responseStatus: response?.provider === modelProvider(ctx?.model) ? response.status : undefined,
			isContextOverflow,
			isRetryableAssistantError,
		});
		if (classification.kind !== "ordinary" && classification.kind !== "quota" && classification.kind !== "connection-closed") {
			clearPendingReady();
			return undefined;
		}
		const from = modelKey(ctx?.model);
		const failedProvider = modelProvider(ctx?.model);
		const candidate = findNextFailoverCandidate({
			route: state.route,
			cursor: state.cursor,
			currentModel: ctx?.model,
			excludedProviders: new Set([...state.excludedProviders, failedProvider]),
			modelRegistry: ctx?.modelRegistry,
		});
		if (!candidate) {
			const correlationId = state.pendingReady?.correlationId ?? nextCorrelationId();
			const details = recoveryDetails(classification, from, undefined, state.cursor, correlationId);
			appendRecoveryEvent(ctx, "blocked", "route-exhausted", details);
			clearPendingReady();
			if (state.role && state.role !== "main") console.log(visibleRoleJson(state.role, state.tier));
			return { message: sanitizeAssistantError(message, MODEL_FAILOVER_BLOCKED) };
		}

		const to = modelKey(candidate.model);
		let snapshot: SettingsSnapshot;
		try {
			snapshot = captureSettings();
		} catch {
			const details = recoveryDetails(classification, from, to, candidate.index, nextCorrelationId());
			appendRecoveryEvent(ctx, "blocked", "settings-snapshot-failed", details);
			return { message: sanitizeAssistantError(message, MODEL_FAILOVER_BLOCKED) };
		}

		state.pendingOwnSwitch = { from, to };
		let switched = false;
		let settingsRestored = false;
		try {
			switched = await pi.setModel(candidate.model);
		} catch {
			switched = false;
		} finally {
			try {
				restoreSettings(snapshot);
				settingsRestored = true;
			} catch {
				settingsRestored = false;
			}
		}
		state.pendingOwnSwitch = undefined;
		if (!switched || !settingsRestored) {
			const outcome = settingsRestored ? "model-select-failed" : "settings-restore-failed";
			const details = recoveryDetails(classification, from, to, candidate.index, nextCorrelationId());
			appendRecoveryEvent(ctx, "blocked", outcome, details);
			clearPendingReady();
			return classification.statusCode === 429 || classification.kind === "quota"
				? { message: sanitizeAssistantError(message, MODEL_FAILOVER_BLOCKED) }
				: undefined;
		}

		state.cursor = candidate.index;
		state.excludedProviders.add(failedProvider);
		const correlationId = state.pendingReady?.correlationId ?? nextCorrelationId();
		const details = recoveryDetails(classification, from, to, candidate.index, correlationId);
		armPendingReady(details);
		appendRecoveryEvent(ctx, "switched", "retrying", details);
		if (classification.statusCode === 429 || classification.kind === "quota") {
			return { message: sanitizeAssistantError(message, MODEL_FAILOVER_RETRY) };
		}
		if (classification.kind === "connection-closed") {
			return { message: sanitizeAssistantError(message, MODEL_FAILOVER_TRANSPORT_RETRY) };
		}
		return undefined;
	});

	pi.registerCommand?.("failover", {
		description: "Enable, unlock, or inspect same-tier model failover.",
		handler: async (args: string, ctx: any) => {
			const [operation, tier] = args.trim().split(/\s+/, 2);
			if (operation === "status") {
				emitStatus(ctx);
				return;
			}
			if (!tier) {
				setStatus(ctx, "invalid-command", "missing-tier");
				return;
			}
			if (operation === "enable") {
				state.role = process.env.PI_DELEGATION_KIND === "role" ? process.env.PI_FAILOVER_ROLE?.trim() || state.role : "main";
				if (state.explicitLock || state.manualLock || state.enabled) {
					setStatus(ctx, "enable-rejected", state.explicitLock ? "explicit-lock" : state.manualLock ? "manual-lock" : "already-enabled");
					return;
				}
				try {
					const route = loadTierRoute(routingPath(), tier);
					if (!armRoute(route, tier)) setStatus(ctx, "enable-rejected", "current-model-not-in-tier");
				} catch {
					setStatus(ctx, "enable-rejected", "invalid-tier");
				}
				return;
			}
			if (operation === "unlock") {
				if (state.explicitLock || !state.manualLock) {
					setStatus(ctx, "unlock-rejected", state.explicitLock ? "explicit-lock" : "no-manual-failover-lock");
					return;
				}
				try {
					const route = loadTierRoute(routingPath(), tier);
					state.manualLock = false;
					if (!armRoute(route, tier)) {
						state.manualLock = true;
						setStatus(ctx, "unlock-rejected", "current-model-not-in-tier");
					} else {
						appendLockIntent(false, "unlock");
					}
				} catch {
					setStatus(ctx, "unlock-rejected", "invalid-tier");
				}
				return;
			}
			setStatus(ctx, "invalid-command", "unknown-operation");
		},
	});
}
