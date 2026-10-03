import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('installed Pi sends provider tools and executes Bash through the real agent loop', t => {
  const version = spawnSync('pi', ['--version'], {encoding:'utf8'});
  if (version.error?.message.includes('ENOENT')) return t.skip('Pi executable unavailable');
  assert.equal(version.status, 0);
  t.diagnostic(`Installed Pi ${version.stdout.trim()}`);
  const root=mkdtempSync(join(tmpdir(),'wave-transcript-'));
  try {
    const agentDir=join(root,'agent');mkdirSync(agentDir);
    writeFileSync(join(agentDir,'auth.json'), JSON.stringify({'claude-code':{type:'oauth',access:'synthetic-test-token',refresh:'synthetic-refresh',expires:Date.now()+3600000}}),{mode:0o600});
    const capture=join(root,'requests.jsonl');
    const result=spawnSync('pi', [
      '--approve','--print','--mode','json','--no-session','--offline','--no-extensions',
      '--no-skills','--no-prompt-templates','--no-context-files',
      '-e',fileURLToPath(new URL('../claude-code-auth.ts',import.meta.url)),
      '-e',fileURLToPath(new URL('./support/claude-transcript-http.ts',import.meta.url)),
      '--provider','claude-code','--model','claude-opus-5','--api-key','synthetic-test-token',
      '--thinking','off','--system-prompt','TRANSCRIPT_PROMPT_SENTINEL','Run the harmless tool check.',
    ], {cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_CLAUDE_TEST_CAPTURE:capture},encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr + result.stdout.slice(0,2500));
    const requests=readFileSync(capture,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(requests[0].tools.includes('mcp_Bash'),'outgoing request must declare Bash');
    assert.ok(requests[0].promptPresent,'system prompt must survive transcript conversion');
    assert.ok(requests.some(request=>request.hasResult),'actual Bash output must be sent back to the provider');
    const events=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(events.some(event=>event.type==='tool_execution_end' && event.toolName==='bash' && JSON.stringify(event.result).includes('PI_WAVE_TOOL_OK')));
  } finally {rmSync(root,{recursive:true,force:true});}
});
