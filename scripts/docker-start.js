const { spawn } = require('node:child_process');
const http = require('node:http');

// O provedor de token (bgutil) aceita apenas conexões internas ao contêiner. Ele faz algumas músicas
// tocarem nos modos "web", mas junto com o app e o yt-dlp passa dos 512 MB do plano Starter e o servidor
// cai ao preparar uma música. Por isso fica desligado: YTDLP_TOKEN_PROVIDER=1 liga (só com mais memória).
const fs = require('node:fs');
const useProvider = process.env.YTDLP_TOKEN_PROVIDER === '1' && fs.existsSync('/opt/token-provider/build/main.js');
const provider = useProvider ? spawn(process.execPath,
  ['--max-old-space-size=192', '/opt/token-provider/build/main.js', '--host', '127.0.0.1', '--port', '4416'],
  { cwd: '/opt/token-provider', stdio: 'inherit' }) : null;
let app;
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  app?.kill('SIGTERM');
  provider?.kill('SIGTERM');
  const timer = setTimeout(() => { app?.kill('SIGKILL'); provider?.kill('SIGKILL'); process.exit(code); }, 5000);
  timer.unref();
  process.exitCode = code;
}
// O provedor ajuda, mas não é essencial: se cair, o app continua (só algumas músicas podem falhar).
provider?.on('error', error => console.warn('⚠️ Provedor de token indisponível:', error.message));
provider?.on('exit', code => { if (!stopping) console.warn(`⚠️ Provedor de token encerrou (código ${code}). O app continua sem ele.`); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));

function ping() {
  return new Promise(resolve => {
    const request = http.get('http://127.0.0.1:4416/ping', { timeout: 1000 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}
(async () => {
  const deadline = Date.now() + 45000;
  while (useProvider && !stopping && !(await ping())) {
    if (Date.now() >= deadline) {
      console.warn('⚠️ Provedor de token não respondeu a tempo. Iniciando o app sem ele.');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (stopping) return;
  app = spawn(process.execPath, ['server.js'], { cwd: '/app', stdio: 'inherit' });
  app.on('error', () => stop(1));
  app.on('exit', code => stop(code || 0));
})().catch(error => { console.error(error.message); stop(1); });
