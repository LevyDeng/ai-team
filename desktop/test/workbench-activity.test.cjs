const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEvent } = require('../workbench/agents.cjs');
const { terminal } = require('../workbench/activity.cjs');
const emit = ()=>{};
test('Codex exposes only supplied summaries and captures command output deltas once', () => {
  const state = {text:''};
  parseEvent('codex',{type:'item.completed',item:{id:'r',type:'reasoning',text:'Inspect the build first.',encrypted_content:'NEVER_DISPLAY'}},state,emit);
  for (const [type,output] of [['item.started',''],['item.updated','first\n'],['item.completed','first\nsecond\n']]) parseEvent('codex',{type,item:{id:'cmd',type:'command_execution',command:'fixture-command',aggregated_output:output,exit_code:0}},state,emit);
  assert.equal(state.thinking,'Inspect the build first.');
  assert.equal(state.terminal.match(/first\n/g).length,1); assert(state.terminal.includes('second'));
  assert(!JSON.stringify(state).includes('NEVER_DISPLAY'));
  assert.deepEqual(state.activities,[{id:'cmd',title:'fixture-command',status:'complete'}]);
});
test('Claude reasoning streams and final blocks merge, tool outputs exclude binary images', () => {
  const state = {text:''};
  parseEvent('claude',{type:'system',model:'fixture-claude'},state,emit);
  parseEvent('claude',{type:'stream_event',event:{type:'message_start',message:{id:'m'}}},state,emit);
  parseEvent('claude',{type:'stream_event',event:{index:0,delta:{type:'thinking_delta',thinking:'Checking the file.'}}},state,emit);
  parseEvent('claude',{type:'stream_event',event:{type:'content_block_stop',index:0}},state,emit);
  parseEvent('claude',{type:'assistant',message:{id:'m',content:[{type:'thinking',thinking:'Checking the file.'},{type:'tool_use',id:'tool',name:'Read',input:{file_path:'/tmp/fixture'}}]}},state,emit);
  parseEvent('claude',{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:[{type:'text',text:'File content'},{type:'image',source:{data:'BINARY_NOT_LOGGED'}}]}]}},state,emit);
  assert.equal(state.thinking,'Checking the file.'); assert.equal(state.terminal.match(/Checking the file/g).length,1);
  assert.equal(state.activities[0].status,'complete'); assert.equal(state.actualModel,'fixture-claude');
  assert(state.terminal.includes('File content')); assert(!JSON.stringify(state).includes('BINARY_NOT_LOGGED'));
});
test('MCP text results and tool failures are visible; output buffers stay bounded', () => {
  const state = {text:''};
  parseEvent('codex',{type:'item.completed',item:{id:'mcp',type:'mcp_tool_call',server:'fixture',tool:'probe',status:'failed',result:{content:[{type:'text',text:'Tool failed'}]}}},state,emit);
  assert.equal(state.activities[0].status,'failed'); assert(state.terminal.includes('Tool failed'));
  terminal(state,'x'.repeat(200000)); assert.equal(state.terminal.length,128*1024);
});
