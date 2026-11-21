(() => {
const defaults = {
  domains: ['代码', '美术', '前端', '建模', '特效'],
  duties: ['实施', '审核', '探索'],
};

function label(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim().normalize('NFC');
  return name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(name) ? name : '';
}

function key(domain, duty) {
  return JSON.stringify([domain.toLowerCase(), duty.toLowerCase()]);
}

function normalize(value) {
  const error = 'Use unique domain and duty pairs with whole-number ratings from 1 to 10.';
  if (!Array.isArray(value) || value.length > 80) throw new Error(error);
  const seen = new Set();
  return Array.from(value, item => {
    const domain = label(item?.domain), duty = label(item?.duty), score = item?.score;
    if (!domain || !duty || !Number.isInteger(score) || score < 1 || score > 10) throw new Error(error);
    const pair = key(domain, duty);
    if (seen.has(pair)) throw new Error(error);
    seen.add(pair);
    return {domain, duty, score};
  });
}

function catalog(roles) {
  const ratings = roles.flatMap(role => role.workflowRatings || []);
  const distinct = values => [...new Map(values.map(value => [value.toLowerCase(), value])).values()];
  return {
    domains: distinct([...ratings.map(item => item.domain), ...defaults.domains]),
    duties: distinct([...ratings.map(item => item.duty), ...defaults.duties]),
  };
}

function rank(node, roles) {
  const pair = key(node.domain, node.duty);
  return roles.map(role => ({roleId:role.id, score:role.workflowRatings?.find(item => key(item.domain, item.duty) === pair)?.score ?? null}))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

if (typeof module !== 'undefined') module.exports = { label, normalize, catalog, rank };
else window.deskWorkflowRatings = { label, catalog, rank };
})();
