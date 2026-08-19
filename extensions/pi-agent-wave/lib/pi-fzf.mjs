import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FZF_COMMANDS = Object.freeze(["route", "delegate-model"]);
export const FZF_FIELDS = Object.freeze(["list", "preview"]);

/** The installed package root (one level above lib/). */
export function packageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The package-relative route picker the generated fzf commands must target. */
export function packageRoutePicker() {
	return join(packageRoot(), "route-picker.ts");
}

/** POSIX shell-quote a path so generated command strings survive fzf's shell. */
export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The exact command definitions for the route and delegate-model commands. */
export function fzfCommandTargets(routePickerPath = packageRoutePicker()) {
	const picker = shellQuote(routePickerPath);
	const action = { type: "send", template: "/route {{selected}}" };
	return {
		route: {
			list: `node --experimental-strip-types ${picker} --list`,
			preview: `node --experimental-strip-types ${picker} --preview '{{selected}}'`,
			action,
		},
		"delegate-model": {
			list: `node --experimental-strip-types ${picker} --list`,
			preview: `node --experimental-strip-types ${picker} --preview '{{selected}}'`,
			action,
		},
	};
}

/**
 * Read-only detection of an installed pi-fzf via settings.json's packages
 * array. Returns installed:false rather than guessing when the marker is
 * absent or unreadable.
 */
export function detectPiFzf(agentDir) {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) return { installed: false, reason: "settings.json absent", settingsPath };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		return { installed: false, reason: "settings.json is not valid JSON", settingsPath };
	}
	const packages = parsed?.packages;
	if (!Array.isArray(packages)) return { installed: false, reason: "settings.json packages array absent", settingsPath };
	const match = packages.find((entry) => {
		const id = typeof entry === "string" ? entry : entry?.source;
		return typeof id === "string" && (id === "pi-fzf" || id === "npm:pi-fzf" || id.endsWith("/pi-fzf"));
	});
	return { installed: Boolean(match), reason: match ? undefined : "pi-fzf package not registered", settingsPath, packageEntry: match };
}

/**
 * Merge route/delegate-model list/preview/action definitions into a parsed
 * fzf.json, leaving every unrelated command and field value unchanged. Returns
 * the new bytes, whether anything changed, and any pre-existing list/preview
 * values that would be overwritten (collisions).
 */
export function mergeFzf(parsed, routePickerPath = packageRoutePicker()) {
	const targets = fzfCommandTargets(routePickerPath);
	const output = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? JSON.parse(JSON.stringify(parsed)) : {};
	if (!output.commands || typeof output.commands !== "object" || Array.isArray(output.commands)) output.commands = {};
	const collisions = [];
	const changes = [];
	for (const commandName of FZF_COMMANDS) {
		const existing = output.commands[commandName];
		const command = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
		output.commands[commandName] = command;
		for (const field of FZF_FIELDS) {
			const target = targets[commandName][field];
			const current = command[field];
			if (current === target) continue;
			if (typeof current === "string" && current.length > 0) collisions.push({ command: commandName, field, existing: current });
			command[field] = target;
			changes.push({ command: commandName, field });
		}
		const targetAction = targets[commandName].action;
		if (JSON.stringify(command.action ?? null) !== JSON.stringify(targetAction)) {
			if (command.action !== undefined) collisions.push({ command: commandName, field: "action", existing: command.action });
			command.action = targetAction;
			changes.push({ command: commandName, field: "action" });
		}
	}
	const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
	return { parsed: output, bytes, changed: changes.length > 0, collisions, changes };
}
