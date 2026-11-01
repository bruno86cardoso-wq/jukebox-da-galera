const test = require('node:test');
const assert = require('node:assert/strict');
const { createParty } = require('../lib/party');

const song = id => ({ videoId: id, title: 'Música', artist: 'Artista', duration: '3:00' });

test('Desafio: votação abre aos 30s e quem pediu só aparece aos 60s', () => {
  let clock = 1_000_000;
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null, now: () => clock });
  party.join('ana', 'Ana');
  party.join('bia', 'Bia');
  party.control('setMode', { mode: 'desafio' }, { isHost: true });
  party.addSong('bia', song('aaaaaaaaaaa'));
  const current = () => party.publicState({}).currentSong;

  assert.equal(current().votingOpen, false);
  assert.equal(current().voteOpensInSeconds, 30);
  assert.throws(() => party.vote('ana', 'like', current().id), /votação abre em 30s/);
  // Antes de a votação abrir, pedir música continua liberado.
  party.addSong('ana', song('bbbbbbbbbbb'));

  clock += 30_000;
  party.tick();
  assert.equal(current().votingOpen, true);
  assert.equal(current().isRevealed, false, 'mistério continua depois que a votação abre');
  assert.throws(() => party.addSong('ana', song('ccccccccccc')), /Vote na música/);
  party.vote('ana', 'like', current().id);

  clock += 30_000;
  party.tick();
  assert.equal(current().isRevealed, true);
  assert.equal(current().addedBy.name, 'Bia');
});

test('rádio: fila vazia toca parecida; pedido novo vem em seguida; depois a rádio volta', async () => {
  let clock = 1_000_000;
  const seeds = [];
  const radio = async seed => {
    seeds.push(seed);
    return ['r1aaaaaaaaa', 'r2aaaaaaaaa', 'r3aaaaaaaaa'].map(id => ({ videoId: id, title: 'Parecida ' + id.slice(0, 2), artist: 'Rádio', duration: '3:00' }));
  };
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null, now: () => clock, radio });
  party.join('ana', 'Ana');
  party.join('bia', 'Bia');
  const current = () => party.publicState({}).currentSong;
  const settle = () => new Promise(resolve => setImmediate(resolve));

  party.addSong('ana', song('aaaaaaaaaaa'));
  party.control('songEnded', { songId: current().id }, { isActivePlayer: true });
  await settle();
  assert.equal(current().isRadio, true, 'fila vazia: entra a rádio');
  assert.equal(seeds[0], 'aaaaaaaaaaa', 'rádio parecida com a última pedida');
  assert.equal(current().addedBy.name, '📻 Rádio');
  const radioId = current().videoId;

  party.addSong('bia', song('bbbbbbbbbbb'));
  assert.equal(current().videoId, radioId, 'a da rádio termina de tocar');
  assert.equal(party.publicState({}).queue[0].videoId, 'bbbbbbbbbbb', 'a pedida vem em seguida');
  party.control('songEnded', { songId: current().id }, { isActivePlayer: true });
  assert.equal(current().videoId, 'bbbbbbbbbbb');

  party.control('songEnded', { songId: current().id }, { isActivePlayer: true });
  await settle();
  assert.equal(current().isRadio, true, 'ninguém pediu: a rádio volta');
  assert.equal(seeds.at(-1), 'bbbbbbbbbbb', 'agora no estilo da última pedida');
  assert.notEqual(current().videoId, radioId, 'não repete a da rádio');

  party.control('setSettings', { autoRadio: false }, { isHost: true });
  party.control('songEnded', { songId: current().id }, { isActivePlayer: true });
  await settle();
  assert.equal(current(), null, 'rádio desligada: silêncio');
});

test('rádio no Desafio: sem votação, sem mistério e não trava pedidos', async () => {
  const radio = async () => [{ videoId: 'r1aaaaaaaaa', title: 'Parecida', artist: 'Rádio', duration: '3:00' }];
  let clock = 1_000_000;
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null, now: () => clock, radio });
  party.join('ana', 'Ana');
  party.join('bia', 'Bia');
  party.control('setMode', { mode: 'desafio' }, { isHost: true });
  party.addSong('ana', song('aaaaaaaaaaa'));
  party.control('songEnded', { songId: party.publicState({}).currentSong.id }, { isActivePlayer: true });
  await new Promise(resolve => setImmediate(resolve));
  const current = party.publicState({}).currentSong;
  assert.equal(current.isRadio, true);
  assert.equal(current.isRevealed, true);
  clock += 40_000;
  assert.equal(party.publicState({}).currentSong.votingOpen, false);
  assert.throws(() => party.vote('bia', 'like', current.id), /rádio/);
  party.addSong('bia', song('bbbbbbbbbbb'));
  party.control('skipSong', {}, { playerId: 'bia' });
  assert.equal(party.publicState({}).currentSong.videoId, 'bbbbbbbbbbb', 'convidado pode pular a da rádio');
});

