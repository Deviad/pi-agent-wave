import {
  applyClaudeCodeTransforms, buildBillingHeaderValue, computeBetas,
  type ClaudeCodeParams,
} from '@cgaravitoq/claude-code-core';

import { claudeAgentDir, readClaudeHeaders } from './claude-auth-config.ts';

export function buildClaudeRequestMetadata(model: string, env: NodeJS.ProcessEnv = process.env) {
  const version = env.ANTHROPIC_CLI_VERSION ?? readClaudeHeaders(claudeAgentDir(env)).claudeCodeVersion;
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT ?? 'sdk-cli';
  return {
    version, entrypoint,
    headers: {
      accept: 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': computeBetas(model).join(','),
      'user-agent': env.ANTHROPIC_USER_AGENT ?? `claude-cli/${version} (external, ${entrypoint})`,
      'x-app': 'cli',
    },
  };
}

export function transformClaudeRequest<T extends ClaudeCodeParams>(
  params: T, metadata: ReturnType<typeof buildClaudeRequestMetadata>,
) {
  // Compute before the upstream transform can move system text into messages.
  const billing = buildBillingHeaderValue(params.messages ?? [], metadata.version, metadata.entrypoint);
  const transformed = applyClaudeCodeTransforms(params);
  if (Array.isArray(transformed.system)) {
    for (const block of transformed.system) {
      if (block.text?.startsWith('x-anthropic-billing-header:')) block.text = billing;
    }
  }
  return transformed;
}
