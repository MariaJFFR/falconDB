const fs = require('fs');
const path = require('path');
const jsonlint = require('jsonlint');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'etc', 'configure.json');

function validateConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    jsonlint.parse(raw);
  } catch (err) {
    console.error(`[configValidator] invalid configure.json: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { validateConfig };
