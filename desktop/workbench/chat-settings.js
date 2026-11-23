((root) => {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const modelDefault = 'model-default';
  const supportsEffort = engine => !['kimi','cursor','gemini-web'].includes(engine);
  function effectiveRole(chat, role) {
    const settings = chat?.roleSettings?.[role.id] || {};
    const persona = chat?.rolePersonas?.[role.id];
    const chosen = text(settings.effort) || text(role.effort);
    return {
      ...role,
      persona: persona?.persona ?? role.persona,
      examples: persona?.examples ?? role.examples,
      model: text(settings.model) || text(role.model),
      effort: supportsEffort(role.engine) && chosen !== modelDefault ? chosen : '',
    };
  }
  function modelOffering(models, model) {
    return model ? models.find(entry=>entry.id===model)||models.find(entry=>entry.resolvedModel===model) : models.find(entry=>entry.isDefault);
  }
  function parseCursorModel(value) {
    const input = text(value);
    const match = /^([^\s[\]]+)\[((?:[\w-]+=[\w.\-]+(?:,[\w-]+=[\w.\-]+)*)?)\]$/.exec(input);
    if (!match) return { id: input, parameters: new Map() };
    const parameters = match[2] ? match[2].split(',').map(pair => pair.split('=')) : [];
    return { id: match[1], parameters: new Map(parameters) };
  }
  function formatCursorModel(id, parameters) {
    return parameters.size ? id + '[' + [...parameters].map(([key, value]) => key + '=' + value).join(',') + ']' : id;
  }
  const api = { effectiveRole, modelOffering, modelDefault, supportsEffort, parseCursorModel, formatCursorModel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.deskChatSettings = api;
})(typeof globalThis === 'object' ? globalThis : this);
