const test = require('node:test');
const assert = require('node:assert/strict');
const { createMedia } = require('../lib/media');

test('extrações deduplicam, limitam concorrência e respeitam expiração', async () => {
  let now = 1000;
  const calls = [];
  const media = createMedia('fake', { now: () => now, maxConcurrent: 1, maxPending: 2,
    run: (file, args, options, done) => calls.push(done) });
  const one = media.resolveStreamUrl('abcdefghijk');
  assert.equal(media.resolveStreamUrl('abcdefghijk'), one);
  const two = media.resolveStreamUrl('lmnopqrstuv');
  assert.equal(calls.length, 1);
  assert.equal(await media.resolveStreamUrl('01234567890'), null);
  calls.shift()(null, 'https://example.test/audio?expire=3600');
  assert.equal((await one).url, 'https://example.test/audio?expire=3600');
  assert.equal(calls.length, 1);
  calls.shift()(new Error('Unavailable'));
  assert.equal(await two, null);
  assert.ok(await media.resolveStreamUrl('abcdefghijk'));
  assert.equal(calls.length, 0);
  now += 2 * 60 * 60 * 1000;
  const renewed = media.resolveStreamUrl('abcdefghijk');
  assert.equal(calls.length, 1);
  calls.shift()(null, 'https://example.test/new');
  assert.equal((await renewed).url, 'https://example.test/new');
});

test('áudio é extraído sozinho e falha de vídeo não invalida o áudio', async () => {
  const calls = [];
  const media = createMedia('fake', { run: (_, args, options, done) => calls.push({ args, done }) });
  const audio = media.resolveStreamUrl('abcdefghijk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('-f') + 1], 'bestaudio[ext=m4a]/bestaudio');
  calls[0].done(null, 'https://example.test/audio');
  const ready = await audio;
  assert.equal(ready.kind, 'audio');
  const video = media.resolveStreamUrl('abcdefghijk', 'video');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('-f') + 1], 'best[ext=mp4]/best');
  calls[1].done(new Error('No video format'));
  assert.equal(await video, null);
  assert.equal(await media.resolveStreamUrl('abcdefghijk'), ready);
  assert.equal(calls.length, 2);
});

test('origem externa entrega apenas o formato solicitado sem extrair no servidor de nuvem', async () => {
  let extractions = 0;
  const media = createMedia('fake', { origin: 'https://audio.example.test', run: () => extractions++ });
  const audio = await media.resolveStreamUrl('abcdefghijk');
  const video = await media.resolveStreamUrl('abcdefghijk', 'video');
  assert.equal(audio.url, 'https://audio.example.test/api/audio/abcdefghijk');
  assert.equal(video.url, 'https://audio.example.test/api/stream/abcdefghijk');
  assert.equal(extractions, 0);
  assert.equal(await media.resolveStreamUrl('../outside'), null);
});

test('origem de mídia rejeita protocolos, credenciais e caminhos inesperados', () => {
  for (const origin of ['http://audio.example.test', 'https://user:password@audio.example.test', 'https://audio.example.test/private', 'https://audio.example.test/?secret=1']) {
    assert.throws(() => createMedia('fake', { origin }));
  }
});

test('cliente de reprodução é selecionado com argumentos separados e lista permitida', async () => {
  let args;
  const media = createMedia('fake', { origin: '', playerClient: 'web_embedded', run: (_, values, options, done) => {
    args = values;
    done(null, 'https://example.test/audio');
  } });
  assert.ok(await media.resolveStreamUrl('abcdefghijk'));
  assert.deepEqual(args.slice(0, 2), ['--extractor-args', 'youtube:player_client=web_embedded']);
  assert.throws(() => createMedia('fake', { playerClient: 'arbitrary;command' }));
});

test('cliente mweb usa plugin local e permite o tempo inicial de validação', async () => {
  let captured;
  const media = createMedia('fake', { origin: '', playerClient: 'mweb', pluginDir: '/opt/ytdlp-plugins',
    run: (_, args, options, done) => {
      captured = { args, options };
      done(null, 'https://example.test/audio');
    } });
  assert.ok(await media.resolveStreamUrl('abcdefghijk'));
  assert.deepEqual(captured.args.slice(0, 4), ['--plugin-dirs', '/opt/ytdlp-plugins', '--extractor-args', 'youtube:player_client=mweb']);
  assert.equal(captured.options.timeout, 60000);
});
