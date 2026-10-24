const test = require('node:test');
const assert = require('node:assert/strict');
const { rebalanceQueue } = require('../lib/queue');

test('fila alterna até duas músicas por pessoa e rebalanceamento é estável', () => {
  const queue = ['A', 'A', 'A', 'B', 'B', 'B', 'C'].map((id, i) => ({ id: i, addedBy: { id }, addedAt: i }));
  const state = { queue, roundOrder: ['A', 'B', 'C'], currentStreakUserId: 'A', currentStreakCount: 1 };
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.addedBy.id), ['A', 'B', 'B', 'C', 'A', 'A', 'B']);
  const ids = state.queue.map(s => s.id);
  rebalanceQueue(state);
  assert.deepEqual(state.queue.map(s => s.id), ids);
  state.currentStreakCount = 2;
  rebalanceQueue(state);
  assert.equal(state.queue[0].addedBy.id, 'B');
});

test('fila continua quando só uma pessoa tem músicas', () => {
  const state = { queue: [1, 2, 3].map(id => ({ id, addedBy: { id: 'A' }, addedAt: id })), roundOrder: [], currentStreakUserId: 'A', currentStreakCount: 8 };
  rebalanceQueue(state);
  assert.equal(state.queue.length, 3);
});
