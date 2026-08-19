import { describe, expect, test } from "./harness.ts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { herdrTabLabel, panelModelLabel } from "../herdr.ts";
import { selectModelFallback } from "../retry.ts";
import { delegationEnvironment } from "../scripts/panel.ts";

const chain = ["provider/primary", "provider/fallback"];

describe("visible transport model fallback", () => {
	test("advances only within the frozen chain after transient launch failure", () => {
		expect(selectModelFallback(chain, 0, "provider unavailable: HTTP 429")).toEqual({
			kind: "transient",
			reason: "http-429",
			advance: true,
			attempt: 1,
			model: "provider/fallback",
			fallbackReason: "http-429",
		});
	});

	test("permanent semantic failures never change models", () => {
		expect(selectModelFallback(chain, 0, "invalid credentials").advance).toBe(false);
		expect(selectModelFallback(chain, 0, "reviewer requested changes", { semanticVerdict: true })).toEqual({
			kind: "permanent",
			reason: "semantic-verdict",
			advance: false,
			attempt: 0,
			model: "provider/primary",
			fallbackReason: null,
		});
	});

	test("exact locks stay on the sole model even for transient failures", () => {
		expect(selectModelFallback(["provider/exact"], 0, "rate limited", { exactLock: true })).toEqual({
			kind: "transient",
			reason: "rate-limit",
			advance: false,
			attempt: 0,
			model: "provider/exact",
			fallbackReason: null,
		});
	});

	test("Herdr and panel labels expose the same policy and model identity", () => {
		expect(herdrTabLabel("Story", "Reviewer", 1, "provider/model-x", "Strong")).toBe(
			"Story: Reviewer [Strong] @ model-x",
		);
		expect(panelModelLabel("Story", "Reviewer", "provider/model-x", "Strong")).toBe(
			"Story: Reviewer [Strong] @ model-x",
		);
	});

	test("panel workers receive automatic failover state from the frozen route", () => {
		const environment = delegationEnvironment({
			chain: "provider-a/model-1,provider-a/model-2,provider-b/model-3",
			tier: "coding",
			role: "Reviewer",
			model: "provider-a/model-1",
			policy: "tier:coding",
			"policy-digest": "digest",
		}, new Set());
		expect(environment.PI_DELEGATION_KIND).toBe("role");
		expect(environment.PI_FAILOVER_ROUTE).toBe("provider-a/model-1,provider-a/model-2,provider-b/model-3");
		expect(environment.PI_FAILOVER_TIER).toBe("coding");
		expect(environment.PI_FAILOVER_ROLE).toBe("Reviewer");
		expect(environment.PI_FAILOVER_LOCKED).toBe("0");
		const exact = delegationEnvironment({ model: "provider/exact", role: "Reviewer" }, new Set(["exact-lock"]));
		expect(exact.PI_FAILOVER_ROUTE).toBe("provider/exact");
		expect(exact.PI_FAILOVER_LOCKED).toBe("1");
	});

	test("Herdr tab creation carries the same automatic failover environment", () => {
		const script = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));
		const probe = [
			"import json, runpy, sys",
			"module = runpy.run_path(sys.argv[1])",
			"route = {'chain':['provider-a/model-1','provider-a/model-2','provider-b/model-3'],'exact':False,'policy':'tier:coding','policy_digest':'digest','tier':'coding'}",
			"env = module['delegation_environment'](route, 'Reviewer', 'Story: Reviewer', 'provider-a/model-1')",
			"argv = module['tab_create_argv']('workspace', '/tmp/work', 'Story: Reviewer', env)",
			"print(json.dumps({'env':env,'argv':argv}, sort_keys=True))",
		].join("; ");
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8" });
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.env.PI_DELEGATION_KIND).toBe("role");
		expect(output.env.PI_FAILOVER_ROUTE).toBe("provider-a/model-1,provider-a/model-2,provider-b/model-3");
		expect(output.env.PI_FAILOVER_TIER).toBe("coding");
		expect(output.env.PI_FAILOVER_ROLE).toBe("Reviewer");
		expect(output.env.PI_FAILOVER_LOCKED).toBe("0");
		expect(output.argv).toContain("PI_FAILOVER_ROUTE=provider-a/model-1,provider-a/model-2,provider-b/model-3");
	});

	test("transport sources retain policy identity and unified Herdr selection", () => {
		const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
		const panel = readFileSync(`${scripts}/panel.ts`, "utf8");
		const delegate = readFileSync(`${scripts}/delegate.ts`, "utf8");
		for (const name of [
			"PI_DELEGATION_POLICY",
			"PI_DELEGATION_POLICY_DIGEST",
			"PI_DELEGATION_ROLE",
			"PI_DELEGATION_MODEL",
			"PI_DELEGATION_MARKER",
			"PI_FAILOVER_ROUTE",
			"PI_FAILOVER_TIER",
			"PI_FAILOVER_ROLE",
			"PI_FAILOVER_LOCKED",
		]) expect(panel).toContain(name);
		expect(delegate).toContain("HERDR_WORKSPACE_ID");
		expect(delegate).toContain("HERDR_TAB_ID");
		expect(delegate).toContain("return \"herdr\"");
	});
});
