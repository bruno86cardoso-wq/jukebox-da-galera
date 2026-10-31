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
