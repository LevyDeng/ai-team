((root) => {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const modelDefault = 'model-default';
  const supportsEffort = engine => !['kimi','cursor','gemini-web'].includes(engine);
  function effectiveRole(chat, role) {
    const settings = chat?.roleSettings?.[role.id] || {};
    const chosen = text(settings.effort) || text(role.effort);
    return { ...role, model:text(settings.model) || text(role.model), effort:supportsEffort(role.engine)&&chosen!==modelDefault?chosen:'' };
  }
  function modelOffering(models, model) {
    return model ? models.find(entry=>entry.id===model)||models.find(entry=>entry.resolvedModel===model) : models.find(entry=>entry.isDefault);
  }
  const api = { effectiveRole, modelOffering, modelDefault, supportsEffort };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.deskChatSettings = api;
})(typeof globalThis === 'object' ? globalThis : this);
