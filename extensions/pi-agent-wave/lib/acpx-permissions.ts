export interface AcpxPermissionPolicy {
	readonly autoApprove: readonly string[];
	readonly autoDeny: readonly string[];
	readonly defaultAction: "deny";
}

const READ_TOOLS = Object.freeze(["read", "search"] as const);
const WRITE_TOOLS = Object.freeze(["edit", "delete", "move", "execute"] as const);

/** Generates tool-class policy; AgentFS provides the preventative filesystem boundary. */
export function acpxPermissionPolicy(readOnly: boolean): AcpxPermissionPolicy {
	return Object.freeze({
		autoApprove: Object.freeze(readOnly ? [...READ_TOOLS, "execute"] : [...READ_TOOLS, ...WRITE_TOOLS]),
		autoDeny: Object.freeze(readOnly ? ["edit", "delete", "move"] : []),
		defaultAction: "deny",
	});
}
