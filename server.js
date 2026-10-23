const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const QRCode = require('qrcode');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3456;
const IS_WIN = process.platform === 'win32';
const YT_DLP_PATH = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

async function ensureYtDlpBinary() {
  if (fs.existsSync(YT_DLP_PATH)) return;
  const downloadUrl = IS_WIN
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
  console.log(`⬇️ Baixando yt-dlp (${process.platform})...`);
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Falha ao baixar yt-dlp: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(YT_DLP_PATH, buffer);
  if (!IS_WIN) {
    fs.chmodSync(YT_DLP_PATH, 0o755);
  }
  console.log('✅ yt-dlp instalado com sucesso!');
}

// ==========================================
// EXTRATOR DE STREAM DIRETO (SEM BLOQUEIO VEVO / SEM ANÚNCIOS)
// ==========================================
const streamCache = new Map(); // videoId -> { url, expiresAt }
const pendingExtractions = new Map(); // videoId -> Promise<string>

function resolveStreamUrl(videoId) {
  if (!videoId) return Promise.resolve(null);

  const cached = streamCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.url);
  }

  if (pendingExtractions.has(videoId)) {
    return pendingExtractions.get(videoId);
  }

  const promise = new Promise((resolve) => {
    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '--no-warnings',
      '-g',
      '-f', 'b[ext=mp4]/b',
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(YT_DLP_PATH, args, { timeout: 20000 }, (err, stdout) => {
      pendingExtractions.delete(videoId);
      if (err) {
        console.warn(`⚠️ Erro ao extrair stream para ${videoId}:`, err.message);
        return resolve(null);
      }
      const url = (stdout || '').trim().split(/\r?\n/)[0];
      if (url && url.startsWith('http')) {
        // Cacheia por 2 horas
        streamCache.set(videoId, {
          url,
          expiresAt: Date.now() + 2 * 60 * 60 * 1000
        });
        console.log(`🎬 Stream MP4 pronto para [${videoId}]`);
        resolve(url);
      } else {
        resolve(null);
      }
    });
  });

  pendingExtractions.set(videoId, promise);
  return promise;
}

// ==========================================
// DESCOBERTA DE IP LOCAL + TÚNEL 4G/5G
// ==========================================
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  const preferred = candidates.find(c =>
    /wi-?fi|wlan|ethernet|en0|eth0/i.test(c.name) &&
    !c.address.startsWith('169.254.')
  );
  return (preferred || candidates[0] || { address: 'localhost' }).address;
}

const CLOUD_PUBLIC_URL =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

let connectionInfo = {
  localUrl: CLOUD_PUBLIC_URL || `http://${getLocalIp()}:${PORT}`,
  tunnelUrl: CLOUD_PUBLIC_URL || null,
  tunnelStatus: CLOUD_PUBLIC_URL ? 'ready' : 'starting',
  preferredMode: 'auto'
};

async function startCloudflareTunnel() {
  if (CLOUD_PUBLIC_URL) {
    console.log(`☁️ Rodando na Nuvem! Link fixo: ${CLOUD_PUBLIC_URL}`);
    return;
  }
  try {
    const { Tunnel, bin, install } = require('cloudflared');
    if (!fs.existsSync(bin)) {
      console.log('⬇️ Baixando binário do túnel 4G/5G (apenas na 1ª vez)...');
      await install(bin);
    }
    console.log('🌐 Iniciando túnel público (4G/5G) via Cloudflare...');
    const t = Tunnel.quick(`http://localhost:${PORT}`);
    t.on('url', (publicUrl) => {
      if (publicUrl && typeof publicUrl === 'string') {
        connectionInfo.tunnelUrl = publicUrl;
        connectionInfo.tunnelStatus = 'ready';
        console.log(`✅ Link 4G/5G (Internet) pronto: ${publicUrl}`);
        broadcastState();
      }
    });
    t.on('error', (err) => {
      console.warn('⚠️ Erro no túnel Cloudflare:', err.message);
      connectionInfo.tunnelStatus = 'error';
      broadcastState();
    });
    t.on('exit', (code) => {
      console.log(`Túnel encerrado com código ${code}`);
      connectionInfo.tunnelStatus = 'error';
      broadcastState();
    });
  } catch (err) {
    console.warn('⚠️ Não foi possível abrir túnel Cloudflare automaticamente:', err.message);
    connectionInfo.tunnelStatus = 'error';
    broadcastState();
  }
}

