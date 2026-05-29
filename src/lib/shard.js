const md5 = require('md5');

function getDN(key, totalDNs) {

  const hash = md5(key);

  const number = parseInt(
    hash.substring(0, 8),
    16
  );

  return number % totalDNs;
}

module.exports = {
  getDN
};