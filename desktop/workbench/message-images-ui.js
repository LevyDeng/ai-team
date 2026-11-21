((root)=>{
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);entry.target._load?.();}},{root:document.getElementById('messages'),rootMargin:'400px'}):null;
  function render(host,message,{chatId,load,open,copy,layout,error}){
    const key=JSON.stringify([message.status,message.text,message.imagePaths,message.activities]);if(host._imageKey===key)return;
    host._imageKey=key;host.replaceChildren();host.hidden=true;observer?.unobserve(host);
    if(message.status==='running')return;
    host.hidden=false;
    host._load=async()=>{
      if(host._requestedKey===key)return;host._requestedKey=key;
      try{
        const files=await load(chatId,message.id);if(host._imageKey!==key||!host.isConnected)return;
        const follow=layout?.('before');
        host.hidden=!files.length;
        for(const file of files){
          const figure=document.createElement('figure');figure.className='message-image-card';
          const view=document.createElement('button');view.type='button';view.className='message-image-view';view.title='打开原图';
          if(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(file.thumbnail||'')){const img=document.createElement('img');img.src=file.thumbnail;img.alt=file.name;img.width=file.width;img.height=file.height;img.onload=()=>layout?.(follow);view.append(img);}
          else view.textContent='预览不可用，原始路径已保留';
          view.onclick=()=>Promise.resolve(open(file.path)).catch(error);
          const caption=document.createElement('figcaption');const name=document.createElement('span');name.textContent=file.name+(file.width?' · '+file.width+'×'+file.height:'');name.title=file.path;caption.append(name);
          for(const [label,action]of [['打开原图',()=>open(file.path)],['复制路径',()=>copy(file.path)]]){const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.onclick=()=>Promise.resolve(action()).catch(error);caption.append(button);}
          figure.append(view,caption);if(file.warning){const original=document.createElement('code');original.className='message-image-original-path';original.textContent=file.path;figure.append(original);}host.append(figure);
        }
        layout?.(follow);
      }catch(e){if(host._imageKey===key){host.hidden=true;error(e);}}
    };
    if(observer)observer.observe(host);else host._load();
  }
  root.deskMessageImages={render,clear:()=>observer?.disconnect()};
})(window);
