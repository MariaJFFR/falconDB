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

function remove(key) {

  const file = getFile(key);

  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

module.exports = {
  create,
  read,
  remove
};