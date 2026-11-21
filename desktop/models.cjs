const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$/;
const effortPattern = /^[a-z][a-z0-9_\-]{0,31}$/;

function normalizeCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length > 500) throw new Error('Invalid model catalog.');
  const seen = new Set();
  const models = value.models.map((model) => {
    if (!model || typeof model.id !== 'string' || !modelPattern.test(model.id) || seen.has(model.id)) throw new Error('Invalid model catalog.');
    seen.add(model.id);
    const efforts = Array.isArray(model.efforts) ? [...new Set(model.efforts.filter((effort) => typeof effort === 'string' && effortPattern.test(effort)))] : [];
    return { id: model.id, label: String(model.label || model.id).slice(0, 200), description: String(model.description || '').slice(0, 1000), resolvedModel: String(model.resolvedModel || model.id).slice(0, 200), efforts, defaultEffort: efforts.includes(model.defaultEffort) ? model.defaultEffort : '', isDefault: Boolean(model.isDefault) };
  });
  if (!models.length) throw new Error('The CLI returned no selectable models.');
  return { models, version: String(value.version || '').slice(0, 200), updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : null };
}

function selection(value = {}) {
  if (!value || typeof value !== 'object') throw new Error('Invalid model settings.');
  const model = value.model ?? '';
  const effort = value.effort ?? '';
  if (typeof model !== 'string' || typeof effort !== 'string' || (model && !modelPattern.test(model)) || (effort && !effortPattern.test(effort)) || (!model && effort)) throw new Error('Invalid model settings.');
  return { model, effort };
}

function validateSelection(value, catalog) {
  const settings = selection(value);
  if (!settings.model) return settings;
  const model = catalog?.models?.find((entry) => entry.id === settings.model);
  if (!model) throw new Error('This model is not in the current CLI catalog. Reconnect to refresh the list.');
  if (settings.effort && !model.efforts.includes(settings.effort)) throw new Error('This model does not support the selected reasoning effort.');
  return settings;
}

module.exports = { normalizeCatalog, selection, validateSelection };
