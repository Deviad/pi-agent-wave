import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const CLAUDE_CODE_VERSION = '2.1.268';
const runFile = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+$/;

export function claudeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

export function claudeHeadersPath(agentDir = claudeAgentDir()): string {
  return join(agentDir, 'claude-code-headers.json');
}

export function readClaudeHeaders(agentDir = claudeAgentDir()) {
  const path = claudeHeadersPath(agentDir);
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { schemaVersion: 1, claudeCodeVersion: CLAUDE_CODE_VERSION };
    }
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid Claude header configuration: ${path}`); }
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('claudeCodeVersion' in value) || typeof value.claudeCodeVersion !== 'string'
    || !versionPattern.test(value.claudeCodeVersion)) {
    throw new Error(`Invalid Claude header configuration: ${path}`);
  }
  return { schemaVersion: 1, claudeCodeVersion: value.claudeCodeVersion };
}

async function installedClaudeVersion(): Promise<string> {
  const result = await runFile('claude', ['--version'], { timeout: 10_000, maxBuffer: 4096 });
  return result.stdout;
}

export async function updateClaudeHeaders(agentDir = claudeAgentDir(), detect = installedClaudeVersion) {
  const output = (await detect()).trim();
  const match = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/.exec(output);
  if (!match) throw new Error('Could not parse the installed Claude Code version; header configuration was not changed');
  const config = { schemaVersion: 1, claudeCodeVersion: match[1] };
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const path = claudeHeadersPath(agentDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return config;
}

export function registerClaudeHeadersCommand(pi: Pick<ExtensionAPI, 'registerCommand'>) {
  pi.registerCommand('claude-headers', {
    description: 'Show Claude request version metadata, or update it from the installed Claude Code CLI',
    handler: async (args, ctx) => {
      try {
        const action = args.trim() || 'status';
        if (action !== 'status' && action !== 'update') throw new Error('Usage: /claude-headers [status|update]');
        const config = action === 'update' ? await updateClaudeHeaders() : readClaudeHeaders();
        const effective = process.env.ANTHROPIC_CLI_VERSION ?? config.claudeCodeVersion;
        ctx.ui.notify(`Claude headers: ${effective}; saved version: ${config.claudeCodeVersion}\n${claudeHeadersPath()}${process.env.ANTHROPIC_USER_AGENT ? '\nANTHROPIC_USER_AGENT overrides User-Agent.' : ''}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
