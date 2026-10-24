const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const { searchYouTubeMusic, getSearchSuggestions } = require('./lib/catalog');
const { rebalanceQueue: balanceQueue } = require('./lib/queue');

const { randomBytes, randomInt } = require('node:crypto');
const { createMedia } = require('./lib/media');
const { createPersistence } = require('./lib/persistence');
const { isRecord, validVideoId, text, playerIdForToken, secretEquals, normalizeSong, createRateLimiter } = require('./lib/security');

function createJukebox(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16384 });
  const hostSession = randomBytes(32).toString('hex');
  const allow = createRateLimiter();
  const playerSockets = new Map();
  let stopping = false;
  if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  const PORT = options.port ?? Number(process.env.PORT || 3456);
  const IS_WIN = process.platform === 'win32';
  const YT_DLP_PATH = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

  async function ensureYtDlpBinary() {
    if (fs.existsSync(YT_DLP_PATH)) return;
    const downloadUrl = IS_WIN
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    console.log(`⬇️ Baixando yt-dlp (${process.platform})...`);
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Falha ao baixar yt-dlp: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(YT_DLP_PATH, buffer);
    if (!IS_WIN) {
      fs.chmodSync(YT_DLP_PATH, 0o755);
    }
    console.log('✅ yt-dlp instalado com sucesso!');
  }

  // ==========================================
  // EXTRATOR DE STREAM DIRETO (ÁUDIO M4A ULTRA-RÁPIDO + VÍDEO MP4 SEM ANÚNCIOS)
  // ==========================================
  const media = options.media || createMedia(YT_DLP_PATH);
  const { resolveStreamUrl } = media;

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
    if (options.tunnel === false || process.env.DISABLE_TUNNEL === '1') return;
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
  const persistence = createPersistence(
    options.statePath === undefined ? path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'party.json') : options.statePath,
    () => ({ gameState, players: Array.from(players.values()) }),
    data => isRecord(data.gameState) && ['livre', 'desafio'].includes(data.gameState.mode) &&
      Array.isArray(data.gameState.queue) && data.gameState.queue.length <= 100 &&
      Array.isArray(data.gameState.history) && Array.isArray(data.gameState.roundOrder) &&
      Array.isArray(data.players) && data.players.length <= 200 &&
      data.players.every(p => isRecord(p) && typeof p.id === 'string' && typeof p.name === 'string' && Number.isFinite(p.score)) &&
      [...data.gameState.queue, ...data.gameState.history, ...(data.gameState.currentSong ? [data.gameState.currentSong] : [])]
        .every(song => isRecord(song) && validVideoId(song.videoId) && isRecord(song.addedBy) && typeof song.id === 'string')
  );
  const saved = persistence.load();
  if (saved) {
    Object.assign(gameState, saved.gameState);
    for (const player of saved.players) players.set(player.id, { ...player, connected: false });
    if (gameState.currentSong) {
      gameState.isPaused = true;
      gameState.currentSong.startedAt = Date.now();
      gameState.currentSong.pausedAt = Date.now();
      gameState.currentSong.pausedMs = 0;
    }
  }

  const AVATARS = ['🎸', '🔥', '🎧', '🕺', '💃', '🍻', '🚀', '👑', '🦄', '🐯', '👽', '⚡', '🍕', '🎷', '🥁'];

  function getOrCreatePlayer(playerId, name) {
    let p = players.get(playerId);
    if (!p) {
      if (players.size >= 200) throw new Error('A festa atingiu o limite de participantes.');
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
  function rebalanceQueue() { balanceQueue(gameState); }

  // ==========================================
  // CONTROLE DE REPRODUÇÃO (PLAY, PRÓXIMA, VOLTAR)
  // ==========================================
  async function activateSong(songObj) {
    gameState.isPaused = false;
    gameState.currentSong = {
      ...songObj,
      startedAt: Date.now(),
      pausedMs: 0,
      pausedAt: null,
      mysteryRevealed: gameState.mode === 'livre',
      votes: {},
      streamReady: Boolean(media.cache?.get(`audio:${songObj.videoId}`)?.expiresAt > Date.now())
    };

    console.log(`▶️ Preparando reprodução: "${songObj.title}" - ${songObj.artist} [videoId: ${songObj.videoId}]`);
    broadcastState();

    // Pré-carrega as próximas 2 da fila também!
    for (let i = 0; i < Math.min(gameState.queue.length, 2); i++) {
      resolveStreamUrl(gameState.queue[i].videoId, 'audio').catch(() => {});
      resolveStreamUrl(gameState.queue[i].videoId, 'video').catch(() => {});
    }

    const streamUrl = await resolveStreamUrl(songObj.videoId);
    if (!stopping && gameState.currentSong && gameState.currentSong.id === songObj.id) {
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
        gameState.currentSong.pausedMs = 0;
        gameState.currentSong.pausedAt = null;
        gameState.isPaused = false;
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

    gameState.currentStreakUserId = prev.addedBy.id;
    gameState.currentStreakCount = 1;
    rebalanceQueue();
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

  function getEligibleVoterCount() {
    if (gameState.fixedPlayerCount > 0) return Math.max(0, gameState.fixedPlayerCount - 1);
    return Array.from(players.values()).filter(p => p.connected && p.id !== gameState.currentSong?.addedBy.id).length;
  }

  function getDislikeThreshold() {
    return Math.floor(getEligibleVoterCount() / 2) + 1;
  }

  function songElapsed(song) {
    return Math.max(0, Math.floor(((song.pausedAt || Date.now()) - song.startedAt - (song.pausedMs || 0)) / 1000));
  }

  function setPaused(paused) {
    const song = gameState.currentSong;
    if (song && paused !== gameState.isPaused) {
      if (paused) song.pausedAt = Date.now();
      else {
        song.pausedMs = (song.pausedMs || 0) + (Date.now() - (song.pausedAt || Date.now()));
        song.pausedAt = null;
      }
    }
    gameState.isPaused = paused;
  }

  function getPublicState() {
    const totalParticipants = getActiveParticipantCount();
    const dislikeThreshold = getDislikeThreshold();

    let currentSongView = null;
    if (gameState.currentSong) {
      const s = gameState.currentSong;
      const elapsedSeconds = songElapsed(s);
      const isRevealed = s.mysteryRevealed || gameState.mode === 'livre' || elapsedSeconds >= MYSTERY_SECONDS;

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
    if (stopping) return;
    persistence.schedule();
    io.emit('stateUpdate', getPublicState());
  }

  const mysteryTimer = setInterval(() => {
    if (gameState.currentSong && !gameState.currentSong.mysteryRevealed) {
      const elapsed = songElapsed(gameState.currentSong);
      if (elapsed >= MYSTERY_SECONDS) {
        gameState.currentSong.mysteryRevealed = true;
        io.emit('mysteryRevealed', {
          songId: gameState.currentSong.id,
          addedBy: gameState.currentSong.addedBy
        });
        broadcastState();
      } else {
        io.emit('stateUpdate', getPublicState());
      }
    }
  }, 1000);
  mysteryTimer.unref();

  // ==========================================
  // ROTAS HTTP / API + STREAM PROXY
  // ==========================================
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
  });

  app.get('/tv', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tv.html'));
  });

  function httpLimit(req, res, next) {
    if (!allow('http:' + req.ip, 120)) return res.status(429).json({ error: 'Muitas solicitações. Aguarde um minuto.' });
    next();
  }
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/audio/:videoId', httpLimit, (req, res) => media.serve(req, res, 'audio'));
  app.get('/api/stream/:videoId', httpLimit, (req, res) => media.serve(req, res, 'video'));

  app.get('/api/qrcode', httpLimit, async (req, res) => {
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

  app.get('/api/search', httpLimit, async (req, res) => {
    if (typeof req.query.q !== 'string' || req.query.q.length > 200) return res.status(400).json({ error: 'Busca inválida (máximo 200 caracteres).' });
    const q = req.query.q.trim();
    if (!q) return res.json({ results: [] });
    try {
      const results = await searchYouTubeMusic(q);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: 'Erro na busca do YouTube Music', details: err.message });
    }
  });

  app.get('/api/suggest', httpLimit, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.json({ suggestions: [] });
    try {
      const suggestions = await getSearchSuggestions(q);
      res.json({ suggestions });
    } catch {
      res.json({ suggestions: [] });
    }
  });

  // ==========================================
  // SOCKET.IO - TEMPO REAL
  // ==========================================
  let activeTvSocketId = null;

  io.on('connection', (socket) => {
    let currentPlayerId = null;
    const identity = playerIdForToken(socket.handshake.auth?.playerToken);
    let isHost = true;
    const address = socket.request ? socket.request.socket.remoteAddress : socket.handshake.address;

    function on(event, handler, limit = 60) {
      socket.on(event, (data, callback) => {
        const reply = typeof callback === 'function' ? callback : result => {
          if (!result.ok) socket.emit('actionError', result);
        };
        try {
          if (!allow((event === 'authenticateHost' ? address : identity || address) + ':' + event, limit)) throw new Error('Muitas tentativas. Aguarde um minuto.');
          if (!isRecord(data)) throw new Error('Dados inválidos.');
          handler(data, reply);
        } catch (error) {
          reply({ ok: false, error: error.message || 'Não foi possível executar a ação.' });
        }
      });
    }

    on('authenticateHost', (_, reply) => {
      reply({ ok: true, token: hostSession });
    }, 60);

    on('releaseTv', (_, reply) => {
      if (activeTvSocketId === socket.id) activeTvSocketId = null;
      reply({ ok: true });
    });

    socket.emit('stateUpdate', getPublicState());

    // Garante que apenas UMA aba/tela de Telão toque áudio por vez!
    on('registerTv', (_, reply) => {
      if (activeTvSocketId && activeTvSocketId !== socket.id) {
        io.to(activeTvSocketId).emit('tvDeactivated');
      }
      activeTvSocketId = socket.id;
      console.log(`📺 Telão Principal registrado: ${socket.id}`);
      socket.emit('stateUpdate', getPublicState());
      reply({ ok: true });
    });

    on('registerPlayer', ({ name }, callback) => {
      if (!identity) throw new Error('Sessão inválida. Recarregue a página.');
      name = text(name, 22);
      if (!name) throw new Error('Digite seu nome ou apelido.');
      currentPlayerId = identity;
      const player = getOrCreatePlayer(identity, name);
      if (!playerSockets.has(identity)) playerSockets.set(identity, new Set());
      playerSockets.get(identity).add(socket.id);
      console.log(`👤 Participante conectado: ${player.avatar} ${player.name}`);
      callback({ ok: true, player });
      broadcastState();
    });

    on('addSong', ({ song }, callback) => {
      if (!currentPlayerId) throw new Error('Entre na festa antes de pedir músicas.');
      song = normalizeSong(song);
      if (!song || !song.videoId) {
        return callback && callback({ ok: false, error: 'Música inválida.' });
      }
      const player = players.get(currentPlayerId);
      if (gameState.queue.length >= 100 || gameState.queue.filter(s => s.addedBy.id === player.id).length >= 10) throw new Error('Limite da fila atingido: até 10 pedidos por pessoa e 100 na festa.');

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
      resolveStreamUrl(newSong.videoId, 'audio').catch(() => {});
      resolveStreamUrl(newSong.videoId, 'video').catch(() => {});

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

    on('voteSong', ({ type, songId }, callback) => {
      const playerId = currentPlayerId;
      if (gameState.mode !== 'desafio') throw new Error('A votação está disponível apenas no modo Desafio.');
      if (!songId || songId !== gameState.currentSong?.id) throw new Error('A música mudou. Vote na música atual.');
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

    on('sendReaction', ({ emoji }, reply) => {
      const player = players.get(currentPlayerId);
      if (!player) throw new Error('Entre na festa primeiro.');
      if (!['🔥', '👍', '👎', '❤️', '😂', '🍻', '💃', '💩'].includes(emoji)) throw new Error('Reação inválida.');
      io.emit('liveReaction', {
        emoji: emoji || '🔥',
        playerName: player.name
      });
      reply({ ok: true });
    }, 30);

    on('hostAction', ({ action, payload = {} }, reply) => {
      if (!isRecord(payload)) throw new Error('Comando inválido.');
      const actions = ['setMode', 'setFixedPlayerCount', 'skipSong', 'previousSong', 'togglePause', 'syncPauseState', 'songEnded', 'removeQueueItem', 'toggleQrMode'];
      if (!actions.includes(action)) throw new Error('Comando desconhecido.');
      if (['songEnded', 'syncPauseState'].includes(action) && activeTvSocketId !== socket.id) throw new Error('Este aparelho não é o reprodutor ativo.');
      if (action === 'setMode' && !['livre', 'desafio'].includes(payload.mode)) throw new Error('Modo inválido.');
      if (action === 'setFixedPlayerCount' && (!/^\d{1,3}$/.test(String(payload.count)) || Number(payload.count) > 200)) throw new Error('Informe de 0 a 200 participantes.');
      if (action === 'toggleQrMode' && !['auto', 'local'].includes(payload.mode)) throw new Error('Modo de QR inválido.');
      if (action === 'removeQueueItem') text(payload.songId, 100);

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
        setPaused(desiredPause);
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
          setPaused(payload.paused);
          broadcastState();
        }
      } else if (action === 'songEnded') {
        if (gameState.currentSong && payload.songId === gameState.currentSong.id) {
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
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      if (activeTvSocketId === socket.id) {
        activeTvSocketId = null;
      }
      if (currentPlayerId && players.has(currentPlayerId)) {
        const p = players.get(currentPlayerId);
        const sockets = playerSockets.get(currentPlayerId);
        sockets?.delete(socket.id);
        p.connected = Boolean(sockets?.size);
        if (!sockets?.size) playerSockets.delete(currentPlayerId);
        broadcastState();
      }
    });
  });

  async function start() {
    if (!options.media && (!process.env.MEDIA_ORIGIN || process.env.MEDIA_DIAGNOSTICS_VIDEO)) await ensureYtDlpBinary().catch(e => console.warn('Aviso yt-dlp:', e.message));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, options.bind || '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
    const port = server.address().port;
    if (!CLOUD_PUBLIC_URL) connectionInfo.localUrl = `http://${getLocalIp()}:${port}`;
    console.log('🎵 Jukebox da Galera: http://localhost:' + port + '/tv');
    console.log('📱 Link para convidados: ' + connectionInfo.localUrl);
    if (process.env.MEDIA_ORIGIN) console.log('🔊 Áudio fornecido pelo computador da festa. Mantenha-o ligado com o Jukebox aberto.');
    startCloudflareTunnel();
    if (process.env.MEDIA_DIAGNOSTICS_VIDEO) {
      require('./lib/media-diagnostics').runMediaDiagnostics(YT_DLP_PATH, process.env.MEDIA_DIAGNOSTICS_VIDEO)
        .catch(error => console.warn('DIAG falhou: ' + error.message));
    }
    return port;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(mysteryTimer);
    persistence.flush();
    await new Promise(resolve => io.close(resolve));
  }

  return { app, server, io, start, stop, getPublicState };
}

if (require.main === module) {
  const jukebox = createJukebox();
  jukebox.start().catch(error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await jukebox.stop();
    process.exit(0);
  });
}
module.exports = { createJukebox };
