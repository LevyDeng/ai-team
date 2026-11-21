((root)=>{
  function text(term){let output='';const buffer=term.buffer.active;for(let row=0;row<buffer.length;row++){const line=buffer.getLine(row);if(!line)continue;let end=term.cols-1;while(end>=0&&!line.getCell(end)?.getChars()&&line.getCell(end)?.getWidth()!==0)end--;let value='';for(let col=0;col<=end;col++){const cell=line.getCell(col);if(cell?.getWidth()!==0)value+=cell?.getChars()||' ';}output+=(row&&!line.isWrapped?'\n':'')+value;}return output.trimEnd();}
  function installLinks(term,{openPath,openLink,error}){
    return term.registerLinkProvider({provideLinks(y,callback){
      const buffer=term.buffer.active;let first=y-1,last=y-1;
      for(let count=0;count<24&&first>0&&buffer.getLine(first)?.isWrapped;count++)first--;
      for(let count=0;count<24&&buffer.getLine(last+1)?.isWrapped;count++)last++;
      let text='';const cells=[];
      for(let row=first;row<=last;row++){const line=buffer.getLine(row);if(!line)continue;let end=term.cols-1;while(end>=0&&!line.getCell(end)?.getChars()&&line.getCell(end)?.getWidth()!==0)end--;
        for(let col=0;col<=end;col++){const cell=line.getCell(col),width=cell?.getWidth();if(width===0)continue;const chars=cell?.getChars()||' ';for(let n=0;n<chars.length;n++)cells.push({x:col+1,y:row+1,end:col+Math.max(1,width||1)});text+=chars;}
      }
      if(text.length>16384){callback([]);return;}
      callback(root.relayPaths.links(text).flatMap(link=>{const start=cells[link.start],end=cells[link.end-1];if(!start||!end||y<start.y||y>end.y)return [];return [{text:link.value,range:{start:{x:start.x,y:start.y},end:{x:end.end,y:end.y}},activate:event=>{event.preventDefault();Promise.resolve().then(()=>link.kind==='local'?openPath(link.value):openLink(link.value)).catch(error);}}];}));
    }});
  }
  function installCopy(term,element,{copy,readClipboard,readOnly=false,error=()=>{}}){
    const perform=value=>Promise.resolve().then(()=>copy(value)).catch(error);let captured='';
    term.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown'||!event.ctrlKey||event.altKey||event.metaKey)return true;
      const key=event.key?.toLowerCase()||(event.code==='KeyC'?'c':event.code==='KeyV'?'v':'');
      if(key==='c'&&(event.shiftKey||term.hasSelection()||readOnly)){event.preventDefault();event.stopPropagation();const text=term.getSelection();if(text)perform(text);return false;}
      if(key==='v'&&event.shiftKey&&!readOnly&&readClipboard){event.preventDefault();event.stopPropagation();Promise.resolve().then(readClipboard).then(text=>term.paste(text)).catch(error);return false;}
      return true;
    });
    element.addEventListener('mousedown',event=>{captured='';if(event.button===2&&term.hasSelection()){captured=term.getSelection();event.preventDefault();event.stopPropagation();}},true);
    element.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();const text=captured||term.getSelection();captured='';if(text)perform(text);else if(!readOnly&&readClipboard)Promise.resolve().then(readClipboard).then(text=>term.paste(text)).catch(error);});
  }
  root.relayTerminalUI={installLinks,installCopy,text};
})(window);
