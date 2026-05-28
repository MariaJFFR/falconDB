const fs = require('fs');
const path = require('path');
const md5 = require('md5');

const DBPATH = path.join(__dirname, '..', 'DBdata');

function getFile(key) {
  return path.join(DBPATH, md5(key) + '.json');
}

function _write(key, value) {
  fs.writeFileSync(getFile(key), JSON.stringify({ key, value }, null, 2));
}

function create(key, value) {
  const file = getFile(key);
  if (fs.existsSync(file)) {
    throw new Error('key already exists');
  }
  _write(key, value);
}

function read(key) {
  const file = getFile(key);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file));
}

function update(key, members) {
  const existing = read(key);
  if (!existing) return null;

  const value = existing.value;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('update requires existing value to be a flat object');
  }

  for (const [k, v] of Object.entries(members)) {
    if (v === '--delete--') {
      delete value[k];
    } else if (v === '\\-\\-delete\\-\\-') {
      value[k] = '--delete--';
    } else {
      value[k] = v;
    }
  }

  _write(key, value);
  return { key, value };
}

function remove(key) {
  const file = getFile(key);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

function list() {
  if (!fs.existsSync(DBPATH)) return [];
  return fs.readdirSync(DBPATH)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

module.exports = { create, read, update, remove, list };
