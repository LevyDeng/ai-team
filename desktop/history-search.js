(() => {
  const limit = 2000;
  const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote';

  function searchableText(body) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement.closest('button, .markdown-block-toolbar, [hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '', previous = null;
    const segments = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const block = node.parentElement.closest(blockSelector) || body;
      if (segments.length && (previous !== block || node.previousSibling?.nodeName === 'BR')) text += '\n';
      segments.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
      previous = block;
    }
    return { text, segments };
  }

  function create(container) {
    let results = [], index = -1, clipped = false, lastQuery = '';
    const clear = () => { CSS.highlights.delete('relay-search'); CSS.highlights.delete('relay-search-current'); };
    const highlightCurrent = () => {
      CSS.highlights.delete('relay-search-current');
      if (index >= 0 && results[index]) CSS.highlights.set('relay-search-current', new Highlight(results[index].range));
    };
    const snapshot = () => ({ index, count: results.length, clipped });
    function refresh(query) {
      const previous = query === lastQuery ? results[index] : null;
      lastQuery = query;
      results = []; index = -1; clipped = false; clear();
      if (!query.trim()) return snapshot();
      // Match literal text using original UTF-16 offsets, including across inline markup.
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      outer: for (const body of container.querySelectorAll('.history-message-body')) {
        const { text, segments } = searchableText(body);
        let match, segmentIndex = 0;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text))) {
          if (results.length === limit) { clipped = true; break outer; }
          const start = match.index, end = start + match[0].length;
          while (segmentIndex < segments.length && segments[segmentIndex].end <= start) segmentIndex++;
          let endIndex = segmentIndex;
          while (endIndex < segments.length && segments[endIndex].end < end) endIndex++;
          const first = segments[segmentIndex], last = segments[endIndex];
          if (!first || !last || start < first.start) continue;
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          results.push({ body, start, end, range });
        }
      }
      if (results.length) {
        index = results.findIndex((item) => previous && item.body === previous.body && item.start === previous.start && item.end === previous.end);
        if (index < 0) index = 0;
        CSS.highlights.set('relay-search', new Highlight(...results.map((item) => item.range)));
        highlightCurrent();
      }
      return snapshot();
    }
    function reveal() {
      const result = results[index];
      if (!result?.body.isConnected) return;
      // Scroll nested code/table viewports as well as the outer message list.
      let element = result.range.startContainer.parentElement;
      while (element && element !== container) {
        if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
          const rect = result.range.getBoundingClientRect(), box = element.getBoundingClientRect();
          if (rect.top < box.top || rect.bottom > box.bottom) element.scrollTop += rect.top - box.top - element.clientHeight / 2;
          if (rect.left < box.left || rect.right > box.right) element.scrollLeft += rect.left - box.left - element.clientWidth / 2;
        }
        element = element.parentElement;
      }
      const rect = result.range.getBoundingClientRect(), box = container.getBoundingClientRect();
      container.scrollTop += rect.top - box.top - Math.max(0, (container.clientHeight - rect.height) / 2);
    }
    return {
      refresh, reveal, snapshot,
      move(delta) {
        if (results.length) { index = (index + delta + results.length) % results.length; highlightCurrent(); reveal(); }
        return snapshot();
      },
      reset() { results = []; index = -1; clipped = false; lastQuery = ''; clear(); },
    };
  }
  window.relayHistorySearch = Object.freeze({ create });
})();
