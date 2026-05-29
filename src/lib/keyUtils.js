function normalizeKey(key) {
  let obj;

  // if already an object, use it directly
  if (typeof key === 'object' && key !== null && !Array.isArray(key)) {
    obj = key;
  } else if (typeof key === 'string') {
    // try to parse as JSON object
    try {
      const parsed = JSON.parse(key);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        obj = parsed;
      }
    } catch (e) {
      // plain string key — use as-is
      return key;
    }
  }

  if (!obj) return key;

  // sort entries alphabetically so { b, a } and { a, b } produce the same key
  const sorted = Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(Object.fromEntries(sorted));
}

module.exports = { normalizeKey };
