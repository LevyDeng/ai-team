const limit = (value, size) => String(value || '').slice(-size);
function terminal(state, text) { state.terminal = limit((state.terminal || '') + text, 128 * 1024); }
function thinking(state, id, text, append = false, complete = false) {
  state.thinkingParts ||= {};
  state.thinkingParts[id] = limit((append ? state.thinkingParts[id] || '' : '') + text, 32 * 1024);
  state.thinking = limit(Object.values(state.thinkingParts).join('\n\n'), 64 * 1024);
  if (complete && !state.thinkingLogged?.[id]) {
    state.thinkingLogged ||= {}; state.thinkingLogged[id] = true;
    terminal(state, '\r\n[Reasoning summary]\r\n' + state.thinkingParts[id] + '\r\n');
  }
}
function activity(state, id, title, status, paths) {
  state.activities ||= [];
  const item = state.activities.find(item => item.id === id);
  const details = { title, status };
  const files = paths?.filter(value => typeof value === 'string' && value.length <= 4096).slice(0, 32);
  if (files?.length) details.paths = files;
  if (item) Object.assign(item, details); else state.activities.push({ id, ...details });
  state.activities = state.activities.slice(-80);
}
function textContent(content) {
  if (typeof content === 'string') return limit(content, 32000);
  return (Array.isArray(content) ? content : []).filter(item => item.type === 'text').map(item => item.text || '').join('\n').slice(-32000);
}
function parseActivity(engine, event, state) {
  let changed = false;
  if (engine === 'codex' && ['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
    const item = event.item || {}, id = item.id || item.type || 'item';
    if (item.type === 'reasoning') {
      const text = item.text || item.summary?.map(part => part.text || '').join('\n');
      if (text) { thinking(state, id, text, false, event.type === 'item.completed'); changed = true; }
    } else if (item.type === 'command_execution') {
      state.outputs ||= {}; state.commands ||= {};
      if (!state.commands[id]) { terminal(state, '\r\n$ ' + (item.command || 'Command') + '\r\n'); state.commands[id] = true; }
      const output = item.aggregated_output || '';
      const previous = state.outputs[id] || '';
      if (output !== previous) terminal(state, output.startsWith(previous) ? output.slice(previous.length) : output);
      state.outputs[id] = limit(output, 64000);
      activity(state, id, item.command || 'Command', event.type === 'item.completed' ? (item.exit_code ? 'failed' : 'complete') : 'running');
      if (event.type === 'item.completed') terminal(state, '\r\n[Exit ' + (item.exit_code ?? item.status ?? 'complete') + ']\r\n');
      changed = true;
    } else if (['mcp_tool_call', 'file_change', 'web_search'].includes(item.type)) {
      const paths = item.type === 'file_change' ? (item.changes || []).map(change => change.path) : undefined;
      const title = item.type === 'mcp_tool_call' ? [item.server, item.tool].filter(Boolean).join(' / ') : paths ? 'Files: ' + paths.join(', ') : 'Search: ' + (item.query || '');
      activity(state, id, title, event.type === 'item.completed' ? (item.status === 'failed' || item.error ? 'failed' : 'complete') : 'running', paths);
      terminal(state, '\r\n[' + title + ']\r\n' + textContent(item.result?.content) + '\r\n'); changed = true;
    }
  }
  if (engine === 'claude') {
    const stream = event.type === 'stream_event' ? event.event : null;
    if (stream?.type === 'message_start') state.claudeMessage = stream.message?.id || 'stream';
    if (stream?.delta?.type === 'thinking_delta') { thinking(state, (state.claudeMessage || 'stream') + ':' + (stream.index || 0), stream.delta.thinking || '', true); changed = true; }
    if (stream?.type === 'content_block_stop') {
      const id = (state.claudeMessage || 'stream') + ':' + (stream.index || 0);
      if (state.thinkingParts?.[id]) { thinking(state, id, state.thinkingParts[id], false, true); changed = true; }
    }
    if (event.type === 'assistant') {
      for (const [index, block] of (event.message?.content || []).entries()) {
        if (block.type === 'thinking' && block.thinking) { thinking(state, (event.message.id || 'stream') + ':' + index, block.thinking, false, true); changed = true; }
        if (block.type === 'tool_use') {
          const detail = block.input?.command || block.input?.file_path || block.input?.path || '';
          activity(state, block.id, block.name, 'running', [block.input?.file_path, block.input?.path]); terminal(state, '\r\n[' + block.name + '] ' + limit(detail, 4000) + '\r\n'); changed = true;
        }
      }
    }
    if (event.type === 'user') for (const block of event.message?.content || []) if (block.type === 'tool_result') {
      const item = state.activities?.find(item => item.id === block.tool_use_id);
      if (item) item.status = block.is_error ? 'failed' : 'complete';
      terminal(state, textContent(block.content) + '\r\n'); changed = true;
    }
    if (event.type === 'system' && typeof event.model === 'string') { state.actualModel = event.model; changed = true; }
  }
  if (engine === 'opencode' && event.part?.type === 'reasoning' && event.part.text) { thinking(state, event.part.id || 'reasoning', event.part.text); changed = true; }
  return changed;
}
module.exports = { parseActivity, terminal };
