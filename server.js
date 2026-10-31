const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const { randomBytes } = require('node:crypto');
const { searchYouTubeMusic, getSearchSuggestions } = require('./lib/catalog');
const { createMedia } = require('./lib/media');
const { createPersistence } = require('./lib/persistence');
const { createParty, generateCode, normalizeCode, validCode, validSaved, hashKey } = require('./lib/party');
const { isRecord, validVideoId, playerIdForToken, createRateLimiter } = require('./lib/security');

const MAX_PARTIES = 100;
const PARTY_IDLE_MS = 12 * 60 * 60 * 1000; // festa vazia some depois de 12 horas

function createJukebox(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16384 });
  const allow = createRateLimiter();
  const log = options.log || console.log;
  let stopping = false;
  if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  const PORT = options.port ?? Number(process.env.PORT || 3456);
  const IS_WIN = process.platform === 'win32';
  const YT_DLP_PATH = path.join(__dirname, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const DATA_DIR = options.dataDir === undefined ? (process.env.DATA_DIR || path.join(__dirname, 'data')) : options.dataDir;
  const PARTIES_DIR = DATA_DIR ? path.join(DATA_DIR, 'parties') : null;

  async function ensureYtDlpBinary() {
    if (fs.existsSync(YT_DLP_PATH)) return;
    const downloadUrl = IS_WIN
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    log(`⬇️ Baixando yt-dlp (${process.platform})...`);
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Falha ao baixar yt-dlp: ${res.status}`);
    fs.writeFileSync(YT_DLP_PATH, Buffer.from(await res.arrayBuffer()));
    if (!IS_WIN) fs.chmodSync(YT_DLP_PATH, 0o755);
    log('✅ yt-dlp instalado com sucesso!');
  }

  const media = options.media || createMedia(YT_DLP_PATH);

  // ==========================================
  // DESCOBERTA DE IP LOCAL + TÚNEL 4G/5G
  // ==========================================
  function getLocalIp() {
    const candidates = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const iface of list) if (iface.family === 'IPv4' && !iface.internal) candidates.push({ name, address: iface.address });
    }
    const preferred = candidates.find(c => /wi-?fi|wlan|ethernet|en0|eth0/i.test(c.name) && !c.address.startsWith('169.254.'));
    return (preferred || candidates[0] || { address: 'localhost' }).address;
  }

  const CLOUD_PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

  const connectionInfo = {
    localUrl: CLOUD_PUBLIC_URL || `http://${getLocalIp()}:${PORT}`,
    tunnelUrl: CLOUD_PUBLIC_URL || null,
    tunnelStatus: CLOUD_PUBLIC_URL ? 'ready' : 'starting'
  };

  function baseUrl(mode) {
    return mode === 'local' || !connectionInfo.tunnelUrl ? connectionInfo.localUrl : connectionInfo.tunnelUrl;
  }
  const inviteUrl = (party, mode = party.qrMode) => `${baseUrl(mode)}/?festa=${party.code}`;

  async function startCloudflareTunnel() {
    if (options.tunnel === false || process.env.DISABLE_TUNNEL === '1') return;
    if (CLOUD_PUBLIC_URL) return log(`☁️ Rodando na Nuvem! Link fixo: ${CLOUD_PUBLIC_URL}`);
    try {
      const { Tunnel, bin, install } = require('cloudflared');
      if (!fs.existsSync(bin)) {
        log('⬇️ Baixando binário do túnel 4G/5G (apenas na 1ª vez)...');
        await install(bin);
      }
      log('🌐 Iniciando túnel público (4G/5G) via Cloudflare...');
      const t = Tunnel.quick(`http://localhost:${PORT}`);
      t.on('url', publicUrl => {
        if (publicUrl && typeof publicUrl === 'string') {
          connectionInfo.tunnelUrl = publicUrl;
          connectionInfo.tunnelStatus = 'ready';
          log(`✅ Link 4G/5G (Internet) pronto: ${publicUrl}`);
          broadcastAll();

          // Sincroniza automaticamente o túnel local do PC com o servidor do Render!
          if (!CLOUD_PUBLIC_URL) {
            const cloudTarget = process.env.CLOUD_TARGET_URL || 'https://jukebox-da-galera.onrender.com';
            const registerWithCloud = () => {
              https.get(`${cloudTarget}/api/register-media-origin?origin=${encodeURIComponent(publicUrl)}`, res => {
                res.resume();
                if (res.statusCode === 200) {
                  log(`🚀 Túnel do PC sincronizado com a nuvem no Render: ${publicUrl}`);
                }
              }).on('error', () => {});
            };
            registerWithCloud();
            if (!global.__cloudSyncInterval) {
              global.__cloudSyncInterval = setInterval(registerWithCloud, 45000);
              global.__cloudSyncInterval.unref();
            }
          }
        }
      });
      t.on('error', err => { console.warn('⚠️ Erro no túnel Cloudflare:', err.message); connectionInfo.tunnelStatus = 'error'; broadcastAll(); });
      t.on('exit', code => { log(`Túnel encerrado com código ${code}`); connectionInfo.tunnelStatus = 'error'; broadcastAll(); });
    } catch (err) {
      console.warn('⚠️ Não foi possível abrir túnel Cloudflare automaticamente:', err.message);
      connectionInfo.tunnelStatus = 'error';
      broadcastAll();
    }
  }

  // ==========================================
  // FESTAS (cada uma com código próprio)
  // ==========================================
  const parties = new Map();   // code -> { party, persistence, sockets:Set, activeTvSocketId }
  const sessions = new Map();  // socket.id -> { code, isHost, playerId }

  function room(code) { return `party:${code}`; }

  function setupParty(code, hostKeyHash, saved = null) {
    const entry = { sockets: new Set(), activeTvSocketId: null };
    entry.persistence = createPersistence(PARTIES_DIR ? path.join(PARTIES_DIR, `${code}.json`) : null,
      () => entry.party.serialize(), validSaved);
    entry.party = createParty({
      code, hostKeyHash, saved, media,
      changed: () => broadcastState(entry),
      emit: (event, payload) => { if (!stopping) io.to(room(code)).emit(event, payload); },
      command: cmd => {
        if (entry.activeTvSocketId) io.to(entry.activeTvSocketId).emit('playerCommand', { command: cmd });
        else io.to(room(code)).emit('playerCommand', { command: cmd });
      }
    });
    parties.set(code, entry);
    return entry;
  }

  function newParty() {
    if (parties.size >= MAX_PARTIES) cleanupParties(true);
    if (parties.size >= MAX_PARTIES) throw new Error('O servidor está cheio de festas. Tente mais tarde.');
    const code = generateCode(c => parties.has(c));
    const hostKey = randomBytes(24).toString('hex');
    const entry = setupParty(code, hashKey(hostKey));
    entry.persistence.schedule();
    log(`🎉 Nova festa criada: ${code}`);
    return { code, hostKey };
  }

  function removeParty(code) {
    const entry = parties.get(code);
    if (!entry) return;
    try { entry.persistence.remove(); } catch {}
    parties.delete(code);
    log(`🧹 Festa ${code} encerrada por inatividade.`);
  }

  function cleanupParties(force = false) {
    const now = Date.now();
    const idle = [...parties.entries()].filter(([, e]) => e.sockets.size === 0)
      .sort((a, b) => a[1].party.lastActivity - b[1].party.lastActivity);
    for (const [code, entry] of idle) {
      if (now - entry.party.lastActivity > PARTY_IDLE_MS || (force && parties.size >= MAX_PARTIES)) removeParty(code);
    }
  }

  function loadParties() {
    if (!PARTIES_DIR || !fs.existsSync(PARTIES_DIR)) return;
    for (const file of fs.readdirSync(PARTIES_DIR)) {
      if (!file.endsWith('.json')) continue;
      const code = file.slice(0, -5);
      if (!validCode(code)) continue;
      try {
        const persistence = createPersistence(path.join(PARTIES_DIR, file), () => null, validSaved);
        const saved = persistence.load();
        if (saved && saved.code === code) setupParty(code, saved.hostKeyHash, saved);
      } catch (error) {
        console.warn(`⚠️ ${error.message}`);
      }
    }
    if (parties.size) log(`💾 ${parties.size} festa(s) recuperada(s).`);
  }
  loadParties();

  function connectionFor(entry) {
    return { ...connectionInfo, preferredMode: entry.party.qrMode, activeQrUrl: inviteUrl(entry.party) };
  }

  function broadcastState(entry) {
    if (stopping) return;
    entry.persistence.schedule();
    const base = entry.party.publicState(connectionFor(entry));
    for (const id of entry.sockets) {
      const socket = io.sockets.sockets.get(id);
      const session = sessions.get(id);
      if (socket && session) socket.emit('stateUpdate', base, { ...entry.party.viewFor(session.playerId, session.isHost), isActivePlayer: entry.activeTvSocketId === id });
    }
  }
  function broadcastAll() { for (const entry of parties.values()) broadcastState(entry); }

  // Revela o autor no tempo certo. Não transmite nada a cada segundo: o celular conta sozinho.
  const mysteryTimer = setInterval(() => { for (const entry of parties.values()) entry.party.tick(); }, 1000);
  mysteryTimer.unref();
  const cleanupTimer = setInterval(() => cleanupParties(), 10 * 60 * 1000);
  cleanupTimer.unref();

  // ==========================================
  // ROTAS HTTP / API + STREAM PROXY
  // ==========================================
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));
  app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));

  function httpLimit(req, res, next) {
    if (!allow('http:' + req.ip, 240)) return res.status(429).json({ error: 'Muitas solicitações. Aguarde um minuto.' });
    next();
  }
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/register-media-origin', (req, res) => {
    const { origin } = req.query;
    if (origin) {
      const ok = media.setRelayOrigin(origin);
      if (!ok) return res.status(400).json({ ok: false, error: 'Origem HTTPS inválida.' });
      log(`🔗 Provedor de mídia conectado da nuvem: ${media.getRelayOrigin()}`);
    }
    res.json({ ok: true, activeOrigin: media.getRelayOrigin() });
  });
  app.post('/api/register-media-origin', express.json(), (req, res) => {
    const { origin } = req.body || {};
    if (!origin) return res.status(400).json({ ok: false, error: 'origin required' });
    const ok = media.setRelayOrigin(origin);
    if (!ok) return res.status(400).json({ ok: false, error: 'Origem HTTPS inválida.' });
    log(`🔗 Provedor de mídia conectado da nuvem: ${media.getRelayOrigin()}`);
    res.json({ ok: true, activeOrigin: media.getRelayOrigin() });
  });
  app.get('/api/audio/:videoId', httpLimit, (req, res) => media.serve(req, res, 'audio'));
  app.get('/api/stream/:videoId', httpLimit, (req, res) => media.serve(req, res, 'video'));
  app.get('/api/debug-media/:videoId', httpLimit, async (req, res) => {
    try {
      const { videoId } = req.params;
      const resolved = await media.resolveStreamUrl(videoId, 'audio');
      if (!resolved) {
        const { execFile } = require('node:child_process');
        return execFile(YT_DLP_PATH, ['--no-playlist', '--no-warnings', '-g', '-f', 'bestaudio/best', `https://www.youtube.com/watch?v=${videoId}`], { timeout: 15000 }, (err, stdout, stderr) => {
          res.json({ ok: false, error: 'resolveStreamUrl returned null', err: err?.message, stdout: stdout?.slice(0, 300), stderr: stderr?.slice(0, 500) });
        });
      }
      const client = resolved.url.startsWith('https:') ? https : http;
      client.get(resolved.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, upstreamRes => {
        upstreamRes.resume();
        res.json({
          ok: true,
          upstreamStatus: upstreamRes.statusCode,
          upstreamHeaders: upstreamRes.headers,
          urlSample: resolved.url.slice(0, 150)
        });
      }).on('error', err => {
        res.json({ ok: false, upstreamError: err.message });
      });
    } catch (e) {
      res.json({ ok: false, catchError: e.message });
    }
  });

  // Capa servida pelo próprio servidor para o telão poder ler as cores (canvas exige mesma origem).
  app.get('/api/thumb/:videoId', httpLimit, (req, res) => {
    const { videoId } = req.params;
    if (!validVideoId(videoId)) return res.status(400).end();
    const upstream = https.get(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, { timeout: 8000 }, response => {
      if (response.statusCode !== 200) { response.resume(); return res.status(404).end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
  });

  app.get('/api/qrcode', httpLimit, async (req, res) => {
    const entry = parties.get(normalizeCode(req.query.festa));
    if (!entry) return res.status(404).json({ error: 'Festa não encontrada.' });
    try {
      const mode = ['auto', 'local'].includes(req.query.mode) ? req.query.mode : entry.party.qrMode;
      let url = inviteUrl(entry.party, mode);
      // Link de anfitrião: só gera se quem pede já tem a chave.
      if (typeof req.query.chave === 'string' && entry.party.isHostKey(req.query.chave)) url += `&chave=${encodeURIComponent(req.query.chave)}`;
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#0f172a', light: '#ffffff' } });
      res.json({ url, code: entry.party.code, dataUrl, connection: connectionFor(entry) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/search', httpLimit, async (req, res) => {
    if (typeof req.query.q !== 'string' || req.query.q.length > 200) return res.status(400).json({ error: 'Busca inválida (máximo 200 caracteres).' });
    const q = req.query.q.trim();
    if (!q) return res.json({ results: [] });
    try {
      res.json({ results: await searchYouTubeMusic(q) });
    } catch (err) {
      res.status(500).json({ error: 'Erro na busca do YouTube Music', details: err.message });
    }
  });

  app.get('/api/suggest', httpLimit, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    if (!q) return res.json({ suggestions: [] });
    try { res.json({ suggestions: await getSearchSuggestions(q) }); }
    catch { res.json({ suggestions: [] }); }
  });

  // ==========================================
  // SOCKET.IO - TEMPO REAL
  // ==========================================
  io.on('connection', socket => {
    const identity = playerIdForToken(socket.handshake.auth?.playerToken);
    const address = socket.request ? socket.request.socket.remoteAddress : socket.handshake.address;
    const session = { code: null, isHost: false, playerId: null };
    sessions.set(socket.id, session);

    const current = () => {
      const entry = session.code && parties.get(session.code);
      if (!entry) throw new Error('Entre em uma festa primeiro.');
      return entry;
    };

    function on(event, handler, limit = 60) {
      socket.on(event, (data, callback) => {
        const reply = typeof callback === 'function' ? callback : result => { if (!result.ok) socket.emit('actionError', result); };
        try {
          const key = ['createParty', 'joinParty'].includes(event) ? address : identity || address;
          if (!allow(key + ':' + event, limit)) throw new Error('Muitas tentativas. Aguarde um minuto.');
          if (!isRecord(data)) throw new Error('Dados inválidos.');
          handler(data, reply);
        } catch (error) {
          reply({ ok: false, error: error.message || 'Não foi possível executar a ação.' });
        }
      });
    }

    function leaveParty() {
      const entry = session.code && parties.get(session.code);
      if (!entry) return;
      entry.sockets.delete(socket.id);
      socket.leave(room(session.code));
      const wasActivePlayer = entry.activeTvSocketId === socket.id;
      if (wasActivePlayer) entry.activeTvSocketId = null;
      const playerId = session.playerId;
      session.code = null;
      session.isHost = false;
      session.playerId = null;
      // setConnected já transmite; senão avisa a galera que o som ficou sem aparelho.
      if (playerId && !otherSocketsFor(entry, playerId)) entry.party.setConnected(playerId, false);
      else if (wasActivePlayer) broadcastState(entry);
    }

    function otherSocketsFor(entry, playerId) {
      for (const id of entry.sockets) if (id !== socket.id && sessions.get(id)?.playerId === playerId) return true;
      return false;
    }

    on('createParty', (_, reply) => {
      reply({ ok: true, ...newParty() });
    }, 10);

    on('joinParty', ({ code, hostKey }, reply) => {
      code = normalizeCode(code);
      const entry = parties.get(code);
      if (!entry) throw new Error('Festa não encontrada. Confira o código com quem está na festa.');
      if (session.code !== code) leaveParty();
      session.code = code;
      session.isHost = entry.party.isHostKey(hostKey);
      entry.sockets.add(socket.id);
      socket.join(room(code));
      reply({ ok: true, code, isHost: session.isHost });
      broadcastState(entry);
    }, 30);

    on('registerPlayer', ({ name }, reply) => {
      const entry = current();
      if (!identity) throw new Error('Sessão inválida. Recarregue a página.');
      const player = entry.party.join(identity, name);
      session.playerId = identity;
      log(`👤 [${entry.party.code}] ${player.avatar} ${player.name}`);
      reply({ ok: true, player });
      broadcastState(entry);
    });

    on('registerTv', (_, reply) => {
      const entry = current();
      if (!session.isHost && !entry.party.guestsControl) throw new Error('Só o anfitrião pode assumir o som desta festa.');
      if (entry.activeTvSocketId && entry.activeTvSocketId !== socket.id) io.to(entry.activeTvSocketId).emit('tvDeactivated');
      entry.activeTvSocketId = socket.id;
      reply({ ok: true });
      broadcastState(entry);
    });

    on('releaseTv', (_, reply) => {
      const entry = current();
      if (entry.activeTvSocketId === socket.id) {
        entry.activeTvSocketId = null;
        broadcastState(entry);
      }
      reply({ ok: true });
    });

    on('addSong', ({ song, dedication }, reply) => {
      const entry = current();
      if (!session.playerId) throw new Error('Entre na festa antes de pedir músicas.');
      const added = entry.party.addSong(session.playerId, song, dedication);
      log(`➕ [${entry.party.code}] "${added.title}" por ${added.addedBy.name}`);
      reply({ ok: true, song: added });
    });

    on('voteSong', ({ type, songId }, reply) => {
      const entry = current();
      const player = entry.party.vote(session.playerId, type, songId);
      reply({ ok: true, player });
    });

    on('sendReaction', ({ emoji }, reply) => {
      current().party.react(session.playerId, emoji);
      reply({ ok: true });
    }, 180);

    on('getSummary', (_, reply) => {
      reply({ ok: true, summary: current().party.summary() });
    }, 20);

    on('hostAction', ({ action, payload = {} }, reply) => {
      const entry = current();
      entry.party.control(action, payload, {
        isHost: session.isHost,
        playerId: session.playerId,
        isActivePlayer: entry.activeTvSocketId === socket.id
      });
      if (action === 'endParty') {
        const code = entry.party.code;
        setTimeout(() => removeParty(code), 2000);
      }
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      leaveParty();
      sessions.delete(socket.id);
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
    log('🎵 Jukebox da Galera: http://localhost:' + port + '/tv');
    log('📱 Convidados entram pelo QR Code de cada festa (' + connectionInfo.localUrl + ')');
    if (process.env.MEDIA_ORIGIN) log('🔊 Áudio fornecido pelo computador da festa. Mantenha-o ligado com o Jukebox aberto.');
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
    clearInterval(cleanupTimer);
    for (const entry of parties.values()) {
      try { entry.persistence.flush(); } catch (error) { console.error('Falha ao salvar festa:', error.message); }
    }
    await new Promise(resolve => io.close(resolve));
  }

  // Para testes: estado público de uma festa (a primeira, se nenhum código for informado).
  function getPublicState(code) {
    const entry = code ? parties.get(code) : parties.values().next().value;
    return entry ? entry.party.publicState(connectionFor(entry)) : null;
  }

  return { app, server, io, start, stop, getPublicState, createParty: newParty, parties };
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
