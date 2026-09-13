import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { streamClaudeCodeAnthropic } from '../lib/claude-auth-stream.ts';
import type { Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerClaudeAuth from '../claude-code-auth.ts';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateClaudeHeaders, readClaudeHeaders, claudeHeadersPath } from '../lib/claude-auth-config.ts';
import { buildClaudeRequestMetadata, transformClaudeRequest } from '../lib/claude-auth-headers.ts';

const model: Model<'anthropic-messages'> = {
  id: 'claude-opus-5', name: 'Claude', api: 'anthropic-messages', provider: 'claude-code',
  baseUrl: 'https://api.anthropic.com', reasoning: true, input: ['text'],
  contextWindow: 1000000, maxTokens: 128000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

test('provider registration exposes the header command without invoking credentials or network', () => {
  const providers = new Map<string, Parameters<ExtensionAPI['registerProvider']>[1]>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  registerClaudeAuth({
    registerProvider: (name, definition) => { providers.set(name, definition); },
    registerCommand: (name, definition) => { commands.set(name, definition); },
  });
  assert.deepEqual([...providers.keys()], ['claude-code']);
  assert.deepEqual([...commands.keys()], ['claude-headers']);
  assert.equal(providers.get('claude-code')?.streamSimple, streamClaudeCodeAnthropic);
  assert.ok(providers.get('claude-code')?.models?.some(item => item.id === 'claude-opus-5'));
});

test('real SDK sends updated headers and renders text, thoughts and tool calls from a captured response', async () => {
  const original = globalThis.fetch;
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  // The header under test derives from the environment; a shell inside Claude Code exports CLAUDE_CODE_ENTRYPOINT=cli
  // and would turn the expected sdk-cli entrypoint into cli, so both inputs are pinned for the test's duration.
  const oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const oldUserAgent = process.env.ANTHROPIC_USER_AGENT;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.ANTHROPIC_USER_AGENT;
  const dir = mkdtempSync(join(tmpdir(), 'wave-claude-stream-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  let calls = 0;
  try {
    await updateClaudeHeaders(dir, async () => '2.1.270 (Claude Code)');
    globalThis.fetch = async (input, init) => {
      calls++;
      const request = new Request(input, init);
      assert.equal(request.headers.get('user-agent'), 'claude-cli/2.1.270 (external, sdk-cli)');
      assert.equal(request.headers.get('authorization'), 'Bearer test-token');
      const body = await request.text();
      assert.match(body, /cc_version=2\.1\.270\./);
      const events = [
        { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: model.id, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'mcp_Read', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const stream = streamClaudeCodeAnthropic(model, { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }, { apiKey: 'test-token' });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    assert.equal(result.stopReason, 'toolUse');
    assert.ok(events.includes('thinking_delta'));
    assert.ok(events.includes('text_delta'));
    assert.ok(events.includes('toolcall_end'));
    const tool = result.content.find(block => block.type === 'toolCall');
    assert.equal(tool?.name, 'read');
    assert.deepEqual(tool?.arguments, { path: 'a.ts' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
    if (oldUserAgent === undefined) delete process.env.ANTHROPIC_USER_AGENT; else process.env.ANTHROPIC_USER_AGENT = oldUserAgent;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API refusal text reaches the Pi error event', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Example usage refusal' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    const result = await streamClaudeCodeAnthropic(model, { messages: [] }, { apiKey: 'test-token' }).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /Example usage refusal/);
  } finally { globalThis.fetch = original; }
});

for (const scenario of [
  { reason: 'refusal', details: { type: 'refusal', category: 'cyber', explanation: 'Example server explanation' }, outcome: 'error', diagnostic: /refusal.*cyber.*Example server explanation/ },
  { reason: 'refusal', details: null, outcome: 'error', diagnostic: /refusal.*no explanation/i },
  { reason: 'future_stop_reason', details: null, outcome: 'error', diagnostic: /future_stop_reason/ },
  { reason: 'model_context_window_exceeded', details: null, outcome: 'length', diagnostic: null },
  { reason: 'end_turn', details: null, outcome: 'stop', diagnostic: null },
]) {
  test(`Opus 5 stop reason ${scenario.reason} retains its meaning and server details`, async () => {
    const original = globalThis.fetch;
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'wave-claude-stop-'));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const events = [
        { type: 'message_start', message: { id: 'msg_stop', type: 'message', role: 'assistant', content: [], model: model.id, stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial response' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: scenario.reason, stop_details: scenario.details, stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      globalThis.fetch = async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      const stream = streamClaudeCodeAnthropic(model, { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }, { apiKey: 'test-token' });
      const types = [];
      for await (const event of stream) types.push(event.type);
      const result = await stream.result();
      assert.equal(result.stopReason, scenario.outcome);
      assert.equal(result.usage.input, 42);
      assert.equal(result.usage.output, 2);
      assert.deepEqual(result.content, [{ type: 'text', text: 'Partial response' }]);
      if (scenario.diagnostic) {
        assert.match(result.errorMessage ?? '', scenario.diagnostic);
        assert.equal(types.at(-1), 'error');
        assert.ok(!types.includes('done'));
      } else { assert.equal(types.at(-1), 'done'); }
    } finally {
      globalThis.fetch = original;
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Claude request uses one version for HTTP and billing metadata without changing environment', () => {
  const fingerprint = () => createHash("sha256").update(JSON.stringify({ ...process.env })).digest("hex");
  const before = fingerprint();
  const metadata = buildClaudeRequestMetadata('claude-opus-5', { PI_CODING_AGENT_DIR: join(tmpdir(), 'wave-absent-config') });
  assert.equal(metadata.headers['user-agent'], 'claude-cli/2.1.268 (external, sdk-cli)');
  assert.ok(metadata.headers['anthropic-beta'].includes('oauth-2025-04-20'));
  const request = transformClaudeRequest({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] }, metadata);
  assert.match(JSON.stringify(request), /cc_version=2\.1\.268\./);
  assert.equal(JSON.stringify(request).match(/x-anthropic-billing-header/g)?.length, 1);
  assert.equal(fingerprint(), before);
});

test('header update validates the detected version and persists private JSON without losing a valid config on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wave-claude-headers-'));
  try {
    assert.equal(readClaudeHeaders(dir).claudeCodeVersion, '2.1.268');
    await updateClaudeHeaders(dir, async () => '2.1.269 (Claude Code)\n');
    assert.equal(readClaudeHeaders(dir).claudeCodeVersion, '2.1.269');
    const path = claudeHeadersPath(dir);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path, 'utf8');
    await assert.rejects(updateClaudeHeaders(dir, async () => 'not a version'), /version/);
    assert.equal(readFileSync(path, 'utf8'), before);
    writeFileSync(path, '{}');
    assert.throws(() => readClaudeHeaders(dir), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude metadata preserves explicit upstream overrides', () => {
  const metadata = buildClaudeRequestMetadata('claude-haiku-4-5', {
    ANTHROPIC_CLI_VERSION: '2.1.269', CLAUDE_CODE_ENTRYPOINT: 'custom', ANTHROPIC_USER_AGENT: 'custom-client',
  });
  assert.equal(metadata.headers['user-agent'], 'custom-client');
  const request = transformClaudeRequest({ messages: [{ role: 'user', content: 'hello' }] }, metadata);
  assert.match(JSON.stringify(request), /cc_version=2\.1\.269\..*cc_entrypoint=custom/);
  assert.ok(!metadata.headers['anthropic-beta'].includes('interleaved-thinking'));
});
