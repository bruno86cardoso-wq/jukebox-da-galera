const https = require('node:https');
const { execFile } = require('node:child_process');
const { createMedia } = require('./media');
const { validVideoId } = require('./security');

function sample(url) {
  return new Promise(resolve => {
    const request = https.get(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, response => {
      response.once('data', chunk => {
        resolve({ status: response.statusCode, type: response.headers['content-type'], bytes: chunk.length });
        response.destroy();
      });
      response.once('end', () => resolve({ status: response.statusCode, bytes: 0 }));
      response.on('error', () => resolve({ status: response.statusCode, bytes: 0 }));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve({ status: 0, bytes: 0 }));
  });
}

// Opt-in operacional, sem cookies e sem expor URLs de mídia nos logs.
async function runMediaDiagnostics(binary, videoId) {
  if (!validVideoId(videoId)) throw new Error('Vídeo de diagnóstico inválido.');
  execFile(binary, ['--version'], { timeout: 5000 }, (error, output) => {
    console.log('DIAG runtime ' + JSON.stringify({ node: process.version, extractor: error ? 'indisponível' : output.trim() }));
  });
  for (const [client, kind] of [['mweb', 'audio']]) {
    const started = Date.now();
    const media = createMedia(binary, { origin: '', playerClient: client, maxConcurrent: 1, diagnostics: true });
    const result = await media.resolveStreamUrl(videoId, kind);
    const playback = result ? await sample(result.url) : null;
    console.log('DIAG native ' + JSON.stringify({ client, kind, extracted: Boolean(result), playback, elapsedMs: Date.now() - started }));
  }
}

module.exports = { runMediaDiagnostics };
