// Busca o link de áudio pelo YouTube.js, dentro do próprio app (sem abrir o yt-dlp a cada música).
// Experimental: por enquanto só o diagnóstico usa, para medir antes de ligar nas músicas da festa.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');

const CLIENTS = ['MWEB', 'WEB', 'TV', 'TV_SIMPLY', 'TV_EMBEDDED', 'ANDROID', 'ANDROID_VR', 'IOS', 'WEB_EMBEDDED', 'VISIONOS'];

const CLIENT_TTL = 6 * 60 * 60 * 1000;
let modulePromise = null;
let clientPromise = null;
let clientCreatedAt = 0;
let clientCookie = null;

function load() {
  if (!modulePromise) {
    modulePromise = import('youtubei.js').then(mod => {
      // Avisos internos da biblioteca (partes novas da resposta do YouTube) só poluem o registro.
      mod.Log.setLevel(mod.Log.Level.NONE);
      // O YouTube.js precisa de alguém que rode o código do player do YouTube para decifrar o link.
      // Roda num contexto separado, com tempo limite, como recomenda o guia oficial.
      mod.Platform.shim.eval = async (data, env) => {
        const properties = [];
        if (env.n) properties.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
        if (env.sig) properties.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
        const code = `(function () {\n${data.output}\nreturn { ${properties.join(', ')} };\n})()`;
        return vm.runInNewContext(code, { URL, URLSearchParams, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {} } }, { timeout: 5000 });
      };
      return mod;
    });
  }
  return modulePromise;
}

// Converte o arquivo de cookies (formato Netscape) no cabeçalho Cookie do youtube.com.
function cookieHeader(file) {
  try {
    if (!file || !fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map(line => line.replace(/^#HttpOnly_/, ''))
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t'))
      .filter(parts => parts.length >= 7 && /(^|\.)youtube\.com$/.test(parts[0].replace(/^\./, '')))
      .map(parts => `${parts[5]}=${parts[6]}`)
      .join('; ');
  } catch {
    return '';
  }
}

async function client(cookie) {
  if (!clientPromise || Date.now() - clientCreatedAt > CLIENT_TTL || cookie !== clientCookie) {
    const { Innertube, UniversalCache } = await load();
    clientCookie = cookie;
    clientCreatedAt = Date.now();
    clientPromise = Innertube.create({
      cookie: cookie || undefined,
      retrieve_player: true,
      generate_session_locally: true,
      cache: new UniversalCache(false)
    }).catch(error => { clientPromise = null; throw error; });
  }
  return clientPromise;
}

// Devolve { url, itag, mime } do melhor áudio direto, preferindo mp4/m4a (toca no iPhone e no Android).
async function resolveAudio(videoId, { playerClient = 'MWEB', cookiesFile = '' } = {}) {
  const yt = await client(cookieHeader(cookiesFile));
  const info = await yt.getBasicInfo(videoId, { client: playerClient });
  let format;
  try { format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'mp4' }); }
  catch { format = info.chooseFormat({ type: 'audio', quality: 'best', format: 'any' }); }
  const url = await format.decipher(yt.session.player);
  return { url, itag: format.itag, mime: format.mime_type, visitorData: yt.session.context?.client?.visitorData || '' };
}

// Sem o token, o YouTube entrega só o primeiro 1 MB (~1 minuto) e recusa o resto.
// Por isso a conferência pede um pedaço do MEIO (logo depois do 1º MB), não só o começo.
const START = 'bytes=0-1023';
const AFTER_FIRST_MB = 'bytes=1048576-1049599';

function probe(url, range = START) {
  return new Promise(resolve => {
    const request = https.get(url, { headers: { Range: range, 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, response => {
      resolve(response.statusCode);
      response.destroy();
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(0));
  });
}

// Diagnóstico: tempo, se o link toca e memória, sem devolver o link nem dados da conta.
async function wholeSong(url) {
  const middle = await probe(url, AFTER_FIRST_MB);
  if (middle === 206) return true;
  return middle === 416 && (await probe(url)) === 206; // arquivo menor que 1 MB
}

async function explain(videoId, { playerClient = 'MWEB', cookiesFile = '' } = {}) {
  const chosen = CLIENTS.includes(playerClient) ? playerClient : 'MWEB';
  const started = Date.now();
  const hasCookies = Boolean(cookieHeader(cookiesFile));
  const attempts = [];
  // Testa com e sem a conta; e, se recusar, o token vinculado à música e à sessão (visitorData).
  for (const withAccount of hasCookies ? [true, false] : [false]) {
    const label = withAccount ? 'com conta' : 'sem conta';
    try {
      const result = await resolveAudio(videoId, { playerClient: chosen, cookiesFile: withAccount ? cookiesFile : '' });
      const attempt = { modo: label, itag: result.itag, 'começo sem token': await probe(result.url), 'meio sem token': await probe(result.url, AFTER_FIRST_MB) };
      if (chosen === 'MWEB') {
        for (const [bind, value] of [['música', videoId], ['sessão', result.visitorData]]) {
          const token = value ? await poToken(value) : null;
          const url = token ? `${result.url}&pot=${encodeURIComponent(token)}` : null;
          attempt[`token da ${bind}: começo`] = url ? await probe(url) : 'sem token';
          attempt[`token da ${bind}: meio`] = url ? await probe(url, AFTER_FIRST_MB) : 'sem token';
        }
      }
      attempts.push(attempt);
    } catch (error) {
      attempts.push({ modo: label, erro: String(error?.message || error).replace(/https?:\/\/\S+/g, '[link]').slice(0, 150) });
    }
  }
  const ok = attempts.some(a => a['token da música: meio'] === 206 || a['meio sem token'] === 206);
  return { ok, engine: 'youtubei', playerClient: chosen, attempts,
    seconds: Math.round((Date.now() - started) / 100) / 10, memoryMB: Math.round(process.memoryUsage().rss / 1e6) };
}

// Token anti-robô gerado numa thread separada (lib/potoken-worker.mjs), com memória limitada.
let worker = null;
let nextId = 0;
const waiting = new Map();

function tokenWorker() {
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'potoken-worker.mjs'), { resourceLimits: { maxOldGenerationSizeMb: 160 } });
    worker.on('message', ({ id, token, error }) => {
      const done = waiting.get(id);
      if (done) { waiting.delete(id); done(token || null, error); }
    });
    const reset = () => {
      worker = null;
      for (const done of waiting.values()) done(null, 'gerador de token parou');
      waiting.clear();
    };
    worker.on('error', reset);
    worker.on('exit', reset);
    worker.unref();
  }
  return worker;
}

// binding: o que o token "prova" (o ID da música ou o visitorData da sessão).
function poToken(binding, timeoutMs = 20000) {
  return new Promise(resolve => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, timeoutMs);
    waiting.set(id, token => { clearTimeout(timer); resolve(token); });
    try { tokenWorker().postMessage({ id, videoId: binding }); }
    catch { clearTimeout(timer); waiting.delete(id); resolve(null); }
  });
}

