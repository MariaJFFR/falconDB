const fs = require('fs');
const path = require('path');
const winston = require('winston');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR);
}

// trace < debug < info < warn < error (lower number = higher priority shown)
const LEVELS = {
  levels: { error: 0, warn: 1, info: 2, debug: 3, trace: 4 },
  colors: { error: 'red', warn: 'yellow', info: 'green', debug: 'blue', trace: 'grey' }
};

winston.addColors(LEVELS.colors);

function createLogger(filename) {

  return winston.createLogger({
    levels: LEVELS.levels,
    level: 'trace',

    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.simple()
    ),

    transports: [
      new winston.transports.File({
        filename: path.join(LOGS_DIR, filename),
        options: { flags: 'w' }
      }),
      new winston.transports.Console()
    ]
  });
}

module.exports = createLogger;
