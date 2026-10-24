const { spawn } = require('node:child_process');
const http = require('node:http');

// O provedor aceita apenas conexões internas ao contêiner.
const useProvider = process.env.YTDLP_CLIENT === 'mweb' || Boolean(process.env.MEDIA_DIAGNOSTICS_VIDEO);
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
provider?.on('error', () => stop(1));
provider?.on('exit', code => { if (!stopping) stop(code || 1); });
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
    if (Date.now() >= deadline) throw new Error('Provedor de áudio não iniciou.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (stopping) return;
  app = spawn(process.execPath, ['server.js'], { cwd: '/app', stdio: 'inherit' });
  app.on('error', () => stop(1));
  app.on('exit', code => stop(code || 0));
})().catch(error => { console.error(error.message); stop(1); });
