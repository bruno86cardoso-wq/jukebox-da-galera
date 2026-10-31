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