// Caminho rápido para o servidor: só devolve o link se a música INTEIRA tocar.
// O token anti-robô vinculado à música é o que libera o resto da música (sem ele, só o 1º MB).
// O primeiro token leva ~3s (prepara o navegador simulado); os seguintes saem na hora.
async function fastAudio(videoId, { cookiesFile = '' } = {}) {
  const result = await resolveAudio(videoId, { playerClient: 'MWEB', cookiesFile });
  const token = await poToken(videoId);
  if (token) {
    const url = `${result.url}&pot=${encodeURIComponent(token)}`;
    if (await wholeSong(url)) return { ...result, url, withToken: true };
  }
  return (await wholeSong(result.url)) ? result : null;
}

// ---------- Outra versão da mesma música ----------
// Quando o YouTube bloqueia um vídeo, muitas vezes libera outra versão da mesma música
// (áudio oficial do canal do artista, clipe, versão com letra).
const { songIdentity, sameSong, sameArtist, durationSeconds } = require('./song-match');

async function findAlternative(videoId, { cookiesFile = '', search, tries = 3 } = {}) {
  if (typeof search !== 'function') return null;
  const yt = await client(cookieHeader(cookiesFile));
  const info = await yt.getBasicInfo(videoId, { client: 'MWEB' });
  const wanted = songIdentity(info.basic_info?.title, info.basic_info?.author);
  const length = Number(info.basic_info?.duration) || 0;
  if (!wanted.title) return null;
  const results = await search(`${wanted.title} ${wanted.artist}`.trim());
  const candidates = (results || [])
    .filter(item => item.videoId && item.videoId !== videoId && sameSong(item, wanted))
    // Duração parecida (até 45s de diferença) quando dá para saber.
    .filter(item => !length || !durationSeconds(item.duration) || Math.abs(durationSeconds(item.duration) - length) <= 45)
    // Mesmo artista primeiro.
    .sort((a, b) => Number(sameArtist(b, wanted)) - Number(sameArtist(a, wanted)))
    .slice(0, tries);
  for (const candidate of candidates) {
    const found = await fastAudio(candidate.videoId, { cookiesFile }).catch(() => null);
    if (found) {
      console.log(`🔁 Música [${videoId}] bloqueada; tocando outra versão: ${candidate.title} — ${candidate.artist}`);
      return { ...found, alternativeVideoId: candidate.videoId };
    }
  }
  return null;
}

// Prepara o gerador de token ao ligar o servidor, para a primeira música não esperar ~3s.
function warmUp() {
  poToken('dQw4w9WgXcQ').catch(() => {});
}

module.exports = { resolveAudio, cookieHeader, explain, fastAudio, findAlternative, songIdentity, sameSong, warmUp, CLIENTS };
