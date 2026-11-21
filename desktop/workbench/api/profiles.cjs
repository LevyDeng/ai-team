const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, value, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
module.exports = { atomic };
