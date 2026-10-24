const ytSearch = require('yt-search');

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
  try {
    const [ytResult, ytmList] = await Promise.all([
      searchWithTimeout(query),
      fetchYtMusicCatalog(query).catch(() => [])
    ]);

    const videos = (ytResult.videos || []).slice(0, 12).map(v => ({
      videoId: v.videoId,
      title: v.title,
      artist: v.author ? v.author.name.replace(/ - Topic$/i, '') : 'YouTube Music',
      duration: v.timestamp || '3:30',
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      source: 'Clipe / Áudio'
    }));

    const combined = [];
    const seen = new Set();

    for (const item of [...videos, ...ytmList]) {
      if (!item.videoId || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      combined.push(item);
    }

    return combined.slice(0, 16);
  } catch (err) {
    console.warn('Erro na busca:', err.message);
    return [];
  }
}

async function fetchYtMusicCatalog(query) {
  const response = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    signal: AbortSignal.timeout(10000),
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

function parseYtMusicResults(data) {
  const items = [];
  try {
    const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        const shelf = section.musicShelfRenderer;
        if (!shelf || !shelf.contents) continue;
        for (const row of shelf.contents) {
          const item = row.musicResponsiveListItemRenderer;
          if (!item) continue;

          const videoId =
            item?.playlistItemData?.videoId ||
            item?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;

          if (!videoId) continue;

          const flexCols = item.flexColumns || [];
          const titleRuns = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const title = titleRuns.map(r => r.text).join('').trim();

          const subtitleRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          const subtitleParts = subtitleRuns
            .map(r => r.text)
            .filter(t => t && t.trim() !== '•' && t.trim() !== ' • ');

          let artist = subtitleParts[1] || subtitleParts[0] || 'Artista';
          let duration = subtitleParts[subtitleParts.length - 1] || '';
          if (!/^\d+:\d+$/.test(duration)) {
            duration = '3:30';
          }

          const thumbs = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
          const bestThumb = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

          if (title) {
            items.push({
              videoId,
              title,
              artist,
              duration,
              thumbnail: bestThumb,
              source: 'YouTube Music'
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Erro ao fazer parse do YT Music:', e.message);
  }
  return items;
}


module.exports = { searchYouTubeMusic };
