import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { acpxPermissionPolicy } from "../lib/acpx-permissions.ts";

describe("ACPX tool policy inside AgentFS", () => {
	test("denies writes for read-only graph nodes", () => {
		assert.deepEqual(acpxPermissionPolicy(true), {
			autoApprove: ["read", "search", "execute"],
			autoDeny: ["edit", "delete", "move"],
			defaultAction: "deny",
		});
	});

	test("allows known write classes only when AgentFS owns filesystem isolation", () => {
		const policy = acpxPermissionPolicy(false);
		assert.deepEqual(policy.autoApprove, ["read", "search", "edit", "delete", "move", "execute"]);
		assert.deepEqual(policy.autoDeny, []);
		assert.equal(policy.defaultAction, "deny");
		assert.equal(Object.isFrozen(policy), true);
	});
});
