#!/usr/bin/env node
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readJsonc } from "../lib/jsonc.mjs";
import { resolveModel } from "../lib/model-routing.mjs";

export { resolveModel };

const isMain = basename(process.argv[1] ?? "") === "resolve-model.mjs";

if (isMain) {
	const [key = "tools", mode = ""] = process.argv.slice(2);
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	const path = process.env.PI_MODEL_ROUTING?.trim() || join(agentDir, "model-routing.jsonc");
	const resolved = resolveModel(readJsonc(path), key, mode);
	if (resolved.warning) console.error(resolved.warning);
	switch (mode) {
		case "--list": console.log(resolved.models.join(",")); break;
		case "--thinking": console.log(resolved.thinking); break;
		case "--session": console.log(resolved.session ? "true" : "false"); break;
		case "": console.log(resolved.primary); break;
		default:
			console.error(`resolve-model.mjs: unsupported mode '${mode}'`);
			process.exitCode = 2;
	}
}
