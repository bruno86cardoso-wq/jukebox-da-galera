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
