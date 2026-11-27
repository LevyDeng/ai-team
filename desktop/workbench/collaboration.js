((root) => {
  const maxInvites = 5;
  const dutyLimit = 240;

  function policy(settings, project, chat) {
    function resolve(field, fallback) {
      for (const [source, entry] of [['chat', chat], ['project', project], ['global', settings]]) {
        const value = entry?.aiInvites?.[field];
        if (value !== undefined) return { value, source };
      }
      return { value: fallback, source: 'global' };
    }
    return { allowed: resolve('allowed', false), limit: resolve('limit', 2) };
  }

  function normalizePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.allowed !== undefined && typeof value.allowed !== 'boolean') ||
        (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > maxInvites))) {
      throw new Error('请选择是否允许 AI 邀请，并填写有效的每轮次数。');
    }
    return { ...(value.allowed === undefined ? {} : { allowed: value.allowed }),
      ...(value.limit === undefined ? {} : { limit: value.limit }) };
  }

  function duty(role, project, chat) {
    const chatDuty = chat?.roleDuties?.[role.id];
    if (typeof chatDuty === 'string') return { value: chatDuty, source: 'chat' };
    const projectDuty = project?.roleDuties?.[role.id];
    if (typeof projectDuty === 'string') return { value: projectDuty, source: 'project' };
    return { value: role.defaultDuty || '', source: 'global' };
  }

  function normalizeDuty(value) {
    if (typeof value !== 'string' || value.length > dutyLimit) throw new Error(`角色分工请填写 ${dutyLimit} 字以内的文字。`);
    return value.trim();
  }

  function normalizeDuties(values, roleIds) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('请选择角色并填写分工。');
    return Object.fromEntries(roleIds.filter(id => Object.hasOwn(values, id)).map(id => [id, normalizeDuty(values[id])]));
  }

  const api = { maxInvites, dutyLimit, policy, normalizePolicy, duty, normalizeDuty, normalizeDuties };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.deskCollaboration = api;
})(globalThis);
