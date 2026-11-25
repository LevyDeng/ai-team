((root)=>{
  const viewer = document.getElementById('message-image-dialog');
  const image = document.getElementById('message-image-full');
  const viewport = document.getElementById('message-image-scroll');
  const status = document.getElementById('message-image-status');
  const size = document.getElementById('message-image-size');
  const originalButton = document.getElementById('message-image-open');
  const imageData = /^data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;
  let previewRequest = 0;

  function toggleSize(actual) {
    viewport.classList.toggle('actual-size', actual);
    viewport.scrollTop = viewport.scrollLeft = 0;
    size.textContent = actual ? '适应窗口' : '原尺寸';
    size.setAttribute('aria-pressed', String(actual));
  }
  document.getElementById('message-image-close').onclick = () => viewer.close();
  size.onclick = () => toggleSize(!viewport.classList.contains('actual-size'));
  viewer.addEventListener('close', () => {
    if (viewer.open) return;
    previewRequest++;
    image.removeAttribute('src');
    originalButton.onclick = null;
  });

  async function showPreview(file, { load, open }) {
    const reference = file.reference || file.path;
    if (!imageData.test(file.thumbnail || '')) return open(reference);
    const request = ++previewRequest;
    const current = () => viewer.open && request === previewRequest;
    const name = file.name || reference;
    document.getElementById('message-image-title').textContent = name;
    image.alt = name;
    image.src = file.thumbnail;
    status.textContent = '正在加载原图…';
    originalButton.disabled = true;
    if (!viewer.open) viewer.showModal();
    toggleSize(false);

    let original;
    try {
      original = await load(file.sourcePath || reference);
      if (!current()) return;
      if (imageData.test(original?.dataUrl || '')) {
        const decoded = new Image();
        decoded.src = original.dataUrl;
        await decoded.decode();
        if (!current()) return;
        image.src = original.dataUrl;
        status.textContent = decoded.naturalWidth + ' × ' + decoded.naturalHeight;
      } else {
        const reasons = { path:'原图路径已不可用。', size:'原图超过应用内预览限制。', format:'应用无法解码原图。' };
        status.textContent = (reasons[original?.unavailable] || '无法读取原图。') + '当前显示已加载的缩略图。';
      }
    } catch {
      if (!current()) return;
      status.textContent = '无法读取原图。当前显示已加载的缩略图。';
    }
    if (!current()) return;
    originalButton.disabled = original?.unavailable === 'path';
    originalButton.onclick = async () => {
      const note = status.textContent;
      originalButton.disabled = true;
      try { await open(original?.path || reference); }
      catch {
        if (current()) status.textContent = note + ' 系统无法打开原图，请检查路径和文件关联。';
      } finally {
        if (current()) originalButton.disabled = false;
      }
    };
  }

  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);entry.target._load?.();}},{root:document.getElementById('messages'),rootMargin:'400px'}):null;
  function render(host,message,{chatId,load,preview,open,copy,layout,error}){
    if(message.status==='running'){
      if(host._imageKey){observer?.unobserve(host);host._imageKey=host._requestedKey=undefined;host.replaceChildren();}
      host.hidden=true;
      return;
    }
    const key=JSON.stringify([message.status,message.text,message.imagePaths,message.activityCount]);if(host._imageKey===key)return;
    host._imageKey=key;host.replaceChildren();host.hidden=true;observer?.unobserve(host);
    host.hidden=false;
    host._load=async()=>{
      if(host._requestedKey===key)return;host._requestedKey=key;
      try{
        const files=await load(chatId,message.id);if(host._imageKey!==key||!host.isConnected)return;
        const follow=layout?.('before');
        host.hidden=!files.length;
        for(const file of files){
          const figure=document.createElement('figure');figure.className='message-image-card';
          const view=document.createElement('button');view.type='button';view.className='message-image-view';
          const hasPreview = imageData.test(file.thumbnail || '');
          view.title = hasPreview ? '放大查看' : '打开原图';
          if(hasPreview){const img=document.createElement('img');img.src=file.thumbnail;img.alt=file.name;img.width=file.width;img.height=file.height;img.onload=()=>layout?.(follow);view.append(img);}
          else view.textContent='预览不可用，原始路径已保留';
          view.onclick=()=>Promise.resolve(hasPreview ? preview(file) : open(file.reference||file.path)).catch(error);
          const caption=document.createElement('figcaption');const name=document.createElement('span');name.textContent=file.name+(file.width?' · '+file.width+'×'+file.height:'');name.title=file.path;caption.append(name);
          for(const [label,action]of [['打开原图',()=>open(file.reference||file.path)],['复制路径',()=>copy(file.path)]]){const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.onclick=()=>Promise.resolve(action()).catch(error);caption.append(button);}
          figure.append(view,caption);if(file.warning){const original=document.createElement('code');original.className='message-image-original-path';original.textContent=file.path;figure.append(original);}host.append(figure);
        }
        layout?.(follow);
      }catch(e){if(host._imageKey===key){host.hidden=true;error(e);}}
    };
    if(observer)observer.observe(host);else host._load();
  }
  root.deskMessageImages={render,showPreview,clear:()=>observer?.disconnect(),remove:host=>{if(host)observer?.unobserve(host);}};
})(window);
