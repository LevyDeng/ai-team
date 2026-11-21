(() => {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const labels = { code: '复制代码', table: '复制表格', block: '复制此区域' };
  const allowedTags = ['div', 'p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'input'];
  const allowedAttributes = ['href', 'title', 'start', 'align', 'type', 'checked', 'disabled', 'data-relay-copy', 'data-relay-path', 'data-relay-raw', 'data-relay-literal'];

  function copyButton(kind, text, handlers, regionName) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'markdown-copy quiet';
    button.textContent = labels[kind] || labels.block;
    button.title = kind === 'code' ? '复制当前代码框内的代码，不包含代码围栏' : kind === 'table' ? '复制当前表格框内的 Markdown 表格' : '复制当前区域边框内的全部内容，保留 Markdown 格式';
    button.setAttribute('aria-label', `${labels[kind] || labels.block}：${regionName}`);
    button.onclick = async (event) => {
      event.preventDefault(); event.stopPropagation();
      button.disabled = true;
      try {
        await handlers.copy(text);
        button.textContent = '已复制';
        const region = button.closest('.markdown-block');
        region?.classList.add('markdown-copied');
        setTimeout(() => { button.textContent = labels[kind] || labels.block; region?.classList.remove('markdown-copied'); }, 1500);
      } catch (error) { handlers.error(error); }
      finally { button.disabled = false; }
    };
    return button;
  }

  function blockToolbar(kind, text, handlers, regionName) {
    const toolbar = document.createElement('div'); toolbar.className = 'markdown-block-toolbar';
    const label = document.createElement('span'); label.className = 'markdown-region-label'; label.textContent = regionName;
    toolbar.append(label, copyButton(kind, text, handlers, regionName));
    return toolbar;
  }

  function isHeading(token) {
    if (token.type === 'heading') return true;
    if (token.type !== 'paragraph') return false;
    const inline = (token.tokens || []).filter((part) => part.type !== 'text' || part.text.trim());
    return inline.length === 1 && inline[0].type === 'strong' && !token.text.includes('\n');
  }

  function groupTokens(tokens) {
    const groups = [];
    let pending = [];
    const flush = () => {
      if (pending.some((token) => token.type !== 'space' && token.type !== 'def')) groups.push({ tokens: pending });
      pending = [];
    };
    for (const token of tokens) {
      if (token.type === 'hr' || token.type === 'blockquote') {
        flush();
        groups.push({ tokens: [token], separator: token.type === 'hr' });
      } else {
        // Blank lines separate Markdown paragraphs, not independent copy regions.
        if (isHeading(token)) flush();
        pending.push(token);
      }
    }
    flush();
    return groups;
  }

  function prepareLinks(fragment, handlers) {
    const localPath = (value) => {
      if(window.relayPaths)return window.relayPaths.local(value,true);
      const text = value.trim();
      if (!text || /[\r\n\0]/.test(text) || /^(?:[a-z][\w+.-]*:|[\\/]{2}|#|~\/)/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return null;
      if (/^[a-z]:[\\/]/i.test(text) || /^(?:\.?\.?[\\/])?[^<>|?*]+[\\/][^<>|?*]+$/.test(text) || /^[\w.-]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$/i.test(text)) return text;
      return null;
    };
    const makeLocal = (element, value) => {
      element.classList.add('project-path-link');
      element.title = `打开本地路径：${value}`;
      element.onclick = (event) => {
        event.preventDefault(); event.stopPropagation();
        Promise.resolve(handlers.openPath(value)).catch(handlers.error);
      };
    };
    for (const link of fragment.querySelectorAll('a')) {
      const href = link.getAttribute('data-relay-path') || link.getAttribute('href') || '';
      const raw = link.getAttribute('data-relay-raw') || (link.textContent === href ? href : '[' + link.textContent + '](' + href + ')');
      const literal=link.hasAttribute('data-relay-literal');link.removeAttribute('data-relay-literal');
      link.removeAttribute('data-relay-path');
      link.removeAttribute('data-relay-raw');
      const local = handlers.openPath && (literal&&window.relayPaths?window.relayPaths.local(href):localPath(href));
      if (local) { link.setAttribute('href', '#'); makeLocal(link, local); continue; }
      let url;
      try { url = new URL(href); } catch {}
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        const fallback = document.createElement('span');fallback.className='unsupported-link';fallback.textContent=raw;fallback.title='暂不支持打开此地址，原文已保留';link.replaceWith(fallback);
        continue;
      }
      link.title ||= url.href;
      link.onclick = (event) => {
        event.preventDefault();
        Promise.resolve(handlers.openLink(url.href)).catch(handlers.error);
      };
    }
    if (handlers.openPath) for (const code of fragment.querySelectorAll('code')) {
      if (code.closest('pre, a')) continue;
      const value = window.relayPaths?window.relayPaths.local(code.textContent):localPath(code.textContent);
      if (!value) continue;
      const link = document.createElement('a'); link.href = '#';
      code.replaceWith(link); link.append(code); makeLocal(link, value);
    }
    if(window.relayPaths){
      const walker=document.createTreeWalker(fragment,NodeFilter.SHOW_TEXT),nodes=[];let node;
      while((node=walker.nextNode()))if(!node.parentElement?.closest('a, .unsupported-link, button'))nodes.push(node);
      for(const node of nodes){
        const text=node.textContent,links=window.relayPaths.links(text,{plain:true}).filter(link=>link.kind==='local'?handlers.openPath:handlers.openLink).slice(0,100);if(!links.length)continue;
        const output=document.createDocumentFragment();let offset=0;
        for(const item of links){output.append(document.createTextNode(text.slice(offset,item.start)));const link=document.createElement('a');link.href='#';link.textContent=text.slice(item.start,item.end);if(item.kind==='local')makeLocal(link,item.value);else{link.title=item.value;link.onclick=event=>{event.preventDefault();Promise.resolve(handlers.openLink(item.value)).catch(handlers.error);};}output.append(link);offset=item.end;}
        output.append(document.createTextNode(text.slice(offset)));node.replaceWith(output);
      }
    }
    for (const input of fragment.querySelectorAll('input')) {
      if (input.type !== 'checkbox') { input.remove(); continue; }
      input.disabled = true;
    }
  }

  function render(container, source, handlers) {
    container.classList.remove('markdown-body');
    try {
      if (!window.marked?.Marked || !window.DOMPurify?.sanitize) throw new Error('Markdown renderer is unavailable.');
      const blocks = new Map();
      const renderer = new window.marked.Renderer();
      const originalLink = renderer.link;
      renderer.link = function (token) {
        const html = originalLink.call(this, token);
        const parsed=window.relayPaths?.links(token.raw).find(link=>link.start===0);
        return html.replace('<a ', `<a data-relay-path="${escapeHtml(parsed?.value||token.href)}" ${parsed?.kind==='local'?'data-relay-literal="1" ':''}data-relay-raw="${escapeHtml(token.raw)}" `);
      };
      const originalCode = renderer.code;
      const originalTable = renderer.table;
      const wrap = (html, token, kind) => {
        const id = String(blocks.size);
        blocks.set(id, { kind, text: kind === 'code' ? token.text : token.raw.trim(), label: kind === 'code' ? `代码${token.lang ? ' · ' + token.lang.split(/\s/)[0] : ''}` : '表格' });
        return `<div data-relay-copy="${id}">${html}</div>`;
      };
      renderer.html = ({ text }) => escapeHtml(text);
      renderer.image = ({ href, text, raw }) => {const parsed=window.relayPaths?.links(raw).find(link=>link.start<=1);return `<a href="${escapeHtml(href)}" data-relay-path="${escapeHtml(parsed?.value||href)}" ${parsed?.kind==='local'?'data-relay-literal="1" ':''}data-relay-raw="${escapeHtml(raw)}">${escapeHtml(text || 'Image')} · <code>${escapeHtml(parsed?.source||href)}</code></a>`;};
      renderer.code = function (token) { return wrap(originalCode.call(this, token), token, 'code'); };
      renderer.table = function (token) { return wrap(originalTable.call(this, token), token, 'table'); };
      const parser = new window.marked.Marked({ gfm: true, breaks: false, renderer });
      // Shield literal path separators from Markdown's backslash/underscore handling.
      if(window.relayPaths)parser.use({extensions:[{name:'relay_path',level:'inline',start:source=>{const match=/(?:^|[^\p{L}\p{N}_.-])(["'“‘]?(?:\/?[a-z]:[\\/]|\.{1,2}[\\/]|[\p{L}\p{N}_.-]+[\\/]))/iu.exec(source);return match?match.index+match[0].length-match[1].length:undefined;},tokenizer(source){
        const line=source.slice(0,8192).split('\n')[0],item=window.relayPaths.links(line,{plain:true})[0];if(!item||item.kind!=='local')return;
        const quoted=item.start===1&&/["'“‘]/.test(line[0]);if(item.start!==0&&!quoted)return;
        return {type:'relay_path',raw:line.slice(0,item.end+(quoted?1:0)),path:item.value};
      },renderer:token=>`<a href="#" data-relay-path="${escapeHtml(token.path)}" data-relay-literal="1">${escapeHtml(token.raw)}</a>`}]});
      const tokens = parser.lexer(source);
      const output = document.createDocumentFragment();
      let regionNumber = 0;
      for (const group of groupTokens(tokens)) {
        const fragment = window.DOMPurify.sanitize(parser.parser(group.tokens), {
          RETURN_DOM_FRAGMENT: true,
          ALLOWED_TAGS: allowedTags,
          ALLOWED_ATTR: allowedAttributes,
          ADD_URI_SAFE_ATTR: ['data-relay-path', 'data-relay-raw'],
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
        });
        prepareLinks(fragment, handlers);
        for (const element of fragment.querySelectorAll('[data-relay-copy]')) {
          const block = blocks.get(element.getAttribute('data-relay-copy'));
          element.removeAttribute('data-relay-copy');
          if (!block) continue;
          element.className = `markdown-block markdown-${block.kind}`;
          const toolbar = blockToolbar(block.kind, block.text, handlers, block.label);
          element.prepend(toolbar);
          if (block.kind === 'table') {
            const table = element.querySelector('table');
            if (table) {
              const scroll = document.createElement('div'); scroll.className = 'markdown-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('aria-label', '表格，可横向滚动');
              table.replaceWith(scroll); scroll.append(table);
            }
          }
        }
        const visible = group.tokens.filter((token) => token.type !== 'space' && token.type !== 'def');
        if (group.separator || (visible.length === 1 && ['code', 'table'].includes(visible[0].type))) output.append(fragment);
        else {
          const section = document.createElement('div'); section.className = 'markdown-block markdown-section';
          const name = `区域 ${++regionNumber}`;
          section.setAttribute('role', 'group'); section.setAttribute('aria-label', name);
          const text = group.tokens.map((token) => token.raw || '').join('').trim();
          section.append(blockToolbar('block', text, handlers, name), fragment); output.append(section);
        }
      }
      container.replaceChildren(output);
      container.classList.add('markdown-body');
      return true;
    } catch {
      // Keep the original message readable if parsing or dependency loading fails.
      container.textContent = source;
      return false;
    }
  }

  window.relayMarkdown = Object.freeze({ render });
})();
