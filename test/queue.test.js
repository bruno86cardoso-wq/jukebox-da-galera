const test = require('node:test');
const assert = require('node:assert/strict');
const { rebalanceQueue } = require('../lib/queue');

const songsOf = ids => ids.map((id, i) => ({ id: i, addedBy: { id }, addedAt: i }));

test('Modo Livre: até duas músicas seguidas por pessoa e rebalanceamento é estável', () => {
  const state = { mode: 'livre', queue: songsOf(['A', 'A', 'A', 'B', 'B', 'B', 'C']), roundOrder: ['A', 'B', 'C'], currentStreakUserId: 'A', currentStreakCount: 1 };
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.addedBy.id), ['A', 'B', 'B', 'C', 'A', 'A', 'B']);
  const ids = state.queue.map(s => s.id);
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.id), ids);
  state.currentStreakCount = 2;
  rebalanceQueue(state);
  assert.equal(state.queue[0].addedBy.id, 'B');
});

test('Modo Desafio: rodízio de uma música por pessoa por vez', () => {
  // A está tocando agora; os próximos pedidos de A só voltam depois de todo mundo.
  const state = { mode: 'desafio', queue: songsOf(['A', 'A', 'A', 'B', 'B', 'B', 'C']), roundOrder: ['A', 'B', 'C'], currentStreakUserId: 'A', currentStreakCount: 1 };
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.addedBy.id), ['B', 'C', 'A', 'B', 'A', 'B', 'A']);
});

test('Desafio com 10 pessoas: cada uma toca uma vez antes de alguém repetir', () => {
  const people = 'ABCDEFGHIJ'.split('');
  const ids = people.flatMap(id => [id, id]);
  const state = { mode: 'desafio', queue: songsOf(ids), roundOrder: [], currentStreakUserId: null, currentStreakCount: 0 };
  rebalanceQueue(state);
  const order = state.queue.map(s => s.addedBy.id);
  assert.deepEqual(order.slice(0, 10), people);
  assert.deepEqual(order.slice(10), people);
});

test('fila continua quando só uma pessoa tem músicas', () => {
  for (const mode of ['livre', 'desafio']) {
    const state = { mode, queue: [1, 2, 3].map(id => ({ id, addedBy: { id: 'A' }, addedAt: id })), roundOrder: [], currentStreakUserId: 'A', currentStreakCount: 8 };
    rebalanceQueue(state);
    assert.equal(state.queue.length, 3);
  }
});
