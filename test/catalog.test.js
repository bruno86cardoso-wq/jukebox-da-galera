const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYtMusicResults } = require('../lib/catalog');

const runs = (...texts) => ({ runs: texts.flatMap((t, i) => (i ? [{ text: ' • ' }, { text: t }] : [{ text: t }])) });
const row = (videoId, title, ...subtitle) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: videoId ? { videoId } : undefined,
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: runs(...subtitle) } }
    ]
  }
});

test('busca do YouTube Music: só músicas e vídeos, com artista e duração certos', () => {
  const data = { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicCardShelfRenderer: {
      title: { runs: [{ text: 'Thiaguinho' }] },
      subtitle: runs('Artista', '5 mi ouvintes mensais'),
      contents: [row('aaaaaaaaaaa', 'Caixa Postal (Ao Vivo)', 'Música', '2:50')]
    } },
    { itemSectionRenderer: { contents: [
      row('bbbbbbbbbbb', 'Dividido', 'Música', 'Thiaguinho', '3:41'),
      row('ccccccccccc', 'Vacilo do cantor', 'Episódio', '21 de jul. de 2023', 'Cortes'),
      row('ddddddddddd', 'História De Amor (Ao Vivo)', 'Vídeo', 'Thiaguinho', '2,7 mi de visualizações'),
      row(null, 'Ousadia & Alegria', 'Álbum', 'Thiaguinho', '2012')
    ] } }
  ] } } } }] } } };

  const items = parseYtMusicResults(data);
  assert.deepEqual(items.map(i => [i.title, i.artist, i.duration]), [
    ['Caixa Postal (Ao Vivo)', 'Thiaguinho', '2:50'],
    ['Dividido', 'Thiaguinho', '3:41'],
    ['História De Amor (Ao Vivo)', 'Thiaguinho', '']
  ]);
});

test('busca mostra quantas vezes a música tocou', () => {
  const { readPlays } = require('../lib/catalog');
  assert.deepEqual(readPlays(['Música', '4:55', 'Tocou 3,4 bi vezes']), { plays: '3,4 bi', playCount: 3400000000 });
  assert.deepEqual(readPlays(['Vídeo', 'Thiaguinho', '2,6 mi de visualizações']), { plays: '2,6 mi', playCount: 2600000 });
  assert.deepEqual(readPlays(['Tocou 136 mil vezes']), { plays: '136 mil', playCount: 136000 });
  assert.deepEqual(readPlays(['Música', 'Anitta', '3:13']), { plays: '', playCount: 0 });
});

test('busca por artista: os maiores sucessos dele vêm primeiro', () => {
  const { rankArtistHits } = require('../lib/catalog');
  const ranked = rankArtistHits([
    { title: 'Bad', artist: 'Michael Jackson', playCount: 341e6 },
    { title: 'Live', artist: 'allanwv', playCount: 196e6 },
    { title: 'Billie Jean', artist: 'Michael Jackson', playCount: 3.4e9 },
    { title: 'Thriller', artist: 'Michael Jackson', playCount: 415e6 }
  ], 'Michael Jackson');
  assert.deepEqual(ranked.map(s => s.title), ['Billie Jean', 'Thriller', 'Bad', 'Live']);
  assert.deepEqual(ranked.map(s => !!s.hit), [true, true, true, false]);
});