// ==========================================
// BUSCA INTEGRADA YOUTUBE MUSIC + CLIPES
// ==========================================
async function searchYouTubeMusic(query) {
  try {
    const [ytResult, ytmList] = await Promise.all([
      ytSearch(query).catch(() => ({ videos: [] })),
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

// ==========================================
// ESTADO DO JOGO / JUKEBOX DA GALERA
// ==========================================
const MAX_AMMO = 3;
const LIKES_TO_RECHARGE = 2;
const RANZINZA_STREAK = 3;
const MYSTERY_SECONDS = 30;

let gameState = {
  mode: 'livre', // 'livre' | 'desafio'
  fixedPlayerCount: 0,
  isPaused: false,
  currentSong: null,
  queue: [],
  currentStreakUserId: null,
  currentStreakCount: 0,
  roundOrder: [],
  history: [],
  lastSkipAlert: null
};

const players = new Map();
const AVATARS = ['🎸', '🔥', '🎧', '🕺', '💃', '🍻', '🚀', '👑', '🦄', '🐯', '👽', '⚡', '🍕', '🎷', '🥁'];

function getOrCreatePlayer(playerId, name) {
  let p = players.get(playerId);
  if (!p) {
    const avatar = AVATARS[players.size % AVATARS.length];
    p = {
      id: playerId,
      name: (name || 'Convidado').trim().slice(0, 22),
      avatar,
      score: 0,
      ammo: MAX_AMMO,
      likesTowardsAmmo: 0,
      consecutiveDislikes: 0,
      isRanzinza: false,
      connected: true,
      songsPlayed: 0,
      songsVetoed: 0,
      songsApproved: 0,
      lastActive: Date.now()
    };
    players.set(playerId, p);
  } else {
    if (name && name.trim()) {
      p.name = name.trim().slice(0, 22);
    }
    p.connected = true;
    p.lastActive = Date.now();
  }
  return p;
}

// ==========================================
// FILA INTELIGENTE (RODADAS DE ATÉ 2 MÚSICAS POR PESSOA)
// ==========================================
function rebalanceQueue() {
  if (gameState.queue.length <= 1) return;

  const byUser = new Map();
  for (const song of gameState.queue) {
    const uid = song.addedBy.id;
    if (!byUser.has(uid)) {
      byUser.set(uid, []);
    }
    byUser.get(uid).push(song);
  }
  for (const list of byUser.values()) {
    list.sort((a, b) => a.addedAt - b.addedAt);
  }

  const activeUsersWithSongs = Array.from(byUser.keys());
  gameState.roundOrder = gameState.roundOrder.filter(uid => byUser.has(uid));
  for (const uid of activeUsersWithSongs) {
    if (!gameState.roundOrder.includes(uid)) {
      gameState.roundOrder.push(uid);
    }
  }

  const newQueue = [];
  const streakUser = gameState.currentStreakUserId;
  const streakCount = gameState.currentStreakCount;

  if (streakUser && byUser.has(streakUser)) {
    if (streakCount === 1 && gameState.roundOrder[0] === streakUser) {
      const secondSong = byUser.get(streakUser).shift();
      if (secondSong) newQueue.push(secondSong);
      gameState.roundOrder = gameState.roundOrder.filter(u => u !== streakUser);
      if (byUser.get(streakUser).length > 0) {
        gameState.roundOrder.push(streakUser);
      }
    } else if (streakCount >= 2) {
      gameState.roundOrder = gameState.roundOrder.filter(u => u !== streakUser);
      gameState.roundOrder.push(streakUser);
    }
  }

  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const uid of gameState.roundOrder) {
      const list = byUser.get(uid);
      if (list && list.length > 0) {
        const take = list.splice(0, 2);
        newQueue.push(...take);
        if (list.length > 0) {
          hasMore = true;
        }
      }
    }
  }

  gameState.queue = newQueue;
}

// ==========================================
// CONTROLE DE REPRODUÇÃO (PLAY, PRÓXIMA, VOLTAR)
// ==========================================
async function activateSong(songObj) {
  gameState.isPaused = false;
  gameState.currentSong = {
    ...songObj,
    startedAt: Date.now(),
    mysteryRevealed: gameState.mode === 'livre',
    votes: {},
    streamReady: Boolean(streamCache.get(songObj.videoId))
  };

  console.log(`▶️ Preparando reprodução: "${songObj.title}" - ${songObj.artist} [videoId: ${songObj.videoId}]`);
  broadcastState();

  // Pré-carrega a próxima da fila também!
  if (gameState.queue.length > 0) {
    resolveStreamUrl(gameState.queue[0].videoId).catch(() => {});
  }

  const streamUrl = await resolveStreamUrl(songObj.videoId);
  if (gameState.currentSong && gameState.currentSong.id === songObj.id) {
    gameState.currentSong.streamReady = Boolean(streamUrl);
    broadcastState();
  }
}

function startNextSong(reason = 'finished') {
  if (gameState.currentSong && (reason === 'finished' || reason === 'host_skip')) {
    finalizeCurrentSongScore(false);
  }

  if (gameState.queue.length === 0) {
    gameState.currentSong = null;
    gameState.isPaused = false;
    gameState.currentStreakUserId = null;
    gameState.currentStreakCount = 0;
    console.log('⏹️ Fila vazia. Aguardando novas músicas.');
    broadcastState();
    return;
  }

  const next = gameState.queue.shift();
  const uid = next.addedBy.id;

  if (gameState.currentStreakUserId === uid) {
    gameState.currentStreakCount += 1;
  } else {
    gameState.currentStreakUserId = uid;
    gameState.currentStreakCount = 1;
  }

  rebalanceQueue();

  const owner = players.get(uid);
  if (owner) {
    owner.songsPlayed += 1;
  }

  activateSong(next);
}

// Voltar para a música anterior (⏮️)
function playPreviousSong() {
  if (gameState.history.length === 0) {
    // Se não há histórico anterior, apenas reinicia a música atual do zero!
    if (gameState.currentSong) {
      gameState.currentSong.startedAt = Date.now();
      io.emit('playerCommand', { command: 'restart' });
      broadcastState();
    }
    return;
  }

  const prev = gameState.history.shift();

  // Devolve a música que estava tocando agora para o topo da fila para não perdê-la!
  if (gameState.currentSong) {
    const curr = gameState.currentSong;
    gameState.queue.unshift({
      id: curr.id,
      videoId: curr.videoId,
      title: curr.title,
      artist: curr.artist,
      thumbnail: curr.thumbnail,
      duration: curr.duration || '3:30',
      addedBy: curr.addedBy,
      addedAt: curr.addedAt || Date.now()
    });
  }

  activateSong({
    id: `${Date.now()}-prev`,
    videoId: prev.videoId,
    title: prev.title,
    artist: prev.artist,
    thumbnail: prev.thumbnail,
    duration: prev.duration || '3:30',
    addedBy: prev.addedBy,
    addedAt: Date.now()
  });
}

function finalizeCurrentSongScore(wasVetoed) {
  const song = gameState.currentSong;
  if (!song) return;

  const owner = players.get(song.addedBy.id);
  const voteEntries = Object.values(song.votes || {});
  const likes = voteEntries.filter(v => v.type === 'like').length;
  const dislikesWeight = voteEntries
    .filter(v => v.type === 'dislike')
    .reduce((acc, v) => acc + (v.weight || 1), 0);

  const totalParticipants = getActiveParticipantCount();

  if (owner && gameState.mode === 'desafio') {
    if (wasVetoed) {
      owner.score -= 15;
      owner.songsVetoed += 1;
    } else {
      const otherPlayersCount = Math.max(1, totalParticipants - 1);
      if (likes >= Math.ceil(otherPlayersCount * 0.7) && likes >= 1) {
        owner.score += 20;
        owner.songsApproved += 1;
      }
    }
  }

  gameState.history.unshift({
    id: song.id,
    videoId: song.videoId,
    title: song.title,
    artist: song.artist,
    thumbnail: song.thumbnail,
    duration: song.duration,
    addedBy: song.addedBy,
    likes,
    dislikes: dislikesWeight,
    wasVetoed,
    endedAt: Date.now()
  });
  if (gameState.history.length > 20) {
    gameState.history.pop();
  }
}

function getActiveParticipantCount() {
  if (gameState.fixedPlayerCount && gameState.fixedPlayerCount > 0) {
    return gameState.fixedPlayerCount;
  }
  const connectedPlayers = Array.from(players.values()).filter(p => p.connected);
  return Math.max(1, connectedPlayers.length);
}

function getDislikeThreshold() {
  const total = getActiveParticipantCount();
  return Math.floor(total / 2) + 1;
}

function getPublicState() {
  const now = Date.now();
  const totalParticipants = getActiveParticipantCount();
  const dislikeThreshold = getDislikeThreshold();

  let currentSongView = null;
  if (gameState.currentSong) {
    const s = gameState.currentSong;
    const elapsedSeconds = Math.floor((now - s.startedAt) / 1000);
    const isRevealed = s.mysteryRevealed || gameState.mode === 'livre' || elapsedSeconds >= MYSTERY_SECONDS;
    if (isRevealed && !s.mysteryRevealed) {
      s.mysteryRevealed = true;
    }

    const voteEntries = Object.entries(s.votes || {});
    const likesCount = voteEntries.filter(([, v]) => v.type === 'like').length;
    const dislikesRawCount = voteEntries.filter(([, v]) => v.type === 'dislike').length;
    const dislikesEffective = voteEntries
      .filter(([, v]) => v.type === 'dislike')
      .reduce((sum, [, v]) => sum + (v.weight || 1), 0);

    const connectedList = Array.from(players.values()).filter(p => p.connected);
    const pendingVoters = connectedList
      .filter(p => p.id !== s.addedBy.id && !(s.votes && s.votes[p.id]))
      .map(p => ({ id: p.id, name: p.name, avatar: p.avatar }));

    const completedVoters = connectedList
      .filter(p => p.id === s.addedBy.id || Boolean(s.votes && s.votes[p.id]))
      .map(p => ({ id: p.id, name: p.name, avatar: p.avatar }));

    currentSongView = {
      id: s.id,
      videoId: s.videoId,
      streamReady: Boolean(s.streamReady),
      streamEndpoint: `/api/stream/${s.videoId}`,
      title: s.title,
      artist: s.artist,
      thumbnail: s.thumbnail,
      duration: s.duration,
      startedAt: s.startedAt,
      elapsedSeconds,
      mysteryRemainingSeconds: Math.max(0, MYSTERY_SECONDS - elapsedSeconds),
      isRevealed,
      addedBy: isRevealed
        ? s.addedBy
        : { id: 'mystery', name: '🕵️ Mistério...', avatar: '❓' },
      realAddedById: s.addedBy.id,
      likesCount,
      dislikesRawCount,
      dislikesEffective,
      dislikeThreshold,
      pendingVoters,
      completedVoters,
      voterIds: Object.keys(s.votes || {})
    };
  }

  const playerList = Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .map((p, idx) => ({
      ...p,
      rank: idx + 1
    }));

  const activeQrUrl =
    connectionInfo.preferredMode === 'local' || !connectionInfo.tunnelUrl
      ? connectionInfo.localUrl
      : connectionInfo.tunnelUrl;

  return {
    mode: gameState.mode,
    isPaused: gameState.isPaused,
    hasHistory: gameState.history.length > 0,
    fixedPlayerCount: gameState.fixedPlayerCount,
    totalParticipants,
    dislikeThreshold,
    currentSong: currentSongView,
    queue: gameState.queue,
    history: gameState.history.slice(0, 8),
    players: playerList,
    lastSkipAlert: gameState.lastSkipAlert,
    connection: {
      ...connectionInfo,
      activeQrUrl
    }
  };
}

function broadcastState() {
  io.emit('stateUpdate', getPublicState());
}

setInterval(() => {
  if (gameState.currentSong && !gameState.currentSong.mysteryRevealed) {
    const elapsed = Math.floor((Date.now() - gameState.currentSong.startedAt) / 1000);
    if (elapsed >= MYSTERY_SECONDS) {
      gameState.currentSong.mysteryRevealed = true;
      io.emit('mysteryRevealed', {
        songId: gameState.currentSong.id,
        addedBy: gameState.currentSong.addedBy
      });
      broadcastState();
    }
  }
}, 1000);

// ==========================================
// ROTAS HTTP / API + STREAM PROXY
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

app.get('/tv', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

// Proxy de stream MP4 com suporte a Range (toca 100% dos vídeos da VEVO/YouTube sem bloqueio!)
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const directUrl = await resolveStreamUrl(videoId);
    if (!directUrl) {
      return res.status(404).send('Stream indisponível');
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const client = directUrl.startsWith('https') ? https : http;
    const proxyReq = client.get(directUrl, { headers }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // Segue redirect do googlevideo se houver
        return res.redirect(proxyRes.headers.location);
      }

      const forwardHeaders = {};
      if (proxyRes.headers['content-type']) forwardHeaders['Content-Type'] = proxyRes.headers['content-type'];
      if (proxyRes.headers['content-length']) forwardHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) forwardHeaders['Content-Range'] = proxyRes.headers['content-range'];
      forwardHeaders['Accept-Ranges'] = 'bytes';

      res.writeHead(proxyRes.statusCode || 200, forwardHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.warn('Erro no proxy de vídeo:', err.message);
      if (!res.headersSent) res.status(502).end();
    });

    req.on('close', () => {
      proxyReq.destroy();
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

app.get('/api/qrcode', async (req, res) => {
  try {
    const mode = req.query.mode || connectionInfo.preferredMode;
    const targetUrl =
      mode === 'local' || !connectionInfo.tunnelUrl
        ? connectionInfo.localUrl
        : connectionInfo.tunnelUrl;
    const dataUrl = await QRCode.toDataURL(targetUrl, {
      margin: 1,
      width: 320,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
    res.json({ url: targetUrl, dataUrl, connection: connectionInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchYouTubeMusic(q);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Erro na busca do YouTube Music', details: err.message });
  }
});

// ==========================================
// SOCKET.IO - TEMPO REAL
// ==========================================
let activeTvSocketId = null;

io.on('connection', (socket) => {
  let currentPlayerId = null;

  socket.emit('stateUpdate', getPublicState());

  // Garante que apenas UMA aba/tela de Telão toque áudio por vez!
  socket.on('registerTv', () => {
    if (activeTvSocketId && activeTvSocketId !== socket.id) {
      io.to(activeTvSocketId).emit('tvDeactivated');
    }
    activeTvSocketId = socket.id;
    console.log(`📺 Telão Principal registrado: ${socket.id}`);
    socket.emit('stateUpdate', getPublicState());
  });

  socket.on('registerPlayer', ({ playerId, name }, callback) => {
    if (!playerId) return;
    currentPlayerId = playerId;
    const player = getOrCreatePlayer(playerId, name);
    console.log(`👤 Participante conectado: ${player.avatar} ${player.name}`);
    broadcastState();
    if (typeof callback === 'function') {
      callback({ ok: true, player });
    }
  });

  socket.on('addSong', ({ playerId, name, song }, callback) => {
    if (!song || !song.videoId) {
      return callback && callback({ ok: false, error: 'Música inválida.' });
    }
    const player = getOrCreatePlayer(playerId || 'guest_' + Date.now(), name || 'Convidado');

    if (
      gameState.mode === 'desafio' &&
      gameState.currentSong &&
      gameState.currentSong.addedBy.id !== player.id &&
      !gameState.currentSong.votes[player.id]
    ) {
      return callback && callback({
        ok: false,
        error: 'Vote na música que está tocando agora (👍 ou 👎) para liberar novos pedidos!'
      });
    }

    const alreadyInQueue =
      (gameState.currentSong && gameState.currentSong.videoId === song.videoId) ||
      gameState.queue.some(item => item.videoId === song.videoId);

    if (alreadyInQueue) {
      return callback && callback({
        ok: false,
        error: 'Essa música já está na fila ou tocando agora!'
      });
    }

    const newSong = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      videoId: song.videoId,
      title: song.title || 'Música',
      artist: song.artist || 'YouTube Music',
      thumbnail: song.thumbnail || `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg`,
      duration: song.duration || '3:30',
      addedBy: {
        id: player.id,
        name: player.name,
        avatar: player.avatar
      },
      addedAt: Date.now()
    };

    console.log(`➕ Música adicionada por ${player.name}: "${newSong.title}" (${newSong.videoId})`);

    // Já dispara a extração do stream em background imediatamente!
    resolveStreamUrl(newSong.videoId).catch(() => {});

    gameState.queue.push(newSong);
    rebalanceQueue();

    if (!gameState.currentSong) {
      startNextSong('idle');
    } else {
      broadcastState();
    }

    if (typeof callback === 'function') {
      callback({ ok: true, song: newSong });
    }
  });

  socket.on('voteSong', ({ playerId, type }, callback) => {
    const player = players.get(playerId);
    const song = gameState.currentSong;

    if (!player || !song) {
      return callback && callback({ ok: false, error: 'Nenhuma música tocando no momento.' });
    }

    if (song.addedBy.id === playerId) {
      return callback && callback({ ok: false, error: 'Essa música é sua! Segure o mistério 🤫' });
    }

    if (song.votes[playerId]) {
      return callback && callback({ ok: false, error: 'Você já votou nesta música!' });
    }

    const songOwner = players.get(song.addedBy.id);

    if (type === 'dislike') {
      if (player.ammo <= 0) {
        return callback && callback({
          ok: false,
          error: 'Sem munição de Dislike (💣 0/3)! Dê Likes em músicas boas para recarregar.'
        });
      }

      player.ammo = Math.max(0, player.ammo - 1);
      player.consecutiveDislikes += 1;

      let voteWeight = 1;
      if (player.consecutiveDislikes >= RANZINZA_STREAK) {
        player.isRanzinza = true;
        player.score -= 10;
        voteWeight = 0.5;
        io.emit('ranzinzaAlert', {
          player: { id: player.id, name: player.name, avatar: player.avatar },
          streak: player.consecutiveDislikes
        });
      }

      song.votes[playerId] = {
        type: 'dislike',
        weight: voteWeight,
        at: Date.now()
      };

      if (!player.isRanzinza) {
        player.score += 2;
      }

      if (songOwner) {
        songOwner.score -= 5;
      }
    } else if (type === 'like') {
      player.consecutiveDislikes = 0;
      player.isRanzinza = false;
      player.likesTowardsAmmo += 1;

      if (player.likesTowardsAmmo >= LIKES_TO_RECHARGE) {
        player.likesTowardsAmmo = 0;
        if (player.ammo < MAX_AMMO) {
          player.ammo += 1;
        }
      }

      song.votes[playerId] = {
        type: 'like',
        weight: 1,
        at: Date.now()
      };

      player.score += 2;

      if (songOwner) {
        songOwner.score += 10;
      }
    } else {
      return callback && callback({ ok: false, error: 'Tipo de voto inválido.' });
    }

    const dislikesEffective = Object.values(song.votes)
      .filter(v => v.type === 'dislike')
      .reduce((sum, v) => sum + (v.weight || 1), 0);

    const threshold = getDislikeThreshold();

    if (gameState.mode === 'desafio' && dislikesEffective >= threshold) {
      song.mysteryRevealed = true;
      const vetoInfo = {
        id: song.id,
        title: song.title,
        artist: song.artist,
        addedBy: song.addedBy,
        dislikesEffective,
        threshold,
        at: Date.now()
      };
      gameState.lastSkipAlert = vetoInfo;
      finalizeCurrentSongScore(true);

      io.emit('songVetoed', vetoInfo);
      startNextSong('vetoed');
    } else {
      broadcastState();
    }

    if (typeof callback === 'function') {
      callback({ ok: true, player });
    }
  });

  socket.on('sendReaction', ({ playerId, emoji }) => {
    const player = players.get(playerId);
    io.emit('liveReaction', {
      emoji: emoji || '🔥',
      playerName: player ? player.name : 'Galera'
    });
  });

  socket.on('hostAction', ({ action, payload }) => {
    if (action === 'setMode') {
      gameState.mode = payload.mode === 'livre' ? 'livre' : 'desafio';
      console.log(`🔄 Modo alterado para: ${gameState.mode.toUpperCase()}`);
      if (gameState.mode === 'livre' && gameState.currentSong) {
        gameState.currentSong.mysteryRevealed = true;
      }
      broadcastState();
    } else if (action === 'setFixedPlayerCount') {
      gameState.fixedPlayerCount = Math.max(0, parseInt(payload.count, 10) || 0);
      broadcastState();
    } else if (action === 'skipSong') {
      console.log('⏭️ Pulando para a próxima música...');
      startNextSong('host_skip');
    } else if (action === 'previousSong') {
      console.log('⏮️ Voltando para a música anterior...');
      playPreviousSong();
    } else if (action === 'togglePause') {
      const desiredPause =
        payload && typeof payload.paused === 'boolean'
          ? payload.paused
          : !gameState.isPaused;
      gameState.isPaused = desiredPause;
      if (activeTvSocketId) {
        io.to(activeTvSocketId).emit('playerCommand', {
          command: gameState.isPaused ? 'pause' : 'play'
        });
      } else {
        io.emit('playerCommand', {
          command: gameState.isPaused ? 'pause' : 'play'
        });
      }
      broadcastState();
    } else if (action === 'syncPauseState') {
      // Sincroniza quando alguém clica direto no vídeo da TV
      if (payload && typeof payload.paused === 'boolean') {
        gameState.isPaused = payload.paused;
        broadcastState();
      }
    } else if (action === 'songEnded') {
      if (gameState.currentSong && (!payload?.songId || payload.songId === gameState.currentSong.id)) {
        startNextSong('finished');
      }
    } else if (action === 'removeQueueItem') {
      gameState.queue = gameState.queue.filter(item => item.id !== payload.songId);
      rebalanceQueue();
      broadcastState();
    } else if (action === 'toggleQrMode') {
      connectionInfo.preferredMode = payload.mode;
      broadcastState();
    }
  });

  socket.on('disconnect', () => {
    if (activeTvSocketId === socket.id) {
      activeTvSocketId = null;
    }
    if (currentPlayerId && players.has(currentPlayerId)) {
      const p = players.get(currentPlayerId);
      p.connected = false;
      broadcastState();
    }
  });
});

server.listen(PORT, async () => {
  console.log('====================================================');
  console.log(`🎵 JUKEBOX DA GALERA RODANDO!`);
  console.log(`📺 Abra o TELÃO na TV/Notebook: http://localhost:${PORT}/tv`);
  console.log(`📱 Link Wi-Fi Local: ${connectionInfo.localUrl}`);
  console.log('====================================================');
  await ensureYtDlpBinary().catch(e => console.warn('Aviso yt-dlp:', e.message));
  startCloudflareTunnel();
});
