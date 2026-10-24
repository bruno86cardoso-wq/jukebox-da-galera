const { randomBytes } = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const { createJukebox } = require('../server');

// Cliente mínimo do protocolo Socket.IO sobre WebSocket, sem dependência de teste extra.
async function connect(port, token = randomBytes(32).toString('hex')) {
  const events = new EventEmitter();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  let id = 0;
  const pending = new Map();
  const ready = once(events, 'ready');
  ws.addEventListener('error', () => events.emit('error', new Error('Falha no WebSocket de teste')));
  ws.addEventListener('message', ({ data }) => {
    if (data.startsWith('0')) ws.send('40' + JSON.stringify({ playerToken: token }));
    else if (data === '2') ws.send('3');
    else if (data.startsWith('40')) events.emit('ready');
    else if (data.startsWith('42')) {
      const [event, payload] = JSON.parse(data.slice(2));
      events.emit(event, payload);
    } else if (data.startsWith('43')) {
      const split = data.indexOf('[');
      const ack = Number(data.slice(2, split));
      pending.get(ack)?.(JSON.parse(data.slice(split))[0]);
      pending.delete(ack);
    }
  });
  await ready;
  return {
    events, token,
    call(event, payload) {
      return new Promise((resolve, reject) => {
        const ack = id++;
        const timer = setTimeout(() => reject(new Error(`Sem resposta: ${event}`)), 3000);
        pending.set(ack, value => { clearTimeout(timer); resolve(value); });
        ws.send('42' + ack + JSON.stringify([event, payload]));
      });
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
      ws.close();
      await closed;
    }
  };
}

async function fixture(t, options = {}) {
  const jukebox = createJukebox({ port: 0, bind: '127.0.0.1', hostPin: '12345678', tunnel: false,
    statePath: null, media: { resolveStreamUrl: async () => null, serve: (_, res) => res.status(503).end() }, ...options });
  const port = await jukebox.start();
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await jukebox.stop(); });
  return { jukebox, port, async client(token) { const client = await connect(port, token); clients.push(client); return client; } };
}

const song = (id = 'abcdefghijk') => ({ videoId: id, title: 'Música de teste', artist: 'Artista', duration: '3:00' });
module.exports = { fixture, song };
