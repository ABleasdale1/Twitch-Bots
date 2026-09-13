// Twitch message IDs distinguish a redelivery from two intentional commands.
function createMessageDeduper({
  ttlMs = 5 * 60_000,
  maxEntries = 2048,
  now = Date.now,
} = {}) {
  const seen = new Map();

  return function alreadySeen(id) {
    if (!id) {
      return false;
    }

    const cutoff = now() - ttlMs;

    for (const [key, at] of seen) {
      if (at > cutoff && seen.size < maxEntries) {
        break;
      }

      seen.delete(key);
    }

    if (seen.has(id)) {
      return true;
    }

    seen.set(id, now());
    return false;
  };
}

module.exports = {
  createMessageDeduper,
};
