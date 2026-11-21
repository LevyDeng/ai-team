((root)=>{
  function normalize(value,{encoded=false}={}){
    if(typeof value!=='string'||value.length>8192)throw new Error('Invalid local path.');
    let text=value.trim();if(/^file:/i.test(text)){const url=new URL(text);if(url.protocol!=='file:'||url.hostname&&!/^localhost$/i.test(url.hostname))throw new Error('Only local file links can be opened.');text=decodeURIComponent(url.pathname);}
    else if(encoded){try{text=decodeURIComponent(text);}catch{}}
    if(/^<.*>$/.test(text))text=text.slice(1,-1);
    if(!text||/[\0\r\n]/.test(text)||/^[\\/]{2}/.test(text))throw new Error('Invalid local path.');
    if(/^\/[a-z]:[\\/]/i.test(text))text=text.slice(1);
    text=text.replace(/:\d+(?::\d+)?$/,'').replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i,'');
    if(/^[a-z][\w+.-]*:/i.test(text)&&!/^[a-z]:[\\/]/i.test(text))throw new Error('Unsupported local path scheme.');
    return text;
  }
  function local(value,encoded=false){try{const text=normalize(value,{encoded});if(/^[a-z]:[\\/]/i.test(text)||/^(?:\.?\.?[\\/])?[^<>|?*:\r\n]+[\\/][^<>|?*:\r\n]+$/.test(text)||/^[^<>|?*:\\/]+\.[a-z\d]{1,12}$/i.test(text))return text;}catch{}return null;}
  function target(value,{encoded=true}={}){const file=local(value,encoded);if(file)return {kind:'local',value:file};try{const url=new URL(value);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)return {kind:'web',value:url.href};}catch{}return null;}
  function links(text,{plain=false}={}){
    const result=[],occupied=[];const add=(start,end,href,encoded=false,reserve=false)=>{if(occupied.some(r=>start<r.end&&end>r.start))return;const value=target(href,{encoded});if(value||reserve)occupied.push({start,end});if(value)result.push({start,end,...value,source:href});};
    const markdown=/\[[^\]\r\n]{1,500}\]\(/g;let match;
    if(!plain)while((match=markdown.exec(text))){const start=markdown.lastIndex;let end=start,href='';if(text[start]==='<'){end=text.indexOf('>',start+1);if(end<0)continue;href=text.slice(start+1,end);end++;while(text[end]===' ')end++;if(text[end]!==')')continue;}
      else{let depth=1;for(;end<text.length&&end-start<8192;end++){const ch=text[end];if(/[\r\n]/.test(ch))break;if(ch==='(')depth++;if(ch===')'&&!--depth)break;}if(text[end]!==')')continue;href=text.slice(start,end).replace(/\s+"[^"]*"\s*$/,'');}add(match.index,end+1,href,true,true);markdown.lastIndex=end+1;}
    const code=/`([^`\r\n]+)`/g;if(!plain)while((match=code.exec(text)))add(match.index,code.lastIndex,match[1],false,true);
    const uris=/[a-z][\w+.-]{0,31}:\/\/[^\s<>"'`]+/gi;while((match=uris.exec(text))){const href=trim(match[0]);add(match.index,match.index+href.length,href,false,true);}
    const quoted=/"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’/g;while((match=quoted.exec(text)))add(match.index+1,quoted.lastIndex-1,match[1]||match[2]||match[3]||match[4]);
    const spacedDrive=/\/?[a-z]:[\\/][^\r\n<>"'`，。；！？]{0,2048}?\.[a-z][a-z\d]{0,11}(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?(?=[\s,;.!?\)\]}，。；！？：]|$)/gi;
    while((match=spacedDrive.exec(text)))add(match.index,spacedDrive.lastIndex,match[0]);
    const bare=/(?:file:\/\/\/|https?:\/\/|\/?[a-z]:[\\/])[^\s<>"'`]+/gi;
    function trim(value){let href=value.replace(/[.,;!?，。；！？：”’]+$/,'');for(const [open,close]of [['(',')'],['[',']'],['{','}']])while(href.endsWith(close)&&href.split(close).length>href.split(open).length)href=href.slice(0,-1);return href;}
    while((match=bare.exec(text))){const href=trim(match[0]);add(match.index,match.index+href.length,href,false,true);}
    const relative=/(?:^|(?<=[\s([{，：]))(?:\.{1,2}[\\/]|~[\\/])?[\p{L}\p{N}_@~#$%+().-]+(?:[\\/][\p{L}\p{N}_@~#$%+().-]+)+[\\/]?(?::\d+(?::\d+)?)?/gu;
    while((match=relative.exec(text))){const href=trim(match[0]);add(match.index,match.index+href.length,href);}
    const dotted=/(?:^|(?<=[\s([{，：]))\.{1,2}[\\/][\p{L}\p{N}_@~#$%+().-]+[\\/]?/gu;
    while((match=dotted.exec(text))){const href=trim(match[0]);add(match.index,match.index+href.length,href);}
    const filename=/(?:^|(?<=[\s([{，：]))[\p{L}\p{N}_.-]+\.(?:md|markdown|txt|html?|jsonl?|ya?ml|toml|ini|cfg|conf|log|csv|tsv|xlsx?|docx?|pptx?|pdf|png|jpe?g|gif|webp|bmp|svg|ico|mp4|webm|mov|mkv|mp3|wav|ogg|flac|zip|7z|gz|exe|dll|bat|cmd|ps1|py|[cm]?js|tsx?|jsx|css|scss|vue|rs|go|cpp|hpp?|cs|java|sql|sqlite|blend|fbx|glb|gltf|obj|uasset|uproject)(?::\d+(?::\d+)?)?(?=[\s,;.!?\)\]}，。；！？：]|$)/giu;
    while((match=filename.exec(text)))add(match.index,filename.lastIndex,match[0]);
    return result.sort((a,b)=>a.start-b.start);
  }
  const api={normalize,local,target,links};if(typeof module==='object'&&module.exports)module.exports=api;else root.relayPaths=api;
})(typeof window==='undefined'?globalThis:window);
