#!/usr/bin/env -S node --experimental-strip-types
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditAgentFsChanges, exportOwnedAgentFsChanges } from "../lib/agentfs-sandbox.ts";

export interface ExportConfig {
	schemaVersion: 1;
	agentFsExecutable: string;
	dbPath: string;
	baseDir: string;
	ownedPaths: string[];
	ignoredPaths: string[];
	discardAllChanges: boolean;
	resultPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(value: unknown): ExportConfig {
	if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid AgentFS export config schema");
	for (const key of ["agentFsExecutable", "dbPath", "baseDir", "resultPath"] as const) {
		if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`AgentFS export config requires ${key}`);
	}
	if (!Array.isArray(value.ownedPaths) || !value.ownedPaths.every((path) => typeof path === "string" && path.trim())) throw new Error("AgentFS export config requires ownedPaths");
	if (!Array.isArray(value.ignoredPaths) || !value.ignoredPaths.every((path) => typeof path === "string" && path.trim())) throw new Error("AgentFS export config requires ignoredPaths");
	if (typeof value.discardAllChanges !== "boolean") throw new Error("AgentFS export config requires discardAllChanges");
	return {
		schemaVersion: 1,
		agentFsExecutable: String(value.agentFsExecutable),
		dbPath: resolve(String(value.dbPath)),
		baseDir: resolve(String(value.baseDir)),
		ownedPaths: value.ownedPaths.map(String),
		ignoredPaths: value.ignoredPaths.map(String),
		discardAllChanges: value.discardAllChanges,
		resultPath: resolve(String(value.resultPath)),
	};
}

export function runExport(config: ExportConfig): number {
	const audit = auditAgentFsChanges(config.dbPath, config.baseDir, config.ownedPaths, config.ignoredPaths);
	const effective = config.discardAllChanges
		? { changes: audit.changes, owned: [], ignored: audit.changes, violations: [] }
		: audit;
	const result = {
		schemaVersion: 1,
		changes: effective.changes,
		owned: effective.owned,
		ignored: effective.ignored,
		violations: effective.violations,
		discardedReadOnlyChanges: config.discardAllChanges ? audit.changes.length : 0,
		exported: false,
	};
	if (!effective.violations.length) {
		if (!config.discardAllChanges) exportOwnedAgentFsChanges(config.agentFsExecutable, config.dbPath, config.baseDir, audit);
		result.exported = true;
	}
	writeFileSync(config.resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
	chmodSync(config.resultPath, 0o600);
	return result.exported ? 0 : 2;
}

function main(): void {
	const configPath = process.env.PI_AGENTFS_EXPORT_CONFIG;
	if (!configPath) throw new Error("PI_AGENTFS_EXPORT_CONFIG is required");
	const parsed: unknown = JSON.parse(readFileSync(resolve(configPath), "utf8"));
	process.exitCode = runExport(parseConfig(parsed));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); }
	catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
