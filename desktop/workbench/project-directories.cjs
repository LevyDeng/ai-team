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

const fileReferenceInstruction = 'When citing files or folders, use a clickable Markdown link with the verified full path as its target and a short label. Wrap targets that contain spaces in angle brackets. If only a relative path is known, give the complete path from the relevant configured project root. Do not cite a bare filename when its directory is known. For a remote path, identify the remote location beside the link. Never invent a path or convert a remote path to a local drive path.';

function describeProjectDirectories(project, locationId) {
  const current = project.directories.find(directory => directory.locationId === locationId);
  const directories = project.directories.map(directory => directory.locationId + ': ' + directory.path);
  return [
    'All configured project directories:\n' + directories.join('\n'),
    current ? 'Working directory for this role: ' + current.path : '',
  ].filter(Boolean).join('\n');
}

module.exports = { formatMissingProjectDirectories, describeProjectDirectories, fileReferenceInstruction };
