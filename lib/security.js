const { createHash, timingSafeEqual } = require('node:crypto');

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVideoId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);

function text(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Texto inválido (máximo ${max} caracteres).`);
  return value.trim() || fallback;
}

function playerIdForToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return `p_${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

function secretEquals(value, secret) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

function normalizeSong(song) {
  if (!isRecord(song) || !validVideoId(song.videoId)) throw new Error('Música inválida.');
  return {
    videoId: song.videoId,
    title: text(song.title, 300, 'Música'),
    artist: text(song.artist, 200, 'YouTube Music'),
    duration: text(song.duration, 20, '—'),
    // A capa é derivada do ID validado, nunca de uma URL enviada pelo cliente.
    thumbnail: `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`
  };
}

function createRateLimiter(now = Date.now) {
  const buckets = new Map();
  return (key, limit, windowMs = 60000) => {
    const time = now();
    if (buckets.size > 5000) {
      for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
      if (buckets.size > 5000 && !buckets.has(key)) return false;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= time) {
      bucket = { count: 0, until: time + windowMs };
      buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  };
}

module.exports = { isRecord, validVideoId, text, playerIdForToken, secretEquals, normalizeSong, createRateLimiter };
