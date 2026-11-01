const test = require('node:test');
const assert = require('node:assert/strict');
const { songIdentity, sameSong, sameArtist, durationSeconds } = require('../lib/song-match');

test('limpa o título do vídeo até sobrar música e artista', () => {
  assert.deepEqual(songIdentity('Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7 Soundtrack', 'Wiz Khalifa Music'),
    { title: 'See You Again', artist: 'Wiz Khalifa' });
  assert.deepEqual(songIdentity('Despacito', 'Luis Fonsi - Topic'), { title: 'Despacito', artist: 'Luis Fonsi' });
  assert.deepEqual(songIdentity('Anitta - Envolver (Official Music Video)', 'AnittaVEVO'), { title: 'Envolver', artist: 'Anitta' });
});

test('reconhece outra versão da mesma música e recusa cover, karaokê e música diferente', () => {
  const wanted = { title: 'See You Again', artist: 'Wiz Khalifa' };
  assert.equal(sameSong({ title: 'See You Again (part. Charlie Puth)' }, wanted), true);
  assert.equal(sameSong({ title: 'See You Again (Cover)' }, wanted), false);
  assert.equal(sameSong({ title: 'See You Again Karaoke' }, wanted), false);
  assert.equal(sameSong({ title: 'Young, Wild & Free' }, wanted), false);
  assert.equal(sameArtist({ artist: 'Wiz Khalifa' }, wanted), true);
  assert.equal(sameArtist({ artist: 'Outro Canal' }, wanted), false);
  assert.equal(durationSeconds('3:57'), 237);
  assert.equal(durationSeconds(''), 0);
});
