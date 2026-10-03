import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (_pi: ExtensionAPI) {
  _pi.registerProvider("claude-code", { apiKey: "synthetic-test-token" });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    const capture = process.env.PI_CLAUDE_TEST_CAPTURE;
    if (!capture) throw new Error('Missing test capture path');
    const hasResult = body.messages.some((message: { content?: unknown }) =>
      JSON.stringify(message.content).includes('PI_WAVE_TOOL_OK') &&
      JSON.stringify(message.content).includes('tool_result'));
    const tools = (body.tools ?? []).map((tool: {name: string}) => tool.name);
    appendFileSync(capture, JSON.stringify({tools, hasResult, promptPresent: JSON.stringify(body).includes('TRANSCRIPT_PROMPT_SENTINEL')}) + '\n');
    const callTool = !hasResult && tools.includes('mcp_Bash');
    const events = [
      { type: 'message_start', message: {id:'test',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}} },
      { type: 'content_block_start', index:0, content_block:callTool ? {type:'tool_use',id:'tool_test',name:'mcp_Bash',input:{}} : {type:'text',text:''} },
      { type: 'content_block_delta', index:0, delta:callTool ? {type:'input_json_delta',partial_json:JSON.stringify({command:'printf PI_WAVE_TOOL_OK'})} : {type:'text_delta',text:hasResult ? 'done' : 'no tools'} },
      { type: 'content_block_stop', index:0 },
      { type: 'message_delta', delta:{stop_reason:callTool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1} },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  };
}
