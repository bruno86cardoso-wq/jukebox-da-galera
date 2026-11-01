// Busca o link de áudio pelo YouTube.js, dentro do próprio app (sem abrir o yt-dlp a cada música).
// Experimental: por enquanto só o diagnóstico usa, para medir antes de ligar nas músicas da festa.
const fs = require('node:fs');
const https = require('node:https');
const vm = require('node:vm');

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
  return { url, itag: format.itag, mime: format.mime_type };
}

function probe(url) {
  return new Promise(resolve => {
    const request = https.get(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, response => {
      resolve(response.statusCode);
      response.destroy();
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(0));
  });
}

// Diagnóstico: tempo, se o link toca e memória, sem devolver o link nem dados da conta.
async function explain(videoId, { playerClient = 'MWEB', cookiesFile = '' } = {}) {
  const chosen = CLIENTS.includes(playerClient) ? playerClient : 'MWEB';
  const started = Date.now();
  try {
    const result = await resolveAudio(videoId, { playerClient: chosen, cookiesFile });
    const playable = await probe(result.url);
    return { ok: playable === 206, engine: 'youtubei', playerClient: chosen, usingCookies: Boolean(cookieHeader(cookiesFile)),
      playable, itag: result.itag, mime: String(result.mime || '').split(';')[0],
      seconds: Math.round((Date.now() - started) / 100) / 10, memoryMB: Math.round(process.memoryUsage().rss / 1e6) };
  } catch (error) {
    return { ok: false, engine: 'youtubei', playerClient: chosen, usingCookies: Boolean(cookieHeader(cookiesFile)),
      reason: String(error?.message || error).replace(/https?:\/\/\S+/g, '[link]').slice(0, 200),
      seconds: Math.round((Date.now() - started) / 100) / 10, memoryMB: Math.round(process.memoryUsage().rss / 1e6) };
  }
}

module.exports = { resolveAudio, cookieHeader, explain, CLIENTS };
