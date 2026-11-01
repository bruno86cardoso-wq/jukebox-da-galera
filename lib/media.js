const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { validVideoId } = require('./security');

function createMedia(binary, { run = execFile, maxConcurrent = 2, maxPending = 30, now = Date.now,
  origin = process.env.MEDIA_ORIGIN || '', playerClient = process.env.YTDLP_CLIENT || 'android',
  pluginDir = process.env.YTDLP_PLUGIN_DIR || '', diagnostics = false,
  cookiesFile = process.env.YTDLP_COOKIES_FILE || DEFAULT_COOKIES_FILE } = {}) {
  const cookies = prepareCookies(cookiesFile);
  // O cliente "android" não aceita login. Com cookies, o automático: "web" extraía mais rápido,
  // mas o YouTube recusava o download de parte das músicas (502); o automático tocou todas.
  if (cookies && (playerClient === 'android' || playerClient === 'android_vr')) playerClient = 'default';
  // Cache do yt-dlp (código do player do YouTube) reaproveitado entre músicas.
  const cacheDir = path.join(os.tmpdir(), 'jukebox-yt-dlp-cache');
  if (!PLAYER_CLIENTS.includes(playerClient)) {
    throw new Error('Cliente de reprodução não suportado.');
  }
  let relayOrigin = null;
  // Túnel registrado por um PC (não o configurado em MEDIA_ORIGIN): vale só enquanto o PC renova.
  let relayDynamic = false;
  let relaySeenAt = 0;
  const RELAY_TTL = 2 * 60 * 1000;

  function dropRelay(reason) {
    if (!relayOrigin) return;
    console.warn(`[MEDIA] Túnel do PC ${relayOrigin} descartado (${reason}). Buscando o áudio direto.`);
    for (const [key, entry] of cache) if (entry.url.startsWith(relayOrigin)) cache.delete(key);
    relayOrigin = null;
    relayDynamic = false;
  }

  // Um PC que desligou ou perdeu o túnel para de renovar: o Render volta a buscar direto.
  function currentRelay() {
    if (relayOrigin && relayDynamic && now() - relaySeenAt > RELAY_TTL) dropRelay('o PC parou de renovar');
    return relayOrigin;
  }
  if (origin) {
    const target = new URL(origin);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
      throw new Error('MEDIA_ORIGIN deve ser a origem HTTPS do servidor de áudio, sem caminho ou credenciais.');
    }
    const ownOrigin = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
    if (ownOrigin && new URL(ownOrigin).origin === target.origin) throw new Error('MEDIA_ORIGIN não pode apontar para o próprio serviço.');
    relayOrigin = target.origin;
  }
  const cache = new Map();
  const pending = new Map();
  const jobs = [];
  let running = 0;
  let runningBackground = 0;

  // Pedidos da galera passam na frente; o preparo antecipado (rádio) usa no máximo 1 vaga,
  // para sempre sobrar uma livre para quem pedir música.
  function nextJobIndex() {
    const urgent = jobs.findIndex(job => !job.background);
    if (urgent !== -1) return urgent;
    return runningBackground < 1 && jobs.length ? 0 : -1;
  }

  function pump() {
    while (running < maxConcurrent && jobs.length) {
      const index = nextJobIndex();
      if (index === -1) break;
      const job = jobs.splice(index, 1)[0];
      const { videoId, kind, key, resolve } = job;
      const background = Boolean(job.background);
      running++;
      if (background) runningBackground++;
      // Progressive MP4 (format 18) possui compatibilidade universal em navegadores móveis e desktop
      const args = extractorArgs(videoId, kind);
      const finish = (err, stdout = '', stderr = '') => {
        if (diagnostics) console.log('DIAG plugin ' + JSON.stringify({
          loaded: /PO Token Providers:.*bgutil:http/i.test(stderr),
          refused: /sign in|not a bot|403|429/i.test(stderr),
          timedOut: Boolean(err?.killed)
        }));
        running--;
        if (background) runningBackground--;
        pending.delete(key);
        let result = null;
        if (!err) {
          const urls = stdout.trim().split(/\r?\n/).map(u => u.trim()).filter(u => {
            try { return new URL(u).protocol === 'https:'; } catch { return false; }
          });
          if (urls.length) {
            const expirations = urls.map(url => Number(new URL(url).searchParams.get('expire')) * 1000)
              .filter(value => value > now());
            const expiresAt = Math.min(now() + 30 * 60 * 1000, ...expirations) - 60000;
            result = { url: urls[0], kind, expiresAt };
            for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id);
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(key, result);
          }
        } else {
          // Mantém o diagnóstico nos logs, sem expor URLs assinadas ou stack ao convidado.
          const reason = /sign in|not a bot|403|429/i.test(stderr) ? 'acesso recusado pelo provedor'
            : err.killed ? 'tempo de extração esgotado' : 'extração indisponível';
          console.warn(`Mídia ${kind} [${videoId}]: ${reason} (código ${err.code || 'desconhecido'}).`);
        }
        resolve(result);
        pump();
      };
      try { run(binary, args, { timeout: pluginDir ? 60000 : 20000, maxBuffer: 1024 * 1024 }, finish); }
      catch (error) { finish(error); }
    }
  }

  // Mesmos argumentos para o áudio real e para o diagnóstico.
  function extractorArgs(videoId, kind, client = playerClient) {
    // Só arquivo direto (https): lista HLS (m3u8) não toca no celular, porque os pedaços só abrem a partir do servidor.
    const format = kind === 'audio'
      ? 'best[ext=mp4][protocol=https]/bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/best[protocol=https]'
      : 'best[ext=mp4][protocol=https]/best[protocol=https]';
    const args = ['-4', '--cache-dir', cacheDir, '--js-runtimes', 'node', '--no-playlist', '--no-warnings', '-g', '-f',
      format, `https://www.youtube.com/watch?v=${videoId}`];
    // Listas HLS/DASH nunca são usadas: não baixa (economiza processador no servidor grátis).
    const youtubeArgs = ['skip=hls,dash'];
    if (client && client !== 'default') youtubeArgs.unshift(`player_client=${client}`);
    args.unshift('--extractor-args', `youtube:${youtubeArgs.join(';')}`);
    if (pluginDir) args.unshift('--plugin-dirs', pluginDir);
    if (cookies) args.unshift('--cookies', cookies);
    if (diagnostics) args.unshift('--verbose');
    return args;
  }

  // Diagnóstico seguro: diz se extraiu e o motivo da falha, sem URLs nem dados da conta.
  function explain(videoId, { client } = {}) {
    if (!validVideoId(videoId)) return Promise.resolve({ ok: false, reason: 'ID inválido' });
    const testedClient = PLAYER_CLIENTS.includes(client) ? client : playerClient;
    const started = now();
    return new Promise(resolve => {
      run(binary, extractorArgs(videoId, 'audio', testedClient), { timeout: 90000, maxBuffer: 1024 * 1024 }, (err, stdout = '', stderr = '') => {
        const extracted = !err && stdout.includes('https://');
        const manifest = /m3u8|manifest/i.test(stdout);
        const lastError = String(stderr).split(/\r?\n/).filter(line => /ERROR|WARNING/.test(line)).pop() || '';
        resolve({
          ok: extracted,
          usingCookies: Boolean(cookies),
          playerClient: testedClient || 'default',
          seconds: Math.round((now() - started) / 100) / 10,
          manifest,
          reason: extracted ? 'extraiu' : /not a bot|sign in/i.test(stderr) ? 'YouTube pediu login (bloqueio de robô)'
            : /403|429/.test(stderr) ? 'acesso recusado pelo YouTube' : err?.killed ? 'tempo esgotado' : 'falhou',
          detail: lastError.replace(/https?:\/\/\S+/g, '[link]').slice(0, 300)
        });
      });
    });
  }

  // `direct` pula o relay: usado só como plano B quando o computador da festa não responde.
  function resolveStreamUrl(videoId, kind = 'audio', { direct = false, background = false } = {}) {
    if (!validVideoId(videoId) || !['audio', 'video'].includes(kind)) return Promise.resolve(null);
    const key = `${kind}:${videoId}`;
    const cached = cache.get(key);
    const relay = currentRelay();
    if (cached && cached.expiresAt > now() && !(direct && relay && cached.url.startsWith(relay))) return Promise.resolve(cached);
    if (relay && !direct) {
      const endpoint = kind === 'audio' ? 'audio' : 'stream';
      const entry = { url: `${relayOrigin}/api/${endpoint}/${videoId}`, kind, expiresAt: now() + 60000 };
      for (const [id, item] of cache) if (item.expiresAt <= now()) cache.delete(id);
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
      return Promise.resolve(entry);
    }
    if (pending.has(key)) {
      // Alguém precisa agora de uma música que estava sendo preparada com antecedência: passa na frente.
      const waiting = jobs.find(job => job.key === key);
      if (waiting && !background) waiting.background = false;
      pump();
      return pending.get(key);
    }
    if (pending.size >= maxPending) return Promise.resolve(null);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(key, promise);
    jobs.push({ videoId, kind, key, resolve, background });
    pump();
    return promise;
  }

  async function serve(req, res, kind) {
    const { videoId } = req.params;
    if (!validVideoId(videoId)) return res.status(400).send('ID de música inválido.');
    const resolved = await resolveStreamUrl(videoId, kind);
    if (res.destroyed) return;
    if (!resolved) return res.status(503).send('Mídia indisponível. Tente novamente ou pule a música.');

    const onFail = async (err) => {
      cache.delete(`${kind}:${videoId}`);
      // Não desliga o relay: uma falha passageira do túnel não pode derrubar o áudio até reiniciar.
      if (relayOrigin && resolved.url.startsWith(relayOrigin)) {
        console.warn(`[RELAY FALLBACK] Origem ${relayOrigin} falhou (${err?.message || 'erro'}). Tentando extrair direto nesta música...`);
        // Túnel de PC que falhou é descartado; se o PC estiver vivo, ele registra de novo em até 45s.
        if (relayDynamic) dropRelay(err?.message || 'falhou');
        if (!res.headersSent && !res.destroyed) {
          const fallback = await resolveStreamUrl(videoId, kind, { direct: true });
          if (fallback && !res.headersSent && !res.destroyed) {
            proxy(fallback.url, req, res, () => cache.delete(`${kind}:${videoId}`));
            return true;
          }
        }
      }
      return false;
    };

    proxy(resolved.url, req, res, onFail);
  }

  function setRelayOrigin(newOrigin) {
    if (!newOrigin) {
      relayOrigin = null;
      cache.clear();
      return true;
    }
    try {
      const target = new URL(newOrigin);
      if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') {
        return false;
      }
      const ownOrigin = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
      if (ownOrigin && new URL(ownOrigin).origin === target.origin) return false;
      relayOrigin = target.origin;
      relayDynamic = true;
      relaySeenAt = now();
      cache.clear();
      console.log(`[MEDIA] Relay origin atualizado dinamicamente para: ${relayOrigin}`);
      return true;
    } catch {
      return false;
    }
  }

  function getRelayOrigin() {
    return currentRelay();
  }

  return { resolveStreamUrl, serve, cache, setRelayOrigin, getRelayOrigin, explain, usingCookies: Boolean(cookies) };
}

