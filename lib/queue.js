// Mantém uma ordem circular estável. Rebalancear a mesma fila não muda a rodada.
function rebalanceQueue(state) {
  const byUser = new Map();
  for (const song of state.queue) {
    if (!byUser.has(song.addedBy.id)) byUser.set(song.addedBy.id, []);
    byUser.get(song.addedBy.id).push(song);
  }
  for (const songs of byUser.values()) songs.sort((a, b) => a.addedAt - b.addedAt);
  const current = state.currentStreakUserId;
  const order = state.roundOrder.filter(id => byUser.has(id) || id === current);
  for (const id of byUser.keys()) if (!order.includes(id)) order.push(id);
  if (current && !order.includes(current)) order.unshift(current);
  state.roundOrder = order;
  const index = current ? order.indexOf(current) : 0;
  const rotated = [...order.slice(index), ...order.slice(0, index)];
  const queue = [];
  let firstRound = true;
  while (Array.from(byUser.values()).some(songs => songs.length)) {
    for (const id of rotated) {
      const allowance = firstRound && id === current ? Math.max(0, 2 - state.currentStreakCount) : 2;
      queue.push(...(byUser.get(id)?.splice(0, allowance) || []));
    }
    firstRound = false;
  }
  state.queue = queue;
}

module.exports = { rebalanceQueue };