test('rádio deixa 5 engatilhadas: pular entra na hora e repõe o estoque', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `r${String(i).padStart(2, '0')}aaaaaaaa`);
  let calls = 0;
  const radio = async () => { calls++; return ids.map(id => ({ videoId: id, title: 'Rádio ' + id.slice(0, 3), artist: 'Rádio', duration: '3:00' })); };
  const resolved = [];
  const media = { resolveStreamUrl: async (id) => { resolved.push(id); return null; } };
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media, radio });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  party.join('ana', 'Ana');
  party.addSong('ana', song('aaaaaaaaaaa'));
  await settle(); await settle();
  const st = () => party.publicState({});
  assert.ok(st().upcomingRadio, 'com a fila vazia, já mostra a próxima da rádio');
  const first = st().upcomingRadio.videoId;
  assert.ok(resolved.includes(first), 'áudio da próxima já foi preparado');

  party.control('songEnded', { songId: st().currentSong.id }, { isActivePlayer: true });
  assert.equal(st().currentSong.videoId, first, 'entra na hora, sem esperar a busca');
  const played = new Set([first]);
  for (let i = 0; i < 8; i++) {
    await settle(); await settle();
    party.control('skipSong', {}, { isHost: true });
    const now = st().currentSong;
    assert.equal(now.isRadio, true, 'sempre tem uma engatilhada');
    assert.ok(!played.has(now.videoId), 'não repete');
    played.add(now.videoId);
  }
  assert.ok(calls <= 12, 'busca a rádio de novo só para repor');
});

test('duração exata do YouTube substitui a da busca (fila e música tocando)', async () => {
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null, lookupDuration: async id => (id === 'aaaaaaaaaaa' ? 203 : 3725) });
  party.join('ana', 'Ana');
  party.addSong('ana', { videoId: 'aaaaaaaaaaa', title: 'Levitating', artist: 'Dua Lipa', duration: '' });
  party.addSong('ana', { videoId: 'bbbbbbbbbbb', title: 'Longa', artist: 'X', duration: '3:00' });
  await new Promise(resolve => setImmediate(resolve));
  const st = party.publicState({});
  assert.equal(st.currentSong.duration, '3:23');
  assert.equal(st.queue[0].duration, '1:02:05');
});

test('mesmo nome: pergunta se é a mesma pessoa; se for, junta; se não, vira "Monique 2"', () => {
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null });
  party.join('cel-1', 'Monique');
  party.addSong('cel-1', song('aaaaaaaaaaa'));
  // Entrou de novo pelo link do WhatsApp (outro navegador, outra identidade).
  assert.deepEqual(party.join('whats-1', 'monique'), { needsConfirm: true, name: 'Monique' });
  const back = party.join('whats-1', 'monique', { sameAs: true });
  assert.equal(back.id, 'cel-1');
  // Voltando de novo pelo mesmo navegador: reconhece sem perguntar.
  assert.equal(party.join('whats-1', 'Monique').id, 'cel-1');
  // Outra Monique de verdade.
  const other = party.join('cel-2', 'Monique', { sameAs: false });
  assert.equal(other.name, 'Monique 2');
  const names = party.publicState({}).players.map(p => p.name).sort();
  assert.deepEqual(names, ['Monique', 'Monique 2']);
});

test('anfitrião arrasta música na fila e a ordem escolhida fica', () => {
  const party = createParty({ code: 'TEST', hostKeyHash: 'x', media: null });
  for (const who of ['ana', 'bia', 'caio']) party.join(who, who);
  party.addSong('ana', song('aaaaaaaaaaa'));      // tocando
  party.addSong('ana', song('bbbbbbbbbbb'));
  party.addSong('bia', song('ccccccccccc'));
  party.addSong('caio', song('ddddddddddd'));
  const order = () => party.publicState({}).queue.map(s => s.videoId[0]);
  assert.deepEqual(order(), ['c', 'd', 'b']);
  const id = party.publicState({}).queue[2].id;
  assert.throws(() => party.control('moveQueueItem', { songId: id, toIndex: 0 }, { isHost: false }), /anfitrião/);
  party.control('moveQueueItem', { songId: id, toIndex: 0 }, { isHost: true });
  assert.deepEqual(order(), ['b', 'c', 'd']);
  // Pedido novo entra depois da parte arrumada.
  party.addSong('bia', song('eeeeeeeeeee'));
  assert.deepEqual(order(), ['b', 'c', 'd', 'e']);
});
