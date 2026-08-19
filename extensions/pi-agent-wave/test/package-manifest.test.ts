import { describe, expect, test } from "./test-api.mjs";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("package manifest", () => {
	test("declares the approved package identity and public artifact surface", () => {
		expect(basename(ROOT)).toBe("pi-agent-wave");
		expect(manifest).toMatchObject({
			name: "@dpugliese/pi-agent-wave",
			version: "0.1.0",
			type: "module",
			license: "MIT",
			keywords: expect.arrayContaining(["pi-package"]),
			publishConfig: { access: "public" },
		});
		expect(typeof manifest.description).toBe("string");
		expect(manifest.description.trim()).not.toBe("");
		expect(manifest.files).toEqual(["*.ts", "lib", "scripts", "README.md", "LICENSE"]);
		expect(manifest.pi?.extensions).toEqual(["index.ts", "questionnaire.ts", "cmux-session.ts", "model-failover.ts"]);
	});

	test("declares the migrate, init, and doctor bins", () => {
		expect(manifest.bin).toEqual({
			"pi-agent-wave-migrate": "scripts/migrate.mjs",
			"pi-agent-wave-init": "scripts/init.mjs",
			"pi-agent-wave-doctor": "scripts/doctor.mjs",
		});
	});

	test("declares Pi runtime packages as unbundled peers", () => {
		expect(manifest.peerDependencies).toEqual({
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		});
		expect(manifest.bundledDependencies).toBeUndefined();
		expect(manifest.dependencies).toBeUndefined();
	});

	test("does not invent deferred public URLs", () => {
		for (const field of ["repository", "homepage", "bugs"]) expect(manifest[field]).toBeUndefined();
	});
});
