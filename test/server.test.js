const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, song } = require('./helpers');

const settle = () => new Promise(resolve => setTimeout(resolve, 40));

test('payloads inválidos não derrubam o servidor e comandos são aceitos', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const event of ['createParty', 'joinParty', 'registerPlayer', 'addSong', 'voteSong', 'hostAction', 'sendReaction', 'registerTv']) {
    assert.equal((await client.call(event, null)).ok, false);
  }
  assert.equal((await client.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } })).ok, false, 'sem festa não há comando');
  const host = await f.host();
  assert.equal((await host.call('hostAction', { action: 'setMode' })).ok, false);
  assert.equal((await host.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } })).ok, true);
  assert.equal(f.jukebox.getPublicState(host.code).mode, 'desafio');
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/health`)).status, 200);
});

test('festas são isoladas e códigos desconhecidos são recusados', async t => {
  const f = await fixture(t);
  const a = await f.host();
  const b = await f.host();
  assert.notEqual(a.code, b.code);
  assert.match(a.code, /^[A-Z0-9]{4}$/);
  await a.call('registerPlayer', { name: 'Ana' });
  await b.call('registerPlayer', { name: 'Beto' });
  await a.call('addSong', { song: song() });
  assert.equal(f.jukebox.getPublicState(a.code).currentSong.videoId, 'abcdefghijk');
  assert.equal(f.jukebox.getPublicState(b.code).currentSong, null);
  assert.equal(f.jukebox.getPublicState(b.code).players.length, 1);
  // A mesma música pode tocar em outra festa.
  assert.equal((await b.call('addSong', { song: song() })).ok, true);

  const lost = await f.client();
  const result = await lost.call('joinParty', { code: 'ZZZZ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /não encontrada/);
  // Código com minúsculas e espaços funciona.
  assert.equal((await lost.call('joinParty', { code: ` ${a.code.toLowerCase()} ` })).ok, true);
  await settle();
  assert.equal(lost.state.code, a.code);
  assert.ok(lost.state.connection.activeQrUrl.endsWith(`/?festa=${a.code}`));
});

test('convidado controla a música se o anfitrião deixar, mas não as configurações', async t => {
  const f = await fixture(t);
  const host = await f.host();
  const guest = await f.guest(host.code);
  await host.call('registerPlayer', { name: 'Anfitrião' });
  await guest.call('registerPlayer', { name: 'Convidado' });
  await host.call('addSong', { song: song() });
  await host.call('addSong', { song: song('lmnopqrstuv') });

  assert.equal((await guest.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } })).ok, false);
  assert.equal((await guest.call('hostAction', { action: 'setTheme', payload: { theme: 'Funk' } })).ok, false);
  assert.equal((await guest.call('hostAction', { action: 'skipSong' })).ok, true);
  assert.equal(f.jukebox.getPublicState(host.code).currentSong.videoId, 'lmnopqrstuv');
  assert.equal((await guest.call('registerTv', {})).ok, true);

  assert.equal((await host.call('hostAction', { action: 'setSettings', payload: { guestsControl: false } })).ok, true);
  assert.equal((await guest.call('hostAction', { action: 'togglePause' })).ok, false);
  assert.equal((await guest.call('registerTv', {})).ok, false);
  await settle();
  assert.equal(guest.you.canControl, false);
  assert.equal(host.you.canControl, true);
  assert.equal(host.you.isHost, true);

  // Chave errada não vira anfitrião.
  const intruder = await f.client();
  assert.equal((await intruder.call('joinParty', { code: host.code, hostKey: 'f'.repeat(48) })).isHost, false);
});

test('convidado remove só os próprios pedidos', async t => {
  const f = await fixture(t);
  const host = await f.host();
  const guest = await f.guest(host.code);
  await host.call('registerPlayer', { name: 'Ana' });
  await guest.call('registerPlayer', { name: 'Bia' });
  await host.call('addSong', { song: song() });
  const mine = (await guest.call('addSong', { song: song('lmnopqrstuv') })).song;
  const hosts = (await host.call('addSong', { song: song('qwertyuiopa') })).song;
  assert.equal((await guest.call('hostAction', { action: 'removeQueueItem', payload: { songId: hosts.id } })).ok, false);
  assert.equal((await guest.call('hostAction', { action: 'removeQueueItem', payload: { songId: mine.id } })).ok, true);
  assert.deepEqual(f.jukebox.getPublicState(host.code).queue.map(s => s.id), [hosts.id]);
});

test('identidade vem da sessão, e votos respeitam modo, música e duplicidade', async t => {
  const f = await fixture(t);
  const alice = await f.host();
  const bob = await f.guest(alice.code);
  const a = (await alice.call('registerPlayer', { name: 'Alice' })).player;
  const b = (await bob.call('registerPlayer', { name: 'Bob', playerId: a.id })).player;
  assert.notEqual(a.id, b.id);
  await alice.call('addSong', { song: song(), playerId: b.id });
  const current = f.jukebox.getPublicState().currentSong;
  assert.equal(current.addedBy.id, a.id);
  assert.equal((await bob.call('voteSong', { type: 'like', songId: current.id })).ok, false);
  await alice.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } });
  assert.equal((await bob.call('voteSong', { type: 'like', songId: 'old' })).ok, false);
  assert.equal((await alice.call('voteSong', { playerId: b.id, type: 'like', songId: current.id })).ok, false);
  assert.equal((await bob.call('voteSong', { type: 'like', songId: current.id })).ok, true);
  assert.equal((await bob.call('voteSong', { type: 'like', songId: current.id })).ok, false);
  assert.equal(f.jukebox.getPublicState().players.find(p => p.id === a.id).score, 10);
});

test('mistério não vaza quem pediu (nem pelo placar) até a revelação', async t => {
  const f = await fixture(t);
  const host = await f.host();
  const bob = await f.guest(host.code);
  const carol = await f.guest(host.code);
  await host.call('registerPlayer', { name: 'Host' });
  const b = (await bob.call('registerPlayer', { name: 'Bob' })).player;
  await carol.call('registerPlayer', { name: 'Carol' });
  await host.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } });
  await bob.call('addSong', { song: song() });
  await bob.call('addSong', { song: song('lmnopqrstuv') });
  await settle();

  const raw = JSON.stringify(host.state);
  assert.equal(host.state.currentSong.addedBy.id, 'mystery');
  assert.ok(!raw.includes('"realAddedById"'));
  assert.ok(host.state.queue.every(item => item.addedBy.id === 'mystery'));
  assert.ok(host.state.currentSong.pendingVoters.some(p => p.id === b.id), 'autor aparece como pendente para não ser deduzido');
  assert.equal(bob.you.currentIsMine, true);
  assert.equal(host.you.currentIsMine, false);
  assert.equal(bob.you.mySongIds.length, 1);
  assert.equal(host.you.mySongIds.length, 0);

  await carol.call('voteSong', { type: 'like', songId: host.state.currentSong.id });
  await settle();
  const bobRow = () => host.state.players.find(p => p.id === b.id);
  assert.equal(bobRow().score, 0, 'like não muda o placar do autor durante o mistério');
  assert.equal(bobRow().songsPlayed, 0);

  await host.call('hostAction', { action: 'skipSong' });
  await settle();
  assert.equal(bobRow().score, 10);
  assert.equal(bobRow().songsPlayed, 1);
  assert.equal(host.state.history[0].addedBy.id, b.id);
});

test('duas pessoas conseguem vetar e apenas o aparelho ativo encerra músicas', async t => {
  const f = await fixture(t);
  const alice = await f.host();
  const bob = await f.guest(alice.code);
  await alice.call('registerPlayer', { name: 'Alice' });
  await bob.call('registerPlayer', { name: 'Bob' });
  await alice.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } });
  await alice.call('addSong', { song: song() });
  const current = f.jukebox.getPublicState().currentSong;
  assert.equal(current.dislikeThreshold, 1);
  await alice.call('registerTv', {});
  const deactivated = once(alice.events, 'tvDeactivated');
  await bob.call('registerTv', {});
  await deactivated;
  assert.equal((await alice.call('hostAction', { action: 'songEnded', payload: { songId: current.id } })).ok, false);
  const achievement = once(bob.events, 'achievement');
  assert.equal((await bob.call('voteSong', { type: 'dislike', songId: current.id })).ok, true);
  assert.equal(f.jukebox.getPublicState().currentSong, null);
  assert.equal(f.jukebox.getPublicState().history[0].wasVetoed, true);
  const [unlocked] = await achievement;
  assert.ok(['abriuPista', 'sniper'].includes(unlocked.achievement.id));
});

test('voltar (⏮️) mantém a música interrompida no topo da fila', async t => {
  const f = await fixture(t);
  const ana = await f.host();
  const bia = await f.guest(ana.code);
  const caio = await f.guest(ana.code);
  await ana.call('registerPlayer', { name: 'Ana' });
  await bia.call('registerPlayer', { name: 'Bia' });
  await caio.call('registerPlayer', { name: 'Caio' });
  await ana.call('addSong', { song: song('aaaaaaaaaaa') });
  await bia.call('addSong', { song: song('bbbbbbbbbbb') });
  await caio.call('addSong', { song: song('ccccccccccc') });
  await ana.call('hostAction', { action: 'skipSong' });
  assert.equal(f.jukebox.getPublicState().currentSong.videoId, 'bbbbbbbbbbb');
  await ana.call('hostAction', { action: 'previousSong' });
  let state = f.jukebox.getPublicState();
  assert.equal(state.currentSong.videoId, 'aaaaaaaaaaa');
  assert.equal(state.queue[0].videoId, 'bbbbbbbbbbb');
  // Sem a fixação, a rodada colocaria o novo pedido da Ana na frente.
  await ana.call('addSong', { song: song('ddddddddddd') });
  state = f.jukebox.getPublicState();
  assert.equal(state.queue[0].videoId, 'bbbbbbbbbbb', 'continua no topo depois de novos pedidos');
  await ana.call('hostAction', { action: 'skipSong' });
  assert.equal(f.jukebox.getPublicState().currentSong.videoId, 'bbbbbbbbbbb');
});

test('dedicatória, rodada temática, conquistas e resumo da festa', async t => {
  const f = await fixture(t);
  const host = await f.host();
  const guest = await f.guest(host.code);
  await host.call('registerPlayer', { name: 'Bruno' });
  await guest.call('registerPlayer', { name: 'Mo' });
  await host.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } });
  const themeEvent = once(guest.events, 'themeChanged');
  assert.equal((await host.call('hostAction', { action: 'setTheme', payload: { theme: 'Anos 2000' } })).ok, true);
  assert.equal((await themeEvent)[0].theme, 'Anos 2000');
  assert.equal((await host.call('addSong', { song: song(), dedication: 'x'.repeat(61) })).ok, false);
  await host.call('addSong', { song: song(), dedication: 'Pra Mo 💘' });
  // Durante o mistério nenhuma conquista do pedido pode aparecer (entregaria o autor).
  assert.ok(f.jukebox.getPublicState().players.every(p => p.achievements.length === 0));
  const first = once(host.events, 'achievement');
  const current = f.jukebox.getPublicState().currentSong;
  assert.equal(current.dedication, 'Pra Mo 💘');
  assert.equal(current.theme, 'Anos 2000');
  await guest.call('voteSong', { type: 'like', songId: current.id });
  await host.call('hostAction', { action: 'skipSong' });
  assert.equal((await first)[0].achievement.id, 'abriuPista');

  const players = f.jukebox.getPublicState().players;
  const bruno = players.find(p => p.name === 'Bruno');
  assert.equal(bruno.score, 10 + 20 + 5, 'like + aprovação + bônus do tema');
  assert.ok(bruno.achievements.some(a => a.id === 'abriuPista'));

  const { summary } = await guest.call('getSummary', {});
  const titles = summary.cards.map(c => c.title);
  assert.ok(titles.includes('Hino da noite'));
  assert.ok(titles.includes('Rodadas temáticas'));
  assert.ok(summary.cards.some(c => c.icon === '💌'));
  assert.ok(summary.achievements.length >= 1);

  assert.equal((await guest.call('hostAction', { action: 'showSummary' })).ok, false);
  const shown = once(guest.events, 'partySummary');
  assert.equal((await host.call('hostAction', { action: 'showSummary' })).ok, true);
  assert.ok((await shown)[0].cards.length >= 3);
});

test('fechar uma aba não desconecta a outra; reconexão preserva identidade', async t => {
  const f = await fixture(t);
  const host = await f.host();
  const one = await f.guest(host.code);
  const two = await f.guest(host.code, one.token);
  const player = (await one.call('registerPlayer', { name: 'Alice' })).player;
  const same = (await two.call('registerPlayer', { name: 'Alice' })).player;
  assert.equal(same.id, player.id);
  await one.close();
  await settle();
  await two.call('registerPlayer', { name: 'Alice' });
  assert.equal(f.jukebox.getPublicState().totalParticipants, 1);
  assert.equal(f.jukebox.getPublicState().players[0].connected, true);
});

test('festas, fila e chave do anfitrião sobrevivem a reinício', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-test-'));
  const first = await fixture(t, { dataDir });
  const client = await first.host();
  const player = (await client.call('registerPlayer', { name: 'Persistente' })).player;
  await client.call('addSong', { song: song() });
  await client.call('addSong', { song: song('lmnopqrstuv') });
  await first.jukebox.stop();
  assert.ok(fs.existsSync(path.join(dataDir, 'parties', `${client.code}.json`)));
  const second = await fixture(t, { dataDir });
  const state = second.jukebox.getPublicState(client.code);
  assert.equal(state.currentSong.videoId, 'abcdefghijk');
  assert.equal(state.queue.length, 1);
  assert.equal(state.isPaused, true);
  assert.equal(state.players[0].connected, false);
  const reconnected = await second.client(client.token);
  assert.equal((await reconnected.call('joinParty', { code: client.code, hostKey: client.hostKey })).isHost, true);
  assert.equal((await reconnected.call('registerPlayer', { name: 'Persistente' })).player.id, player.id);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
});

test('busca rejeita parâmetros inválidos e pedidos validam ID e metadados', async t => {
  const f = await fixture(t);
  const client = await f.host();
  await client.call('registerPlayer', { name: 'Alice' });
  assert.equal((await client.call('addSong', { song: song('invalid') })).ok, false);
  assert.equal((await client.call('addSong', { song: { ...song(), title: {} } })).ok, false);
  const result = await client.call('addSong', { song: { ...song(), thumbnail: 'javascript:alert(1)' } });
  assert.equal(result.song.thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/search?q=a&q=b`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/search?q=`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/qrcode?festa=NOPE`)).status, 404);
  const qr = await (await fetch(`http://127.0.0.1:${f.port}/api/qrcode?festa=${client.code}`)).json();
  assert.ok(qr.url.endsWith(`?festa=${client.code}`));
  const hostQr = await (await fetch(`http://127.0.0.1:${f.port}/api/qrcode?festa=${client.code}&chave=${client.hostKey}`)).json();
  assert.ok(hostQr.url.includes(`chave=${client.hostKey}`));
  const fakeQr = await (await fetch(`http://127.0.0.1:${f.port}/api/qrcode?festa=${client.code}&chave=abc`)).json();
  assert.ok(!fakeQr.url.includes('chave'));
});
