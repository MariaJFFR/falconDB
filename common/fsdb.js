const fs = require('fs');
const path = require('path');
const md5 = require('md5');

const DBPATH = path.join(__dirname, '..', 'DBdata');

function getFile(key) {

  const hash = md5(key);

  return path.join(DBPATH, hash + '.json');
}

function create(key, value) {

  const file = getFile(key);

  const data = {
    key,
    value
  };

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
}

function read(key) {

  const file = getFile(key);

  if (!fs.existsSync(file)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(file)
  );
}

function update(key, members) {

  const existing = read(key);

  if (!existing) return null;

  const value = existing.value;

  for (const [k, v] of Object.entries(members)) {

    if (v === '--delete--' || v === '\\-\\-delete\\-\\-') {
      delete value[k];
    } else {
      value[k] = v;
    }
  }

  create(key, value);

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

module.exports = {
  create,
  read,
  update,
  remove,
  list
};
