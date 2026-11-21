const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root={relayPaths:require('../path-links.js')};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../terminal-ui.js'),'utf8'),{window:root});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const listeners={},copies=[],pastes=[];let selection='selected text';const term={attachCustomKeyEventHandler:fn=>term.key=fn,hasSelection:()=>Boolean(selection),getSelection:()=>selection,paste:text=>pastes.push(text)};const element={addEventListener:(name,fn)=>listeners[name]=fn};return {term,element,listeners,copies,pastes,select:text=>selection=text};}
const key=(overrides={})=>({type:'keydown',key:'c',code:'KeyC',ctrlKey:true,preventDefault(){},stopPropagation(){},...overrides});
test('Selected Ctrl+C and right-click copy plain text; unselected Ctrl+C remains an interactive interrupt',async()=>{
  const f=fixture();root.relayTerminalUI.installCopy(f.term,f.element,{copy:text=>f.copies.push(text),readClipboard:async()=> 'pasted'});assert.equal(f.term.key(key()),false);await tick();assert.equal(f.copies[0],'selected text');
  f.listeners.mousedown({button:2,preventDefault(){},stopPropagation(){}});f.select('changed after right button');f.listeners.contextmenu({preventDefault(){},stopPropagation(){}});await tick();assert.equal(f.copies[1],'selected text');
  f.select('');assert.equal(f.term.key(key()),true);assert.equal(f.term.key(key({shiftKey:true})),false);assert.equal(f.term.key(key({key:'v',code:'KeyV',shiftKey:true})),false);await tick();assert.equal(f.pastes[0],'pasted');
});
test('Read-only output allows selection copying without ever forwarding Ctrl+C',async()=>{
  const f=fixture();root.relayTerminalUI.installCopy(f.term,f.element,{copy:text=>f.copies.push(text),readOnly:true});assert.equal(f.term.key(key()),false);await tick();f.select('');assert.equal(f.term.key(key()),false);assert.equal(f.copies.length,1);
});
test('A soft-wrapped terminal Markdown link is mapped across buffer rows and opens the normalized local file',async()=>{
  const source='[Open acceptance](/X:/games/archive/evidence/index.html)',cols=20,rows=[];for(let n=0;n<source.length;n+=cols){const text=source.slice(n,n+cols);rows.push({isWrapped:n>0,getCell:i=>({getWidth:()=>1,getChars:()=>text[i]||''})});}
  let provider,opened;const term={cols,buffer:{active:{length:rows.length,getLine:i=>rows[i]}},registerLinkProvider:p=>{provider=p;return {dispose(){}};}};root.relayTerminalUI.installLinks(term,{openPath:value=>{opened=value;},openLink:()=>assert.fail(),error:error=>assert.fail(error)});
  let result;provider.provideLinks(2,links=>result=links);assert.equal(result.length,1);assert.equal(result[0].range.start.y,1);assert(result[0].range.end.y>1);result[0].activate({preventDefault(){}});await tick();assert.equal(opened,'X:/games/archive/evidence/index.html');
});
