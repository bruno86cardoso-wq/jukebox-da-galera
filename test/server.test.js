const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture, song } = require('./helpers');

test('convidados não controlam anfitrião e payloads inválidos não derrubam o servidor', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const event of ['registerPlayer', 'addSong', 'voteSong', 'hostAction', 'sendReaction', 'registerTv']) {
    assert.equal((await client.call(event, null)).ok, false);
  }
  assert.equal((await client.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } })).ok, false);
  assert.equal((await client.call('registerTv', {})).ok, false);
  assert.equal((await client.call('authenticateHost', { pin: 'wrong' })).ok, false);
  assert.equal((await client.call('authenticateHost', { pin: '12345678' })).ok, true);
  assert.equal((await client.call('hostAction', { action: 'setMode' })).ok, false);
  assert.equal((await client.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } })).ok, true);
  assert.equal(f.jukebox.getPublicState().mode, 'desafio');
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/health`)).status, 200);
});

test('identidade vem da sessão, e votos respeitam modo, música e duplicidade', async t => {
  const f = await fixture(t);
  const alice = await f.client();
  const bob = await f.client();
  const a = (await alice.call('registerPlayer', { name: 'Alice' })).player;
  const b = (await bob.call('registerPlayer', { name: 'Bob', playerId: a.id })).player;
  assert.notEqual(a.id, b.id);
  await alice.call('authenticateHost', { pin: '12345678' });
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

test('duas pessoas conseguem vetar e apenas o aparelho ativo encerra músicas', async t => {
  const f = await fixture(t);
  const alice = await f.client();
  const bob = await f.client();
  await alice.call('registerPlayer', { name: 'Alice' });
  await bob.call('registerPlayer', { name: 'Bob' });
  await alice.call('authenticateHost', { pin: '12345678' });
  await bob.call('authenticateHost', { pin: '12345678' });
  await alice.call('hostAction', { action: 'setMode', payload: { mode: 'desafio' } });
  await alice.call('addSong', { song: song() });
  const current = f.jukebox.getPublicState().currentSong;
  assert.equal(current.dislikeThreshold, 1);
  await alice.call('registerTv', {});
  const deactivated = once(alice.events, 'tvDeactivated');
  await bob.call('registerTv', {});
  await deactivated;
  assert.equal((await alice.call('hostAction', { action: 'songEnded', payload: { songId: current.id } })).ok, false);
  assert.equal((await bob.call('voteSong', { type: 'dislike', songId: current.id })).ok, true);
  assert.equal(f.jukebox.getPublicState().currentSong, null);
  assert.equal(f.jukebox.getPublicState().history[0].wasVetoed, true);
});

test('fechar uma aba não desconecta a outra; reconexão preserva identidade', async t => {
  const f = await fixture(t);
  const one = await f.client();
  const two = await f.client(one.token);
  const player = (await one.call('registerPlayer', { name: 'Alice' })).player;
  const same = (await two.call('registerPlayer', { name: 'Alice' })).player;
  assert.equal(same.id, player.id);
  await one.close();
  await two.call('registerPlayer', { name: 'Alice' });
  assert.equal(f.jukebox.getPublicState().totalParticipants, 1);
  assert.equal(f.jukebox.getPublicState().players[0].connected, true);
});

test('fila e participantes são recuperados com reprodução pausada', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-test-'));
  const statePath = path.join(folder, 'party.json');
  // Registrado primeiro: a limpeza é feita depois do encerramento das fixtures abaixo.
  const first = await fixture(t, { statePath });
  const client = await first.client();
  const player = (await client.call('registerPlayer', { name: 'Persistente' })).player;
  await client.call('addSong', { song: song() });
  await client.call('addSong', { song: song('lmnopqrstuv') });
  await first.jukebox.stop();
  const second = await fixture(t, { statePath });
  const state = second.jukebox.getPublicState();
  assert.equal(state.currentSong.videoId, 'abcdefghijk');
  assert.equal(state.queue.length, 1);
  assert.equal(state.isPaused, true);
  assert.equal(state.players[0].connected, false);
  const reconnected = await second.client(client.token);
  assert.equal((await reconnected.call('registerPlayer', { name: 'Persistente' })).player.id, player.id);
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
});

test('busca rejeita parâmetros inválidos e pedidos validam ID e metadados', async t => {
  const f = await fixture(t);
  const client = await f.client();
  await client.call('registerPlayer', { name: 'Alice' });
  assert.equal((await client.call('addSong', { song: song('invalid') })).ok, false);
  assert.equal((await client.call('addSong', { song: { ...song(), title: {} } })).ok, false);
  const result = await client.call('addSong', { song: { ...song(), thumbnail: 'javascript:alert(1)' } });
  assert.equal(result.song.thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/search?q=a&q=b`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/search?q=`)).status, 200);
});
