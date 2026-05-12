const winston = require('winston');

function createLogger(filename) {

  return winston.createLogger({
    level: 'debug',

    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.simple()
    ),

    transports: [
      new winston.transports.File({
        filename
      }),
      new winston.transports.Console()
    ]
  });
}

module.exports = createLogger;