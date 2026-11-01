// Gera o "PO token" (prova anti-robô do YouTube) numa thread separada do app.
// O código de verificação do YouTube (BotGuard) precisa de um navegador simulado (jsdom) e mexe no
// escopo global; aqui ele fica isolado, sem confundir o servidor da festa. Segue o exemplo oficial da BgUtils.
import { parentPort } from 'node:worker_threads';
import { JSDOM, VirtualConsole } from 'jsdom';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, parseLooseJSON, getHeaders, USER_AGENT } from 'bgutils-js/utils';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
let minterPromise = null;
let minterExpiresAt = 0;

async function createMinter() {
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
    // Avisos do navegador simulado (ex.: canvas não implementado) não interessam ao servidor.
    virtualConsole: new VirtualConsole()
  });
  const page = await fetch('https://www.youtube.com', {
    headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT }
  }).then(response => response.text());
  const ytConfig = page.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!ytConfig) throw new Error('ytcfg não encontrado');
  dom.window.yt = { config_: JSON.parse(ytConfig) };
  Object.assign(globalThis, {
    yt: dom.window.yt, window: dom.window, document: dom.window.document,
    location: dom.window.location, origin: dom.window.origin
  });
  if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });

  const attestation = page.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
  if (!attestation) throw new Error('desafio não encontrado');
  const challenge = parseLooseJSON(attestation[1]).R;
  if (!challenge?.bgChallenge) throw new Error('desafio vazio');
  const interpreterUrl = challenge.bgChallenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  const interpreter = await fetch(`https:${interpreterUrl}`).then(response => response.text());
  if (!interpreter) throw new Error('interpretador vazio');
  new Function(interpreter)();

  const botGuard = await BotGuardClient.create({
    program: challenge.bgChallenge.program,
    globalName: challenge.bgChallenge.globalName,
    globalObject: globalThis
  });
  const webPoSignalOutput = [];
  const botguardResponse = await botGuard.snapshot({ webPoSignalOutput });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await fetch(buildURL('GenerateIT', true), {
    method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, botguardResponse])
  }).then(response => response.json());
  // Renova um pouco antes de vencer (o YouTube informa a validade).
  minterExpiresAt = Date.now() + Math.max(60, (estimatedTtlSecs || 3600) - (mintRefreshThreshold || 300)) * 1000;
  return WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken }, webPoSignalOutput);
}

function minter() {
  if (!minterPromise || Date.now() > minterExpiresAt) {
    minterPromise = createMinter().catch(error => { minterPromise = null; throw error; });
  }
  return minterPromise;
}

parentPort.on('message', async ({ id, videoId }) => {
  try {
    const token = await (await minter()).mintAsWebsafeString(videoId);
    parentPort.postMessage({ id, token });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error).slice(0, 200) });
  }
});
