import type { AcpAgent } from "./acpx-types.ts";

/** Selects the frozen ACP agent from the model provider without dispatch-time re-resolution. */
export function selectAcpAgent(selectedModel: string): AcpAgent {
	if (selectedModel.startsWith("openai-codex/")) return "codex";
	if (selectedModel.startsWith("claude-code/")) return "claude";
	return "pi";
}

/** Formats the frozen model for the selected ACPX adapter. */
export function acpxModelArgument(selectedModel: string, agent: AcpAgent): string {
	if (agent === "codex" && selectedModel.startsWith("openai-codex/")) return selectedModel.slice("openai-codex/".length);
	if (agent === "claude" && selectedModel.startsWith("claude-code/")) return selectedModel.slice("claude-code/".length);
	return selectedModel;
}
