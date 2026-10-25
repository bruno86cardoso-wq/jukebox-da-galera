const { execFile } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { validVideoId } = require('./security');

function createMedia(binary, { run = execFile, maxConcurrent = 2, maxPending = 30, now = Date.now,
  origin = process.env.MEDIA_ORIGIN || '', playerClient = process.env.YTDLP_CLIENT || 'android',
  pluginDir = process.env.YTDLP_PLUGIN_DIR || '', diagnostics = false } = {}) {
  if (!['', 'default', 'android', 'web_embedded', 'android_vr', 'visionos', 'tv', 'mweb'].includes(playerClient)) {
    throw new Error('Cliente de reprodução não suportado.');
  }
  let relayOrigin = null;
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

  function pump() {
    while (running < maxConcurrent && jobs.length) {
      running++;
      const { videoId, kind, key, resolve } = jobs.shift();
      // Progressive MP4 (format 18) possui compatibilidade universal em navegadores móveis e desktop
      const format = kind === 'audio' ? 'best[ext=mp4]/bestaudio[ext=m4a]/best' : 'best[ext=mp4]/best';
      const args = ['-4', '--no-cache-dir', '--js-runtimes', 'node', '--no-playlist', '--no-warnings', '-g', '-f',
        format, `https://www.youtube.com/watch?v=${videoId}`];
      if (playerClient && playerClient !== 'default') args.unshift('--extractor-args', `youtube:player_client=${playerClient}`);
      if (pluginDir) args.unshift('--plugin-dirs', pluginDir);
      if (diagnostics) args.unshift('--verbose');
      const finish = (err, stdout = '', stderr = '') => {
        if (diagnostics) console.log('DIAG plugin ' + JSON.stringify({
          loaded: /PO Token Providers:.*bgutil:http/i.test(stderr),
          refused: /sign in|not a bot|403|429/i.test(stderr),
          timedOut: Boolean(err?.killed)
        }));
        running--;
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

  // `direct` pula o relay: usado só como plano B quando o computador da festa não responde.
  function resolveStreamUrl(videoId, kind = 'audio', { direct = false } = {}) {
    if (!validVideoId(videoId) || !['audio', 'video'].includes(kind)) return Promise.resolve(null);
    const key = `${kind}:${videoId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now() && !(direct && relayOrigin && cached.url.startsWith(relayOrigin))) return Promise.resolve(cached);
    if (relayOrigin && !direct) {
      const endpoint = kind === 'audio' ? 'audio' : 'stream';
      const entry = { url: `${relayOrigin}/api/${endpoint}/${videoId}`, kind, expiresAt: now() + 60000 };
      for (const [id, item] of cache) if (item.expiresAt <= now()) cache.delete(id);
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
      return Promise.resolve(entry);
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) return Promise.resolve(null);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(key, promise);
    jobs.push({ videoId, kind, key, resolve });
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

  return { resolveStreamUrl, serve, cache };
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
