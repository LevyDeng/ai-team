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

function catalog(rules) {
  const distinct = values => [...new Map(values.map(value => [value.toLowerCase(), value])).values()];
  return {
    domains: distinct([...rules.map(item => item.domain), ...defaults.domains]),
    duties: distinct([...rules.map(item => item.duty), ...defaults.duties]),
  };
}

function normalizeRule(value) {
  const domain = label(value?.domain), duty = label(value?.duty);
  if (!domain || !duty) throw new Error('请输入场景和职责，各限 40 个字符。');
  if (!Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 100) {
    throw new Error('请添加 1 至 100 位候选角色。');
  }
  const seen = new Set();
  const candidates = Array.from(value.candidates, item => {
    const { roleId, tier, weight } = item || {};
    if (typeof roleId !== 'string' || !roleId || seen.has(roleId)) throw new Error('同一条规则中，每位角色只能出现一次。');
    if (![tier, weight].every(number => Number.isInteger(number) && number >= 1 && number <= 100)) {
      throw new Error('档位和权重都须为 1 至 100 的整数。');
    }
    seen.add(roleId);
    return { roleId, tier, weight };
  }).sort((a, b) => a.tier - b.tier);
  return { domain, duty, candidates };
}

function migrate(roles, newId) {
  const pairs = new Map();
  for (const role of roles) {
    for (const rating of role.workflowRatings || []) {
      const pair = key(rating.domain, rating.duty);
      if (!pairs.has(pair)) pairs.set(pair, { id: newId(), domain: rating.domain, duty: rating.duty, candidates: [] });
      pairs.get(pair).candidates.push({ roleId: role.id, score: rating.score });
    }
  }
  return [...pairs.values()].map(rule => {
    const scores = [...new Set(rule.candidates.map(candidate => candidate.score))].sort((a, b) => b - a);
    rule.candidates = rule.candidates.map(({ roleId, score }) => ({ roleId, tier: scores.indexOf(score) + 1, weight: 1 }))
      .sort((a, b) => a.tier - b.tier);
    return rule;
  });
}

function findRule(rules, node) {
  const pair = key(label(node.domain), label(node.duty));
  return rules.find(rule => key(rule.domain, rule.duty) === pair);
}

function tiers(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!groups.has(candidate.tier)) groups.set(candidate.tier, []);
    groups.get(candidate.tier).push(candidate);
  }
  return [...groups].sort(([a], [b]) => a - b);
}

function weightedOrder(candidates, random = Math.random) {
  return tiers(candidates).flatMap(([, group]) => {
    const ordered = [];
    while (group.length > 1) {
      let point = random() * group.reduce((total, item) => total + item.weight, 0);
      const index = group.findIndex(item => (point -= item.weight) < 0);
      ordered.push(group.splice(index, 1)[0]);
    }
    return [...ordered, ...group];
  });
}

const api = { label, key, catalog, normalizeRule, migrate, findRule, tiers, weightedOrder };
if (typeof module !== 'undefined') module.exports = { ...api, normalize };
else window.deskWorkflowRatings = api;
})();
