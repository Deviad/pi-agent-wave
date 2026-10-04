import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readJsonc } from "./jsonc.mjs";

export const HOST_SERVICES_FILENAME = "host-services.jsonc";
export const HOST_SERVICE_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_ENV = new Set(["HOME", "PATH", "TMPDIR"]);
const PLACEHOLDERS = new Set(["{port}", "{stateDir}"]);

/** Resolve the registry path: PI_HOST_SERVICES, then <agentDir>/host-services.jsonc. */
export function resolveHostServicesPath(agentDir) {
	return process.env.PI_HOST_SERVICES?.trim() || join(agentDir, HOST_SERVICES_FILENAME);
}

function refuse(where, message) {
	throw new Error(`host services: ${where}: ${message}`);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `{…}` token must be a known placeholder, so a typo cannot reach a host command unexpanded. */
function template(where, value) {
	if (typeof value !== "string") refuse(where, "must be a string");
	for (const token of value.match(/\{[^}]*\}/g) ?? []) {
		if (!PLACEHOLDERS.has(token)) refuse(where, `unknown placeholder ${token}; only {port} and {stateDir} are expanded`);
	}
	return value;
}

function parseService(name, raw) {
	const where = `service ${name}`;
	if (!NAME.test(name)) refuse(where, "name must match ^[a-z][a-z0-9-]{0,31}$");
	if (!isRecord(raw)) refuse(where, "must be an object");
	if (typeof raw.description !== "string" || !raw.description.trim()) refuse(`${where}.description`, "is required");
	if (!isRecord(raw.start) || Object.keys(raw.start).length === 0) refuse(`${where}.start`, "must map at least one platform to a command");
	const start = {};
	for (const [platform, command] of Object.entries(raw.start)) {
		const at = `${where}.start.${platform}`;
		if (!HOST_SERVICE_PLATFORMS.includes(platform)) refuse(at, `platform must be one of ${HOST_SERVICE_PLATFORMS.join(", ")}`);
		if (!isRecord(command)) refuse(at, "must be an object with executable and args");
		if (typeof command.executable !== "string" || !isAbsolute(command.executable)) refuse(`${at}.executable`, "must be an absolute path");
		if (!Array.isArray(command.args)) refuse(`${at}.args`, "must be an array of strings");
		start[platform] = { executable: command.executable, args: command.args.map((arg, index) => template(`${at}.args[${index}]`, arg)) };
	}
	const env = {};
	if (raw.env !== undefined) {
		if (!isRecord(raw.env)) refuse(`${where}.env`, "must map variable names to templates");
		for (const [variable, value] of Object.entries(raw.env)) {
			const at = `${where}.env.${variable}`;
			if (!ENV_NAME.test(variable)) refuse(at, "name must match ^[A-Z][A-Z0-9_]*$");
			if (variable.startsWith("PI_") || RESERVED_ENV.has(variable)) refuse(at, "is reserved for the worker's own environment");
			env[variable] = template(at, value);
		}
	}
	const timeout = raw.readyTimeoutSeconds ?? 30;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) refuse(`${where}.readyTimeoutSeconds`, "must be an integer from 1 to 120");
	return { name, description: raw.description.trim(), start, env, readyTimeoutSeconds: timeout };
}

/** Validates a parsed registry document; throws naming the service and field at the first problem. */
export function parseHostServices(document) {
	if (!isRecord(document) || !isRecord(document.services)) refuse("registry", "must be an object with a services map");
	return Object.entries(document.services).map(([name, raw]) => parseService(name, raw));
}

/** Reads the registry at `path`; an absent file means no services. */
export function loadHostServices(path) {
	if (!existsSync(path)) return [];
	return parseHostServices(readJsonc(path));
}

/**
 * Resolves the names a dispatch attaches to their command for `platform`. Throws on an unknown or repeated name,
 * or a service with no entry for the platform.
 */
export function attachHostServices(services, names, platform = process.platform) {
	const seen = new Set();
	return names.map((name) => {
		if (seen.has(name)) refuse(`service ${name}`, "is attached twice");
		seen.add(name);
		const service = services.find((candidate) => candidate.name === name);
		if (!service) refuse(`service ${name}`, `is not registered${services.length ? ` (registered: ${services.map((entry) => entry.name).join(", ")})` : ""}`);
		const command = service.start[platform];
		if (!command) refuse(`service ${name}`, `has no start entry for ${platform}`);
		return { name, description: service.description, executable: command.executable, args: command.args, env: service.env, readyTimeoutSeconds: service.readyTimeoutSeconds };
	});
}
