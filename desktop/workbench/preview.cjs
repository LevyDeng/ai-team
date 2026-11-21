/* Layout-only preview with disposable fixture data and no agent/network operations. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {Store}=require('./store.cjs');
const desktop=path.resolve(__dirname,'..');const root=path.resolve(desktop,'..');
const store=new Store(path.join(root,'.runtime/workbench-preview'),path.join(root,'.runtime/workbench-preview'));
require('./fixtures.cjs').seed(store,root);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/preview-state.js'){res.setHeader('Content-Type',types['.js']);res.end('window.previewState='+JSON.stringify({...store.snapshot(),running:{},connectionStatus:{local:'ready'}})+';');return;}
    const url=new URL(req.url,'http://127.0.0.1');const file=path.resolve(desktop,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(desktop+path.sep)||!types[path.extname(file)]){res.writeHead(404);res.end();return;}
    let body=fs.readFileSync(file);res.setHeader('Content-Type',types[path.extname(file)]);
    if(file===path.join(__dirname,'index.html'))body=body.toString().replace("connect-src 'none'","connect-src 'self'").replace('<script src="renderer.js">','<script src="/preview-state.js"></script><script src="preview.js"></script><script src="renderer.js">');
    res.end(body);
  }catch{res.writeHead(404);res.end();}
});
server.listen(43921,'127.0.0.1',()=>console.log('Fixture UI preview: http://127.0.0.1:43921/workbench/index.html'));
