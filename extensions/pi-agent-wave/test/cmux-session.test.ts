import { afterEach, describe, expect, test } from "./test-api.mjs";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cmuxSessionExtension from "../cmux-session.ts";

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];

afterEach(async () => {
	process.env = { ...originalEnv };
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-wave-cmux-"));
	temporaryRoots.push(root);
	const output = join(root, "hooks.jsonl");
	const executable = join(root, "cmux-fixture.mjs");
	await writeFile(executable, '#!/usr/bin/env node\nimport fs from "node:fs";\nconst input=fs.readFileSync(0,"utf8");\nfs.appendFileSync(process.env.CMUX_TEST_OUTPUT, JSON.stringify({argv:process.argv.slice(2),input,launchKind:process.env.CMUX_AGENT_LAUNCH_KIND})+"\\n");\n');
	await chmod(executable, 0o755);
	process.env.CMUX_SURFACE_ID = "surface:42";
	process.env.CMUX_PI_CMUX_BIN = executable;
	process.env.CMUX_TEST_OUTPUT = output;
	const handlers = new Map<string, Function>();
	cmuxSessionExtension({ on(name: string, handler: Function) { handlers.set(name, handler); } } as never);
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "session-123" } };
	return { root, output, handlers, ctx };
}

describe("cmux session companion", () => {
	test("forwards session, prompt, and stop metadata when cmux is present", async () => {
		const h = await harness();
		await h.handlers.get("session_start")?.({}, h.ctx);
		await h.handlers.get("before_agent_start")?.({ prompt: "do work" }, h.ctx);
		await h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }, h.ctx);
		const calls = (await readFile(h.output, "utf8")).trim().split("\n").map(JSON.parse);
		expect(calls.map((call: any) => call.argv)).toEqual([
			["hooks", "pi", "session-start"],
			["hooks", "pi", "prompt-submit"],
			["hooks", "pi", "stop"],
		]);
		expect(calls.map((call: any) => JSON.parse(call.input).event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
		expect(JSON.parse(calls[1].input)).toMatchObject({ session_id: "session-123", prompt: "do work" });
		expect(JSON.parse(calls[2].input).last_assistant_message).toBe("done");
		expect(calls.every((call: any) => call.launchKind === "pi")).toBe(true);
	});

	test("is a no-op when cmux metadata is absent or hooks are disabled", async () => {
		const h = await harness();
		delete process.env.CMUX_SURFACE_ID;
		await h.handlers.get("session_start")?.({}, h.ctx);
		process.env.CMUX_SURFACE_ID = "surface:42";
		process.env.CMUX_PI_HOOKS_DISABLED = "1";
		await h.handlers.get("session_start")?.({}, h.ctx);
		expect(existsSync(h.output)).toBe(false);
	});
});
