((root)=>{
  function messageText(message){
    const files=Array.isArray(message.attachments)?message.attachments:[];
    if(!files.length)return message.text||'';
    const references=files.map(file=>({name:file.name,path:file.path,kind:file.kind,sizeBytes:file.sizeBytes,...(file.width?{width:file.width,height:file.height}: {})}));
    return [message.text||'','Local file references (paths only; not uploaded). Use available filesystem or location tools to read these files:',JSON.stringify(references)].filter(Boolean).join('\n\n');
  }
  const api={messageText};if(typeof module==='object'&&module.exports)module.exports=api;else root.deskAttachments=api;
})(typeof globalThis!=='undefined'?globalThis:this);
