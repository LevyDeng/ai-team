const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { StringDecoder } = require('node:string_decoder');
const { shellQuote } = require('../config.cjs');
async function createTools(project, store, locations, skillContext) {
  const allowed = [...new Set(project.directories.map(d => d.locationId))].map(id => store.get('locations', id)).filter(l => l.type === 'ssh' && l.control === 'ssh');
  if (!allowed.length&&!skillContext?.service?.tools().length&&!skillContext?.history) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const tool = { name: 'ssh_exec', description: 'Run a command on a configured project SSH location. The selected location determines the machine; cwd defaults to its project directory. Available locations: ' + allowed.map(l => l.id + ' (' + l.name + ')').join(', '), inputSchema: { type: 'object', properties: { locationId: { type: 'string', enum: allowed.map(l => l.id) }, command: { type: 'string', description: 'Shell command to execute on the selected machine.' } }, required: ['locationId', 'command'], additionalProperties: false } };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/rpc' || request.headers.origin || request.headers.authorization !== 'Bearer ' + token) { response.writeHead(403); response.end('{}'); return; }
    if(request.method!=='POST'){response.writeHead(405,{Allow:'POST'});response.end('{}');return;}
    let body = ''; let size = 0;
    const decoder = new StringDecoder('utf8');
    try {
      for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new Error('Tool request too large.'); body += decoder.write(chunk); }
      const message = JSON.parse(body + decoder.end()); let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion||'2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'relay-project-locations', version: '1.0.0' } };
      else if (message.method === 'tools/list') result = { tools: [...(allowed.length?[tool]:[]),...(skillContext?.service?.tools()||[]),...(skillContext?.history?[skillContext.history.tool]:[])] };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/call') {
        if(message.params?.name==='chat_history_read'&&skillContext?.history){
          try{result={content:[{type:'text',text:JSON.stringify(skillContext.history.read(message.params.arguments))}]};}
          catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
          response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));return;
        }
        if(['skill_read','skill_run','skill_handoff_targets','skill_handoff_prepare'].includes(message.params?.name)&&skillContext?.service){
          try{const value=await skillContext.service.call(skillContext.scope,message.params.name,message.params.arguments);result={content:[{type:'text',text:JSON.stringify(value)}]};}
          catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
          response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));return;
        }
        if (message.params?.name !== 'ssh_exec') throw new Error('Unknown tool.');
        const args = message.params.arguments; const location = allowed.find(l => l.id === args?.locationId);
        if (!location || typeof args.command !== 'string' || !args.command || args.command.length > 64000 || args.command.includes('\0')) throw new Error('Invalid SSH tool arguments.');
        const cwd = project.directories.find(d => d.locationId === location.id).path;
        let command;
        if (location.os === 'linux') { const dir = cwd.startsWith('~/') ? '"$HOME"/' + shellQuote(cwd.slice(2)) : shellQuote(cwd); command = `cd -- ${dir} && bash -lc ${shellQuote(args.command)}`; }
        else { const script = `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}';\n` + args.command; command = 'powershell.exe -NoProfile -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'); }
        try { const text = await locations.exec(location.id, command, 60000); result = { content: [{ type: 'text', text: text || '(Command completed with no output.)' }] }; }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      } else if (message.method?.startsWith('notifications/')) { response.writeHead(204); response.end(); return; }
      else { response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } })); return; }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { response.writeHead(400); response.end(JSON.stringify({ error: 'Invalid tool request.' })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closed=false;return { url: `http://127.0.0.1:${server.address().port}/rpc`, token, close: () => {if(closed)return;closed=true;server.closeAllConnections(); server.close(); } };
}
async function client() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const message = JSON.parse(line);
      const response = await fetch(process.env.RELAY_TOOLS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RELAY_TOOLS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      if (message.id !== undefined) {
        const reply = response.ok ? await response.json() : { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Project tool bridge is unavailable.' } };
        process.stdout.write(JSON.stringify(reply) + '\n');
      }
    } catch { process.stderr.write('Project tool transport failed.\n'); }
  }
}
if (require.main === module) client();
module.exports = { createTools };
