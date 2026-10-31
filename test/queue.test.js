const test = require('node:test');
const assert = require('node:assert/strict');
const { rebalanceQueue } = require('../lib/queue');

test('fila em rodízio: uma música por pessoa por vez e rebalanceamento é estável', () => {
  // A está tocando agora; os próximos pedidos de A só voltam depois de todo mundo.
  const queue = ['A', 'A', 'A', 'B', 'B', 'B', 'C'].map((id, i) => ({ id: i, addedBy: { id }, addedAt: i }));
  const state = { queue, roundOrder: ['A', 'B', 'C'], currentStreakUserId: 'A', currentStreakCount: 1 };
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.addedBy.id), ['B', 'C', 'A', 'B', 'A', 'B', 'A']);
  const ids = state.queue.map(s => s.id);
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.id), ids);
});

test('com 10 pessoas, cada uma toca uma vez antes de alguém repetir', () => {
  const people = 'ABCDEFGHIJ'.split('');
  const queue = [];
  let t = 0;
  for (const id of people) for (let n = 0; n < 2; n++) queue.push({ id: `${id}${n}`, addedBy: { id }, addedAt: t++ });
  const state = { queue, roundOrder: [], currentStreakUserId: null, currentStreakCount: 0 };
  rebalanceQueue(state);
  const order = state.queue.map(s => s.addedBy.id);
  assert.deepEqual(order.slice(0, 10), people);
  assert.deepEqual(order.slice(10), people);
});

test('fila continua quando só uma pessoa tem músicas', () => {
  const state = { queue: [1, 2, 3].map(id => ({ id, addedBy: { id: 'A' }, addedAt: id })), roundOrder: [], currentStreakUserId: 'A', currentStreakCount: 8 };
  rebalanceQueue(state);
  assert.equal(state.queue.length, 3);
});
