function normalizeIP(ip) {
  if (!ip) return '';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function isPrivateIP(ip) {
  return ip === '127.0.0.1' ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip);
}

module.exports = { normalizeIP, isPrivateIP };
