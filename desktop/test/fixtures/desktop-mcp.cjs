const fs=require('node:fs'),readline=require('node:readline');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
  const request=JSON.parse(line);if(request.id===undefined)return;let result={};
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'desktop-fixture',version:'1.0.0'}};
  if(request.method==='tools/list')result={tools:[{name:'desktop_echo',description:'Echo the isolated desktop-tool fixture text.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};
  if(request.method==='tools/call'){if(process.env.FIXTURE_CALL_MARKER)fs.writeFileSync(process.env.FIXTURE_CALL_MARKER,'called');result={content:[{type:'text',text:request.params.arguments.text}]};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
input.on('close',()=>process.exit(0));
