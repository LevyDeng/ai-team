const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { atomic } = require('./profiles.cjs');
const MAX_BODY = 32 * 1024 * 1024;
function argumentsObject(text) {
  try { return JSON.parse(text || '{}'); } catch { return { input: text }; }
}
function flattenTools(tools, namespace) {
  return (tools || []).flatMap(tool => {
    if (tool.type === 'namespace') return flattenTools(tool.tools, namespace ? namespace + '.' + tool.name : tool.name);
    const originalName = tool.name;
    let name = namespace ? namespace.replace(/[^A-Za-z0-9_]/g, '_') + '__' + originalName : originalName;
    if (name && name.length > 64) name = name.slice(0, 40) + '_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
    return [{ ...tool, name, originalName, namespace }];
  });
}
function content(parts) {
  if (typeof parts === 'string') return parts;
  return (parts || []).map(part => {
    if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url } };
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text || '' };
    throw new Error(`Unsupported Gemini input: ${part.type}. Use text or images.`);
  });
}
function translate(request, cache) {
  if (request.previous_response_id) throw new Error('Gemini bridge needs full input history, not previous_response_id.');
  const messages = [];
  if (request.instructions) messages.push({ role: 'system', content: request.instructions });
  const input = typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : (request.input || []);
  for (const item of input) {
    if (item.type === 'reasoning') continue;
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const definition = flattenTools(request.tools).find(tool => tool.originalName === item.name && (!item.namespace || tool.namespace === item.namespace));
      const tool = cache.get(item.call_id) || { id: item.call_id, type: 'function', function: { name: definition?.name || item.name,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(tool);
      else messages.push({ role: 'assistant', content: null, tool_calls: [tool] });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output || '' });
    } else if (item.role) {
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: content(item.content) });
    } else throw new Error(`Unsupported Gemini history item: ${item.type}`);
  }
  const tools = flattenTools(request.tools).map(tool => {
    if (tool.type === 'function') return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object', properties: {} } } };
    if (tool.type === 'custom') return { type: 'function', function: { name: tool.name,
      description: (tool.description || '') + '\nPut the complete tool input in the input string.',
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } };
    throw new Error(`Unsupported hosted tool: ${tool.type}. Gemini supports local function tools only.`);
  });
  const body = { model: request.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) body.tools = tools;
  if (typeof request.tool_choice === 'string') body.tool_choice = request.tool_choice;
  if (request.max_output_tokens) body.max_tokens = request.max_output_tokens;
  return body;
}
async function* sse(body) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > MAX_BODY) throw new Error('Upstream stream record too large.');
  }
  if (buffer.trim() && buffer.startsWith('data:')) { const data = buffer.slice(5).trim(); if (data !== '[DONE]') yield JSON.parse(data); }
}
function safeError(error, secret) {
  return String(error?.message || 'Request failed.').split(secret || '\0').join('[redacted]').slice(0, 1000);
}
async function startBridge({ settings, apiKey, cacheFile, upstreamFetch = fetch, onRequest }) {
  const token = crypto.randomBytes(32).toString('hex');
  const cache = new Map();
  if (cacheFile && fs.existsSync(cacheFile)) {
    for (const [id, tool] of JSON.parse(fs.readFileSync(cacheFile, 'utf8'))) cache.set(id, tool);
  }
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST' || !['/v1/responses', '/responses'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('Request exceeds 32 MiB.'); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (onRequest) onRequest(request);
      const chat = settings.mode === 'chat';
      const body = chat ? translate(request, cache) : request;
      const target = settings.baseUrl.replace(/\/+$/, '') + (chat ? '/chat/completions' : '/responses');
      const upstream = await upstreamFetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (!upstream.ok) {
        // Provider error payloads can echo prompts or credentials; expose only status.
        await upstream.body?.cancel();
        throw new Error(`${settings.label} returned HTTP ${upstream.status}. Check API key, model access, endpoint, balance, and provider status.`);
      }
      if (!chat) {
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end(); return;
      }
      const id = 'resp_' + crypto.randomUUID().replaceAll('-', '');
      let sequence = 0, text = '', messageIndex = -1, outputIndex = 0, finish = '', usage = {};
      const tools = new Map(), output = [];
      const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: request.model, status: 'in_progress', output: [] };
      if (request.stream) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const emit = (type, data) => { if (request.stream) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`); };
      emit('response.created', { response }); emit('response.in_progress', { response });
      for await (const chunk of sse(upstream.body)) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0]; if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.refusal) throw new Error('Gemini refused this request.');
        if (delta.content) {
          if (messageIndex < 0) {
            messageIndex = outputIndex++;
            output[messageIndex] = { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
            emit('response.output_item.added', { output_index: messageIndex, item: output[messageIndex] });
            emit('response.content_part.added', { item_id: output[messageIndex].id, output_index: messageIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          }
          text += delta.content;
          emit('response.output_text.delta', { item_id: output[messageIndex].id, output_index: messageIndex, content_index: 0, delta: delta.content });
        }
        for (const part of delta.tool_calls || []) {
          let entry = tools.get(part.index);
          if (!entry) {
            entry = { index: outputIndex++, call: { id: part.id, type: 'function', function: { name: part.function?.name || '', arguments: '' } }, started: false };
            tools.set(part.index, entry);
          }
          if (part.id) entry.call.id = part.id;
          if (part.function?.name) entry.call.function.name = part.function.name;
          for (const [key, value] of Object.entries(part)) if (!['id', 'index', 'type', 'function'].includes(key)) entry.call[key] = value;
          entry.call.function.arguments += part.function?.arguments || '';
        }
      }
      if (!finish) throw new Error('Gemini stream ended before a finish reason. Retry this turn.');
      if (!['stop', 'tool_calls', 'function_call', 'length'].includes(finish)) throw new Error('Gemini stopped without a usable completion. Check the provider response or try a different prompt.');
      if (messageIndex >= 0) {
        const message = output[messageIndex]; message.content = [{ type: 'output_text', text, annotations: [] }]; message.status = 'completed';
        emit('response.output_text.done', { item_id: message.id, output_index: messageIndex, content_index: 0, text });
        emit('response.content_part.done', { item_id: message.id, output_index: messageIndex, content_index: 0, part: message.content[0] });
        emit('response.output_item.done', { output_index: messageIndex, item: message });
      }
      for (const entry of tools.values()) {
        const call = entry.call;
        if (!call.id || !call.function.name) throw new Error('Gemini returned an incomplete tool call.');
        cache.set(call.id, call);
        const definition = flattenTools(request.tools).find(tool => tool.name === call.function.name);
        if (!definition) throw new Error('Gemini selected an unknown tool.');
        const custom = definition.type === 'custom';
        const item = { id: 'fc_' + crypto.randomUUID(), type: custom ? 'custom_tool_call' : 'function_call', call_id: call.id, name: definition.originalName, status: 'completed', ...(definition.namespace ? { namespace: definition.namespace } : {}) };
        if (custom) {
          const args = argumentsObject(call.function.arguments);
          if (typeof args.input !== 'string') throw new Error('Custom tool call is missing its input string.');
          item.input = args.input;
        } else { JSON.parse(call.function.arguments || '{}'); item.arguments = call.function.arguments || '{}'; }
        output[entry.index] = item;
        emit('response.output_item.added', { output_index: entry.index, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } });
        emit(custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { item_id: item.id, output_index: entry.index, delta: custom ? item.input : item.arguments });
        emit(custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { item_id: item.id, output_index: entry.index, ...(custom ? { input: item.input } : { arguments: item.arguments }) });
        emit('response.output_item.done', { output_index: entry.index, item });
      }
      while (cache.size > 1024) cache.delete(cache.keys().next().value);
      if (cacheFile) atomic(cacheFile, JSON.stringify([...cache]));
      const completed = { ...response, output: output.filter(Boolean), status: finish === 'length' ? 'incomplete' : 'completed', usage: {
        input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0,
      }, ...(finish === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
      if (request.stream) emit(finish === 'length' ? 'response.incomplete' : 'response.completed', { response: completed });
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(JSON.stringify(completed)); }
      res.end();
    } catch (error) {
      const message = safeError(error, apiKey);
      if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'api_bridge_error', message })}\n\n`);
      else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'api_bridge_error' } })); }
    } finally { clearTimeout(deadline); controllers.delete(controller); }
  });
  server.requestTimeout = 600000;
  // Avoid the low Windows dynamic ports that browser-compatible fetch blocks.
  let listening = false;
  for (let attempt = 0; attempt < 20 && !listening; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready);
        server.listen(crypto.randomInt(20000, 65000), '127.0.0.1');
      });
      listening = true;
    } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code) || attempt === 19) throw error; }
  }
  return { url: `http://127.0.0.1:${server.address().port}/v1`, token,
    close: () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); server.close(); } };
}
module.exports = { startBridge, translate, sse, content };
