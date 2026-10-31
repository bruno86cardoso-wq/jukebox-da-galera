const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function browser(page) {
  const elements = new Map();
  const handlers = new Map();
  const timers = new Map();
  let timerId = 0;
  function element() {
    const listeners = new Map();
    return { style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
      textContent: '', innerHTML: '', value: '', paused: true, currentTime: 0, src: '',
      addEventListener(event, handler) { listeners.set(event, [...(listeners.get(event) || []), handler]); },
      removeEventListener(event, handler) { listeners.set(event, (listeners.get(event) || []).filter(fn => fn !== handler)); },
      dispatch(event) { for (const fn of listeners.get(event) || []) fn(); },
      setAttribute() {}, removeAttribute(name) { this[name] = ''; }, append() {}, appendChild() {},
      pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load() {}
    };
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, body: element(), documentElement: element(), querySelectorAll: () => []
  };
  const storage = new Map();
  const context = vm.createContext({ document, console, navigator: {}, URLSearchParams,
    history: { replaceState() {} },
    window: { location: { origin: 'http://localhost', href: 'http://localhost/', search: '', pathname: '/' } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ dataUrl: '', url: 'http://localhost' }) })
  });
  vm.runInContext(fs.readFileSync('public/common.js', 'utf8'), context);
  context.createPartySocket = () => ({ party: { code: 'TEST' }, on: (event, fn) => handlers.set(event, fn), emit() {},
    claimPlayback: async () => true, joinParty: async () => ({ ok: true, code: 'TEST' }) });
  if (page) vm.runInContext(fs.readFileSync(`public/${page}.js`, 'utf8'), context);
  return { context, elements, handlers, timers, element };
}

function state() {
  const name = '<img src=x onerror=alert(1)>';
  const owner = { id: 'owner', name, avatar: '🎸' };
  const song = { id: 'song', videoId: 'abcdefghijk', addedBy: owner, title: name, artist: name,
    thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', isRevealed: true,
    likesCount: 0, dislikesEffective: 0, dislikeThreshold: 1, pendingVoters: [owner], voterIds: [] };
  return { mode: 'livre', currentSong: song, queue: [song], players: [{ ...owner, ammo: 3, score: 0, songsPlayed: 1 }],
    connection: { activeQrUrl: 'http://localhost' }, totalParticipants: 2, fixedPlayerCount: 0, isPaused: false };
}

test('telão e celular escapam nomes e títulos ao montar HTML', () => {
  for (const page of ['tv', 'mobile']) {
    const b = browser(page);
    b.handlers.get('stateUpdate')(state());
    const queue = b.elements.get(page === 'tv' ? 'queueList' : 'mobQueueList').innerHTML;
    const ranking = b.elements.get(page === 'tv' ? 'rankingList' : 'mobRankList').innerHTML;
    assert.ok(queue.includes('&lt;img'));
    assert.ok(ranking.includes('&lt;img'));
    assert.ok(!queue.includes('<img src=x'));
    assert.ok(!ranking.includes('<img src=x'));
  }
});

test('celular interrompe e descarrega a mídia ao perder o controle do player', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  await vm.runInContext('toggleJblMode()', b.context);
  const video = b.elements.get('mobJblAudio');
  assert.equal(video.paused, false);
  assert.ok(video.src.includes('/api/audio/'));
  b.handlers.get('tvDeactivated')();
  assert.equal(video.paused, true);
  assert.equal(video.src, '');
});

function spySocket(b) {
  const sock = vm.runInContext('socket', b.context);
  const sent = [];
  sock.connected = true;
  sock.emit = (event, data) => { sent.push({ event, data }); };
  return { sock, sent };
}

test('queda de conexão não para a música e o fim dela é avisado ao reconectar', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  await vm.runInContext('toggleJblMode()', b.context);
  const audio = b.elements.get('mobJblAudio');
  const { sock, sent } = spySocket(b);
  sock.connected = false;
  b.handlers.get('disconnect')();
  assert.equal(audio.paused, false);
  assert.ok(audio.src.includes('/api/audio/'));
  audio.dispatch('ended');
  assert.equal(sent.length, 0);
  assert.equal(vm.runInContext('pendingEndedSongId', b.context), 'song');
  sock.connected = true;
  vm.runInContext('reportSongEnded(pendingEndedSongId)', b.context);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { event: 'hostAction', data: { action: 'songEnded', payload: { songId: 'song' } } });
});

test('erro do player do YouTube pula para a próxima música', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  await vm.runInContext('toggleJblMode()', b.context);
  const { sent } = spySocket(b);
  vm.runInContext('onMobYtError({ data: 150 })', b.context);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { event: 'hostAction', data: { action: 'songEnded', payload: { songId: 'song' } } });
});

test('celular toca só áudio e ignora pedido de clipe', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  await vm.runInContext('toggleJblMode()', b.context);
  const audio = b.elements.get('mobJblAudio');
  assert.ok(audio.src.startsWith('/api/audio/'));
  vm.runInContext("setJblMediaMode('video')", b.context);
  assert.equal(vm.runInContext('jblMediaMode', b.context), 'audio');
  assert.ok(audio.src.startsWith('/api/audio/'));
});

test('interface só informa tocando após o evento real de reprodução', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  await vm.runInContext('toggleJblMode()', b.context);
  const audio = b.elements.get('mobJblAudio');
  const badge = b.elements.get('playbackBadge');
  assert.equal(badge.textContent, 'CARREGANDO…');
  audio.dispatch('playing');
  assert.equal(badge.textContent, '▶ TOCANDO AQUI');
  audio.dispatch('error');
  assert.equal(badge.textContent, 'ÁUDIO INDISPONÍVEL');
  assert.equal(b.elements.get('btnResumeAudio').hidden, false);
});

test('bloqueio de autoplay mostra botão de toque direto para liberar áudio', async () => {
  const b = browser('mobile');
  b.handlers.get('stateUpdate')(state());
  const audio = b.elements.get('mobJblAudio');
  audio.play = () => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
  await vm.runInContext('toggleJblMode()', b.context);
  await Promise.resolve();
  assert.equal(b.elements.get('playbackBadge').textContent, 'TOQUE PARA OUVIR');
  assert.equal(b.elements.get('btnResumeAudio').hidden, false);
  let played = false;
  audio.play = () => { played = true; return Promise.resolve(); };
  vm.runInContext('resumeJblPlayback()', b.context);
  assert.equal(played, true);
});

test('recuperação limita tentativas e cancela retries ao mudar de música', () => {
  const b = browser();
  const video = b.element();
  let failures = 0;
  let plays = 0;
  const recovery = b.context.attachMediaRecovery(video, {
    isActive: () => true, source: () => '/api/audio/abcdefghijk', play: () => plays++, failed: () => failures++
  });
  function advance() { const [id, fn] = b.timers.entries().next().value; b.timers.delete(id); fn(); }
  video.dispatch('error');
  advance();
  video.dispatch('error');
  advance();
  video.dispatch('error');
  assert.equal(plays, 2);
  assert.equal(failures, 1);
  recovery.reset();
  video.dispatch('error');
  recovery.reset();
  // Só permanece o timer do aviso, sem uma nova tentativa de mídia.
  while (b.timers.size) advance();
  assert.equal(plays, 2);
});
