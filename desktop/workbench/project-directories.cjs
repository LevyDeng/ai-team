function formatMissingProjectDirectories(project, roles, locationName) {
  const rolesByLocation = new Map();
  for (const role of roles) {
    const names = rolesByLocation.get(role.locationId) ?? [];
    names.push(role.name);
    rolesByLocation.set(role.locationId, names);
  }

  const labels = [...rolesByLocation].map(([locationId, names]) => ({location:locationName(locationId), names}));
  return [
    `「${project.name}」缺少工作目录。`,
    ...labels.map(({location, names}) => `「${location}」尚未设置工作目录，影响角色 ${names.map(name => `「${name}」`).join('、')}。`),
    '请在「项目设置 → 添加目录」为这些位置添加工作目录。',
  ].join('\n');
}

module.exports = { formatMissingProjectDirectories };
