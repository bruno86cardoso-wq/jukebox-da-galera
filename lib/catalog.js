const ytSearch = require('yt-search');

const searchCache = new Map();
const SUGGEST_CACHE = new Map();

function extractDirectVideoId(query) {
  if (!query) return null;
  const str = String(query).trim();
  const directMatch = str.match(/^[a-zA-Z0-9_-]{11}$/);
  if (directMatch) return directMatch[0];
  const urlMatch = str.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

async function searchWithTimeout(query) {
  let timer;
  try {
    return await Promise.race([
      ytSearch(query),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Busca demorou demais')), 10000); })
    ]);
  } catch { return { videos: [] }; }
  finally { clearTimeout(timer); }
}

async function searchYouTubeMusic(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const directId = extractDirectVideoId(cleanQuery);
  if (directId) {
    try {
      const details = await ytSearch({ videoId: directId });
      if (details && details.videoId) {
        return [{
          videoId: details.videoId,
          title: details.title,
          artist: details.author ? details.author.name.replace(/ - Topic$/i, '') : 'YouTube Music',
          duration: details.timestamp || '3:30',
          thumbnail: details.thumbnail || `https://i.ytimg.com/vi/${details.videoId}/hqdefault.jpg`,
          source: 'Link Direto'
        }];
      }
    } catch (e) {
      // continua para a busca normal
    }
  }

  const cacheKey = cleanQuery.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.results;
  }

  try {
    const [ytResult, ytmList] = await Promise.all([
      searchWithTimeout(cleanQuery),
      fetchYtMusicCatalog(cleanQuery).catch(() => [])
    ]);

    const videos = (ytResult.videos || []).slice(0, 20).map(v => ({
      videoId: v.videoId,
      title: v.title,
      artist: v.author ? v.author.name.replace(/ - Topic$/i, '') : 'YouTube Music',
      duration: v.timestamp || '',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      seconds: v.seconds || 0,
      source: 'YouTube'
    }));

    // Prioriza o catálogo do YouTube Music oficial, seguido pelos vídeos.
    // A busca comum completa artista e duração que o YouTube Music às vezes omite.
    const videoById = new Map(videos.map(v => [v.videoId, v]));
    for (const item of ytmList) {
      const extra = videoById.get(item.videoId);
      if (!item.duration && extra?.seconds) item.duration = extra.duration;
      if (!item.artist && extra) item.artist = extra.artist;
      if (!item.artist) item.artist = 'YouTube Music';
      if (extra?.seconds) item.seconds = extra.seconds;
    }
    const combined = [];
    const seen = new Set();

    for (const item of [...ytmList, ...videos]) {
      if (!item.videoId || seen.has(item.videoId)) continue;

      // Filtro anti-ruído: ignora vídeos de mais de 25 minutos (podcasts, shows inteiros) e trechos curtos.
      if (item.seconds && (item.seconds > 1500 || item.seconds < 60)) continue;

      seen.add(item.videoId);
      combined.push({
        videoId: item.videoId,
        title: item.title,
        artist: item.artist,
        duration: item.duration,
        thumbnail: item.thumbnail,
        source: item.source || 'YouTube Music'
      });
    }

    const results = combined.slice(0, 25);

    // Cacheia buscas por 5 minutos
    searchCache.set(cacheKey, {
      results,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    if (searchCache.size > 200) {
      searchCache.delete(searchCache.keys().next().value);
    }

    return results;
  } catch (err) {
    console.warn('Erro na busca:', err.message);
    return [];
  }
}

async function getSearchSuggestions(query) {
  const clean = String(query || '').trim();
  if (!clean || clean.length < 2) return [];

  const key = clean.toLowerCase();
  const cached = SUGGEST_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.suggestions;
  }

  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(clean)}&hl=pt`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const suggestions = (Array.isArray(data[1]) ? data[1] : []).slice(0, 7);

    SUGGEST_CACHE.set(key, {
      suggestions,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    if (SUGGEST_CACHE.size > 300) {
      SUGGEST_CACHE.delete(SUGGEST_CACHE.keys().next().value);
    }

    return suggestions;
  } catch {
    return [];
  }
}

async function fetchYtMusicCatalog(query) {
  const response = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/'
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20240401.01.00',
          hl: 'pt',
          gl: 'BR'
        }
      },
      query: query
    })
  });

  if (!response.ok) return [];
  const data = await response.json();
  return parseYtMusicResults(data);
}

// Tipos que o YouTube Music marca no subtítulo. Só música e vídeo entram na busca.
const SONG_TYPES = /^(música|musica|song|vídeo|video)$/i;
const SKIP_TYPES = /^(episódio|episodio|episode|podcast|álbum|album|artista|artist|playlist|perfil|profile|ep|single)$/i;
const DURATION = /^\d{1,2}:\d{2}(:\d{2})?$/;
const YEAR = /^\d{4}$/;
const STATS = /(visualiza|views|inscritos|subscribers|ouvintes|listeners|vezes|plays|músicas$)/i;

function runsText(runs) {
  return (runs || []).map(r => r.text).join('').trim();
}

function subtitleParts(runs) {
  return (runs || []).map(r => (r.text || '').trim()).filter(t => t && t !== '•');
}

// Lê tipo, artista e duração do subtítulo ("Música • Anitta • 3:13").
function readSubtitle(parts, fallbackArtist) {
  if (parts.length && SKIP_TYPES.test(parts[0])) return null;
  const rest = parts.length && SONG_TYPES.test(parts[0]) ? parts.slice(1) : parts;
  const duration = rest.find(p => DURATION.test(p)) || '';
  const artist = rest.find(p => p !== duration && !STATS.test(p) && !YEAR.test(p)) || fallbackArtist || '';
  return { artist, duration };
}

function parseRow(item, fallbackArtist) {
  const videoId =
    item?.playlistItemData?.videoId ||
    item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const cols = item.flexColumns || [];
  const title = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const info = readSubtitle(subtitleParts(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs), fallbackArtist);
  if (!title || !info) return null;
  const thumbs = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    videoId, title, artist: info.artist, duration: info.duration,
    thumbnail: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    source: 'YouTube Music'
  };
}

function parseYtMusicResults(data) {
  const items = [];
  try {
    const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        // Cartão do "resultado principal": costuma ser exatamente a música buscada.
        const card = section.musicCardShelfRenderer;
        let cardArtist = '';
        if (card) {
          const cardParts = subtitleParts(card.subtitle?.runs);
          const cardTitle = runsText(card.title?.runs);
          cardArtist = /^(artista|artist)$/i.test(cardParts[0] || '') ? cardTitle : '';
          const topId = card.onTap?.watchEndpoint?.videoId;
          const topInfo = topId && readSubtitle(cardParts, cardArtist);
          if (topId && topInfo && cardTitle) {
            const thumbs = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            items.push({ videoId: topId, title: cardTitle, artist: topInfo.artist, duration: topInfo.duration,
              thumbnail: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${topId}/hqdefault.jpg`, source: 'YouTube Music' });
          }
        }
        const rows = card?.contents || section.musicShelfRenderer?.contents || section.itemSectionRenderer?.contents || [];
        for (const row of rows) {
          const parsed = row.musicResponsiveListItemRenderer && parseRow(row.musicResponsiveListItemRenderer, cardArtist);
          if (parsed) items.push(parsed);
        }
      }
    }
  } catch (e) {
    console.warn('Erro ao fazer parse do YT Music:', e.message);
  }
  return items;
}

module.exports = { searchYouTubeMusic, getSearchSuggestions, parseYtMusicResults };
