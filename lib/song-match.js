// Reconhece "a mesma música" em versões diferentes no YouTube (clipe, áudio oficial, versão com letra).

const fold = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = value => fold(value).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(word => word.length >= 2);

// "Wiz Khalifa - See You Again ft. Charlie Puth [Official Video]" -> { title: "See You Again", artist: "Wiz Khalifa" }
function songIdentity(rawTitle, rawAuthor) {
  let title = String(rawTitle || '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s(ft|feat|featuring|part)\.?\s.*$/i, ' ')
    .replace(/\b(official|oficial|video|clipe|audio|lyrics?|letra|hd|4k)\b/gi, ' ');
  let artist = String(rawAuthor || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+music$/i, '');
  const parts = title.split(/\s[-–—|]\s/);
  if (parts.length >= 2) {
    title = parts.slice(1).join(' ');
    if (!artist || words(parts[0]).some(word => words(rawAuthor).includes(word))) artist = parts[0];
  }
  return { title: title.replace(/\s+/g, ' ').trim(), artist: artist.replace(/\s+/g, ' ').trim() };
}

// Mesma música: as palavras do nome batem (80%) e não é cover/karaokê/remix quando o original não é.
function sameSong(candidate, wanted) {
  const target = words(wanted.title);
  if (!target.length) return false;
  const have = new Set(words(candidate.title));
  const matched = target.filter(word => have.has(word)).length / target.length;
  if (/\b(cover|karaoke|karaokê|instrumental|remix|slowed|sped|8d|reverb)\b/i.test(candidate.title) &&
      !/\b(cover|karaoke|instrumental|remix)\b/i.test(wanted.title)) return false;
  return matched >= 0.8;
}

const sameArtist = (candidate, wanted) => words(candidate.artist).some(word => words(wanted.artist).includes(word));

function durationSeconds(duration) {
  const parts = String(duration || '').split(':').map(Number);
  return parts.length >= 2 && parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0;
}

module.exports = { songIdentity, sameSong, sameArtist, durationSeconds };