// Cookies de uma conta Google descartável (arquivo secreto do Render) ajudam quando o YouTube
// bloqueia o servidor como robô. O yt-dlp regrava o arquivo, então usa uma cópia gravável.
const DEFAULT_COOKIES_FILE = '/etc/secrets/youtube-cookies.txt';
const PLAYER_CLIENTS = ['', 'default', 'android', 'web_embedded', 'android_vr', 'visionos', 'tv', 'tv_simply',
  'mweb', 'web', 'web_safari', 'ios'];
function prepareCookies(source) {
  try {
    if (!source || !fs.existsSync(source)) return '';
    const target = path.join(os.tmpdir(), 'jukebox-youtube-cookies.txt');
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    console.log('🍪 Usando cookies da conta do YouTube para buscar o áudio.');
    return target;
  } catch (error) {
    console.warn('Aviso: não foi possível usar o arquivo de cookies:', error.message);
    return '';
  }
}

function proxy(url, req, res, invalidate, redirects = 0) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Referer': 'https://www.youtube.com/'
  };
  if (req.headers.range) headers.Range = req.headers.range;
  const client = url.startsWith('https:') ? https : http;
  const upstream = client.get(url, { headers, timeout: 35000 }, async response => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects >= 3) {
        if (invalidate) await invalidate();
        return res.status(502).end();
      }
      const target = new URL(response.headers.location, url);
      if (target.protocol !== 'https:') return res.status(502).end();
      return proxy(target.href, req, res, invalidate, redirects + 1);
    }
    if ([401, 403, 404, 410, 502, 503].includes(response.statusCode)) {
      console.warn(`[PROXY status] upstream returned ${response.statusCode}`);
      response.resume();
      let handled = false;
      if (invalidate) {
        try { handled = await invalidate(new Error(`Upstream ${response.statusCode}`)); } catch {}
      }
      if (!handled && !res.headersSent) {
        return res.status(502).end();
      }
      return;
    }
    const forwarded = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    };
    for (const key of ['content-type', 'content-length', 'content-range']) {
      if (response.headers[key]) forwarded[key] = response.headers[key];
    }
    res.writeHead(response.statusCode || 502, forwarded);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Tempo de mídia esgotado')));
  upstream.on('error', async (err) => {
    let handled = false;
    if (invalidate) {
      try { handled = await invalidate(err); } catch {}
    }
    if (!handled) {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    }
  });
  // O ciclo de vida da resposta representa o consumidor do stream.
  res.once('close', () => upstream.destroy());
}

module.exports = { createMedia, proxy };
