const { randomBytes, randomInt, createHash } = require('node:crypto');
const { rebalanceQueue } = require('./queue');
const { isRecord, validVideoId, text, normalizeSong, secretEquals } = require('./security');

const MAX_AMMO = 3;
const LIKES_TO_RECHARGE = 2;
const RANZINZA_STREAK = 3;
const MYSTERY_SECONDS = 30;
const MAX_PLAYERS = 200;
const AVATARS = ['🎸', '🔥', '🎧', '🕺', '💃', '🍻', '🚀', '👑', '🦄', '🐯', '👽', '⚡', '🍕', '🎷', '🥁'];
const REACTIONS = ['🔥', '👍', '👎', '❤️', '😂', '🍻', '💃', '💩', '🍅', '🤮', '🤡', '😍', '😡'];
const MYSTERY_OWNER = { id: 'mystery', name: '🕵️ Mistério...', avatar: '❓' };
// Sem letras/números parecidos (0/O, 1/I/L) para ditar o código sem confusão.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ACHIEVEMENTS = {
  abriuPista: { icon: '🎯', name: 'Abriu a Pista', desc: 'Pediu a primeira música da festa' },
  maratonista: { icon: '🎧', name: 'Maratonista', desc: '5 músicas tocadas' },
  hitmaker: { icon: '🔥', name: 'Hitmaker', desc: '3 músicas aprovadas pela galera' },
  unanimidade: { icon: '🌟', name: 'Unanimidade', desc: 'Todo mundo curtiu a sua música' },
  sniper: { icon: '💥', name: 'Sniper', desc: 'Deu o dislike que vetou a música' },
  coracaoMole: { icon: '🥰', name: 'Coração Mole', desc: '5 likes seguidos' },
  ranzinza: { icon: '😡', name: 'Ranzinza Oficial', desc: '3 dislikes seguidos' },
  tomateiro: { icon: '🍅', name: 'Alvo de Tomate', desc: '2 músicas vetadas' },
  romantico: { icon: '💌', name: 'Romântico', desc: '3 músicas com dedicatória' },
  noTema: { icon: '🎨', name: 'No Clima', desc: '3 pedidos em rodadas temáticas' },
  animador: { icon: '🎉', name: 'Animador', desc: '20 reações enviadas' }
};

const normalizeCode = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
const validCode = value => typeof value === 'string' && /^[A-Z0-9]{4,8}$/.test(value);
const hashKey = key => createHash('sha256').update(key).digest('hex');

function generateCode(exists) {
  for (let length = 4; length <= 6; length++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      let code = '';
      for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!exists(code)) return code;
    }
  }
  throw new Error('Não foi possível gerar um código de festa.');
}

function validSaved(data) {
  const s = data && data.gameState;
  return data.version === 2 && isRecord(s) && ['livre', 'desafio'].includes(s.mode) &&
    Array.isArray(s.queue) && s.queue.length <= 100 &&
    Array.isArray(s.history) && Array.isArray(s.roundOrder) &&
    Array.isArray(data.players) && data.players.length <= MAX_PLAYERS &&
    typeof data.hostKeyHash === 'string' &&
    data.players.every(p => isRecord(p) && typeof p.id === 'string' && typeof p.name === 'string' && Number.isFinite(p.score)) &&
    [...s.queue, ...s.history, ...(s.currentSong ? [s.currentSong] : [])]
      .every(song => isRecord(song) && validVideoId(song.videoId) && isRecord(song.addedBy) && typeof song.id === 'string');
}

/**
 * Uma festa isolada: fila, votação, pontuação e conquistas.
 * Não conhece Socket.IO; avisa o servidor por callbacks.
 *   changed()             -> estado mudou (salvar + transmitir)
 *   emit(event, payload)  -> evento para todos da festa
 *   command(cmd)          -> comando para o aparelho que está tocando
 */
function createParty({ code, hostKeyHash, saved = null, media, changed = () => {}, emit = () => {}, command = () => {}, now = Date.now }) {
  const state = {
    mode: 'livre',
    fixedPlayerCount: 0,
    isPaused: false,
    currentSong: null,
    queue: [],
    currentStreakUserId: null,
    currentStreakCount: 0,
    roundOrder: [],
    history: [],
    log: [],
    lastSkipAlert: null,
    firstSongId: null,
    settings: { guestsControl: true },
    theme: null,
    qrMode: 'auto',
    createdAt: now(),
    lastActivity: now()
  };
  const players = new Map();

  if (saved) {
    Object.assign(state, saved.gameState);
    state.settings = { guestsControl: true, ...(isRecord(saved.gameState.settings) ? saved.gameState.settings : {}) };
    if (!Array.isArray(state.log)) state.log = [];
    for (const player of saved.players) players.set(player.id, withDefaults({ ...player, connected: false }));
    if (state.currentSong) {
      state.isPaused = true;
      state.currentSong.startedAt = now();
      state.currentSong.pausedAt = now();
      state.currentSong.pausedMs = 0;
    }
  }

  function withDefaults(p) {
    return Object.assign({ likesGiven: 0, dislikesGiven: 0, likeStreak: 0, reactions: 0, dedications: 0,
      themedSongs: 0, achievements: [], songsPlayed: 0, songsVetoed: 0, songsApproved: 0 }, p);
  }

  function touch() { state.lastActivity = now(); }

  // ---------- Conquistas ----------
  function grant(player, id) {
    if (!player || player.achievements.includes(id)) return;
    player.achievements.push(id);
    emit('achievement', {
      player: { id: player.id, name: player.name, avatar: player.avatar },
      achievement: { id, ...ACHIEVEMENTS[id] }
    });
  }

  // ---------- Participantes ----------
  function join(playerId, rawName) {
    const name = text(rawName, 22);
    if (!name) throw new Error('Digite seu nome ou apelido.');
    let p = players.get(playerId);
    if (!p) {
      if (players.size >= MAX_PLAYERS) throw new Error('A festa atingiu o limite de participantes.');
      p = withDefaults({ id: playerId, name: name.slice(0, 22), avatar: AVATARS[players.size % AVATARS.length],
        score: 0, ammo: MAX_AMMO, likesTowardsAmmo: 0, consecutiveDislikes: 0, isRanzinza: false,
        connected: true, lastActive: now() });
      players.set(playerId, p);
    } else {
      p.name = name.slice(0, 22);
      p.connected = true;
      p.lastActive = now();
    }
    touch();
    changed();
    return p;
  }

  function setConnected(playerId, connected) {
    const p = players.get(playerId);
    if (!p) return;
    p.connected = connected;
    changed();
  }

  // ---------- Mistério ----------
  function songElapsed(song) {
    return Math.max(0, Math.floor(((song.pausedAt || now()) - song.startedAt - (song.pausedMs || 0)) / 1000));
  }

  // Revela o autor: só então os pontos dele mudam, para o ranking não entregar o segredo.
  function revealSong(song, { silent = false } = {}) {
    if (!song || song.revealed) return;
    song.revealed = true;
    const owner = players.get(song.addedBy.id);
    if (owner) {
      owner.score += song.ownerDelta || 0;
      owner.songsPlayed += 1;
      // Conquistas ligadas ao pedido só saem agora, para não entregarem o mistério.
      if (song.id === state.firstSongId) grant(owner, 'abriuPista');
      if (owner.songsPlayed >= 5) grant(owner, 'maratonista');
      if (song.dedication && ++owner.dedications >= 3) grant(owner, 'romantico');
      if (song.theme && ++owner.themedSongs >= 3) grant(owner, 'noTema');
    }
    song.ownerDelta = 0;
    if (!silent) emit('mysteryRevealed', { songId: song.id, addedBy: song.addedBy });
  }

  function tick() {
    const s = state.currentSong;
    if (s && !s.revealed && songElapsed(s) >= MYSTERY_SECONDS) {
      revealSong(s);
      changed();
    }
  }

  // ---------- Reprodução ----------
  function activateSong(songObj) {
    state.isPaused = false;
    const song = {
      ...songObj,
      pinned: undefined,
      startedAt: now(),
      pausedMs: 0,
      pausedAt: null,
      revealed: false,
      ownerDelta: 0,
      votes: {},
      streamReady: Boolean(media?.cache?.get(`audio:${songObj.videoId}`)?.expiresAt > now())
    };
    state.currentSong = song;
    if (!state.firstSongId) state.firstSongId = song.id;
    if (state.mode === 'livre') revealSong(song, { silent: true });
    changed();

    for (let i = 0; i < Math.min(state.queue.length, 2); i++) {
      media?.resolveStreamUrl(state.queue[i].videoId, 'audio').catch(() => {});
    }
    Promise.resolve(media?.resolveStreamUrl(song.videoId)).then(streamUrl => {
      if (state.currentSong && state.currentSong.id === song.id) {
        state.currentSong.streamReady = Boolean(streamUrl);
        changed();
      }
    }).catch(() => {});
  }

  function startNextSong(reason = 'finished') {
    if (state.currentSong && (reason === 'finished' || reason === 'host_skip')) finalizeCurrentSong(false);
    if (state.queue.length === 0) {
      state.currentSong = null;
      state.isPaused = false;
      state.currentStreakUserId = null;
      state.currentStreakCount = 0;
      changed();
      return;
    }
    const next = state.queue.shift();
    const uid = next.addedBy.id;
    if (state.currentStreakUserId === uid) state.currentStreakCount += 1;
    else { state.currentStreakUserId = uid; state.currentStreakCount = 1; }
    rebalanceQueue(state);
    activateSong(next);
  }

  function plainSong(song) {
    const { id, videoId, title, artist, thumbnail, duration, addedBy, addedAt, dedication, theme } = song;
    return { id, videoId, title, artist, thumbnail, duration: duration || '3:30', addedBy, addedAt: addedAt || now(), dedication, theme };
  }

  function playPreviousSong() {
    if (state.history.length === 0) {
      if (state.currentSong) {
        Object.assign(state.currentSong, { startedAt: now(), pausedMs: 0, pausedAt: null });
        state.isPaused = false;
        command('restart');
        changed();
      }
      return;
    }
    const prev = state.history.shift();
    if (state.currentSong) {
      // A música interrompida volta fixa no topo, sem perder o lugar na rodada.
      const current = state.currentSong;
      revealSong(current, { silent: true });
      state.queue.unshift({ ...plainSong(current), id: `${current.id.split('~')[0]}~${now().toString(36)}`, pinned: true });
    }
    state.currentStreakUserId = prev.addedBy.id;
    state.currentStreakCount = 1;
    rebalanceQueue(state);
    activateSong({ ...plainSong(prev), id: `${prev.id.split('~')[0]}~${now().toString(36)}p` });
  }

  function finalizeCurrentSong(wasVetoed) {
    const song = state.currentSong;
    if (!song) return;
    revealSong(song, { silent: true });
    const owner = players.get(song.addedBy.id);
    const votes = Object.values(song.votes || {});
    const likes = votes.filter(v => v.type === 'like').length;
    const dislikes = votes.filter(v => v.type === 'dislike').reduce((acc, v) => acc + (v.weight || 1), 0);
    let approved = false;

    if (owner && state.mode === 'desafio') {
      if (wasVetoed) {
        owner.score -= 15;
        owner.songsVetoed += 1;
        if (owner.songsVetoed >= 2) grant(owner, 'tomateiro');
      } else {
        const others = Math.max(1, getActiveParticipantCount() - 1);
        if (likes >= Math.ceil(others * 0.7) && likes >= 1) {
          approved = true;
          owner.score += 20 + (song.theme ? 5 : 0);
          owner.songsApproved += 1;
          if (owner.songsApproved >= 3) grant(owner, 'hitmaker');
          if (likes >= 2 && likes >= getEligibleVoterCount(song) && dislikes === 0) grant(owner, 'unanimidade');
        }
      }
    }

    const entry = { ...plainSong(song), likes, dislikes, wasVetoed, approved, endedAt: now() };
    delete entry.addedAt;
    state.history.unshift(entry);
    if (state.history.length > 20) state.history.pop();
    state.log.push(entry);
    if (state.log.length > 300) state.log.shift();
  }

  function getActiveParticipantCount() {
    if (state.fixedPlayerCount > 0) return state.fixedPlayerCount;
    return Math.max(1, Array.from(players.values()).filter(p => p.connected).length);
  }

  function getEligibleVoterCount(song = state.currentSong) {
    if (state.fixedPlayerCount > 0) return Math.max(0, state.fixedPlayerCount - 1);
    return Array.from(players.values()).filter(p => p.connected && p.id !== song?.addedBy.id).length;
  }

  const getDislikeThreshold = () => Math.floor(getEligibleVoterCount() / 2) + 1;

  function setPaused(paused) {
    const song = state.currentSong;
    if (song && paused !== state.isPaused) {
      if (paused) song.pausedAt = now();
      else {
        song.pausedMs = (song.pausedMs || 0) + (now() - (song.pausedAt || now()));
        song.pausedAt = null;
      }
    }
    state.isPaused = paused;
  }

  // ---------- Pedidos ----------
  function addSong(playerId, rawSong, rawDedication) {
    const player = players.get(playerId);
    if (!player) throw new Error('Entre na festa antes de pedir músicas.');
    const song = normalizeSong(rawSong);
    const dedication = text(rawDedication, 60);
    if (state.queue.length >= 100 || state.queue.filter(s => s.addedBy.id === player.id).length >= 10) {
      throw new Error('Limite da fila atingido: até 10 pedidos por pessoa e 100 na festa.');
    }
    const s = state.currentSong;
    if (state.mode === 'desafio' && s && s.addedBy.id !== player.id && !s.votes[player.id]) {
      throw new Error('Vote na música que está tocando agora (👍 ou 👎) para liberar novos pedidos!');
    }
    if ((s && s.videoId === song.videoId) || state.queue.some(item => item.videoId === song.videoId)) {
      throw new Error('Essa música já está na fila ou tocando agora!');
    }
    const newSong = {
      id: `${now()}-${randomBytes(3).toString('hex')}`,
      ...song,
      addedBy: { id: player.id, name: player.name, avatar: player.avatar },
      addedAt: now(),
      dedication: dedication || undefined,
      theme: state.theme || undefined
    };

    media?.resolveStreamUrl(newSong.videoId, 'audio').catch(() => {});
    state.queue.push(newSong);
    rebalanceQueue(state);
    touch();
    if (!state.currentSong) startNextSong('idle');
    else changed();
    return newSong;
  }

  // ---------- Votação ----------
  function vote(playerId, type, songId) {
    if (state.mode !== 'desafio') throw new Error('A votação está disponível apenas no modo Desafio.');
    const song = state.currentSong;
    if (!songId || songId !== song?.id) throw new Error('A música mudou. Vote na música atual.');
    const player = players.get(playerId);
    if (!player) throw new Error('Entre na festa primeiro.');
    if (song.addedBy.id === playerId) throw new Error('Essa música é sua! Segure o mistério 🤫');
    if (song.votes[playerId]) throw new Error('Você já votou nesta música!');
    if (!['like', 'dislike'].includes(type)) throw new Error('Tipo de voto inválido.');

    if (type === 'dislike') {
      if (player.ammo <= 0) throw new Error('Sem munição de Dislike (💣 0/3)! Dê Likes em músicas boas para recarregar.');
      player.ammo -= 1;
      player.consecutiveDislikes += 1;
      player.likeStreak = 0;
      player.dislikesGiven += 1;
      let weight = 1;
      if (player.consecutiveDislikes >= RANZINZA_STREAK) {
        player.isRanzinza = true;
        player.score -= 10;
        weight = 0.5;
        emit('ranzinzaAlert', { player: { id: player.id, name: player.name, avatar: player.avatar }, streak: player.consecutiveDislikes });
        grant(player, 'ranzinza');
      }
      song.votes[playerId] = { type: 'dislike', weight, at: now() };
      if (!player.isRanzinza) player.score += 2;
      song.ownerDelta -= 5;
    } else {
      player.consecutiveDislikes = 0;
      player.isRanzinza = false;
      player.likesGiven += 1;
      player.likeStreak += 1;
      if (player.likeStreak >= 5) grant(player, 'coracaoMole');
      player.likesTowardsAmmo += 1;
      if (player.likesTowardsAmmo >= LIKES_TO_RECHARGE) {
        player.likesTowardsAmmo = 0;
        if (player.ammo < MAX_AMMO) player.ammo += 1;
      }
      song.votes[playerId] = { type: 'like', weight: 1, at: now() };
      player.score += 2;
      song.ownerDelta += 10;
    }
    // Pontos do autor entram na hora se ele já foi revelado.
    if (song.revealed) {
      const owner = players.get(song.addedBy.id);
      if (owner) owner.score += song.ownerDelta;
      song.ownerDelta = 0;
    }

    const dislikes = Object.values(song.votes).filter(v => v.type === 'dislike').reduce((sum, v) => sum + (v.weight || 1), 0);
    const threshold = getDislikeThreshold();
    touch();
    if (dislikes >= threshold) {
      revealSong(song, { silent: true });
      if (type === 'dislike') grant(player, 'sniper');
      const info = { id: song.id, title: song.title, artist: song.artist, addedBy: song.addedBy, dislikesEffective: dislikes, threshold, at: now() };
      state.lastSkipAlert = info;
      finalizeCurrentSong(true);
      emit('songVetoed', info);
      startNextSong('vetoed');
    } else {
      changed();
    }
    return player;
  }

  function react(playerId, emoji) {
    const player = players.get(playerId);
    if (!player) throw new Error('Entre na festa primeiro.');
    if (!REACTIONS.includes(emoji)) throw new Error('Reação inválida.');
    player.reactions += 1;
    if (player.reactions >= 20) grant(player, 'animador');
    emit('liveReaction', { emoji, playerName: player.name, avatar: player.avatar });
  }

  // ---------- Comandos ----------
  const PLAYBACK = ['skipSong', 'previousSong', 'togglePause'];
  const HOST_ONLY = ['setMode', 'setFixedPlayerCount', 'toggleQrMode', 'setSettings', 'setTheme', 'showSummary'];
  const PLAYER_ONLY = ['songEnded', 'syncPauseState'];
  const ACTIONS = [...PLAYBACK, ...HOST_ONLY, ...PLAYER_ONLY, 'removeQueueItem'];

  function canControlPlayback(isHost) { return isHost || state.settings.guestsControl; }

  function control(action, payload = {}, { isHost = false, playerId = null, isActivePlayer = false } = {}) {
    if (!ACTIONS.includes(action)) throw new Error('Comando desconhecido.');
    if (!isRecord(payload)) throw new Error('Comando inválido.');
    if (PLAYER_ONLY.includes(action) && !isActivePlayer) throw new Error('Este aparelho não é o reprodutor ativo.');
    if (HOST_ONLY.includes(action) && !isHost) throw new Error('Só o anfitrião da festa pode fazer isso.');
    if (PLAYBACK.includes(action) && !canControlPlayback(isHost)) throw new Error('O anfitrião deixou os controles só com ele.');
    touch();

    switch (action) {
      case 'setMode': {
        if (!['livre', 'desafio'].includes(payload.mode)) throw new Error('Modo inválido.');
        state.mode = payload.mode;
        if (state.mode === 'livre' && state.currentSong) revealSong(state.currentSong, { silent: true });
        break;
      }
      case 'setFixedPlayerCount': {
        if (!/^\d{1,3}$/.test(String(payload.count)) || Number(payload.count) > MAX_PLAYERS) throw new Error('Informe de 0 a 200 participantes.');
        state.fixedPlayerCount = Number(payload.count);
        break;
      }
      case 'toggleQrMode': {
        if (!['auto', 'local'].includes(payload.mode)) throw new Error('Modo de QR inválido.');
        state.qrMode = payload.mode;
        break;
      }
      case 'setSettings': {
        if (typeof payload.guestsControl !== 'boolean') throw new Error('Configuração inválida.');
        state.settings.guestsControl = payload.guestsControl;
        break;
      }
      case 'setTheme': {
        const theme = text(payload.theme, 40);
        state.theme = theme || null;
        emit('themeChanged', { theme: state.theme });
        break;
      }
      case 'showSummary': {
        emit('partySummary', summary());
        return;
      }
      case 'skipSong': startNextSong('host_skip'); return;
      case 'previousSong': playPreviousSong(); return;
      case 'togglePause': {
        setPaused(typeof payload.paused === 'boolean' ? payload.paused : !state.isPaused);
        command(state.isPaused ? 'pause' : 'play');
        break;
      }
      case 'syncPauseState': {
        if (typeof payload.paused !== 'boolean') return;
        setPaused(payload.paused);
        break;
      }
      case 'songEnded': {
        if (state.currentSong && payload.songId === state.currentSong.id) startNextSong('finished');
        return;
      }
      case 'removeQueueItem': {
        const songId = text(payload.songId, 100);
        const item = state.queue.find(s => s.id === songId);
        if (!item) return;
        if (!isHost && item.addedBy.id !== playerId) throw new Error('Você só pode remover os seus pedidos.');
        state.queue = state.queue.filter(s => s.id !== songId);
        rebalanceQueue(state);
        break;
      }
    }
    changed();
  }

  // ---------- Resumo da festa ----------
  function summary() {
    const list = Array.from(players.values());
    const log = state.log;
    const pick = (items, score, min = 1) => {
      let best = null;
      for (const item of items) if (score(item) >= min && (!best || score(item) > score(best))) best = item;
      return best;
    };
    const who = p => `${p.avatar} ${p.name}`;
    const cards = [];
    const minutes = Math.max(1, Math.round((now() - state.createdAt) / 60000));
    cards.push({ icon: '🎶', title: 'A festa em números', value: `${log.length} música${log.length === 1 ? '' : 's'}`,
      sub: `${list.length} pessoa${list.length === 1 ? '' : 's'} · ${minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`} de festa` });

    const hit = pick(log, s => s.likes);
    if (hit) cards.push({ icon: '🏆', title: 'Hino da noite', value: hit.title, sub: `${hit.likes} like${hit.likes === 1 ? '' : 's'} · pedida por ${hit.addedBy.name}` });
    const dj = pick(list, p => p.score);
    if (dj && state.log.some(s => s.likes || s.dislikes)) cards.push({ icon: '👑', title: 'DJ da festa', value: who(dj), sub: `${dj.score} pontos` });
    const requester = pick(list, p => p.songsPlayed);
    if (requester) cards.push({ icon: '🎧', title: 'Dono da caixa de som', value: who(requester), sub: `${requester.songsPlayed} música${requester.songsPlayed === 1 ? '' : 's'} tocada${requester.songsPlayed === 1 ? '' : 's'}` });
    const vetoed = pick(list, p => p.songsVetoed);
    if (vetoed) cards.push({ icon: '🍅', title: 'Mais vetado', value: who(vetoed), sub: `${vetoed.songsVetoed} música${vetoed.songsVetoed === 1 ? '' : 's'} barrada${vetoed.songsVetoed === 1 ? '' : 's'} pela galera` });
    const grumpy = pick(list, p => p.dislikesGiven);
    if (grumpy) cards.push({ icon: '😡', title: 'Maior ranzinza', value: who(grumpy), sub: `${grumpy.dislikesGiven} dislike${grumpy.dislikesGiven === 1 ? '' : 's'} distribuído${grumpy.dislikesGiven === 1 ? '' : 's'}` });
    const softie = pick(list, p => p.likesGiven);
    if (softie) cards.push({ icon: '🥰', title: 'Coração mole', value: who(softie), sub: `${softie.likesGiven} like${softie.likesGiven === 1 ? ' dado' : 's dados'}` });
    const hype = pick(list, p => p.reactions, 3);
    if (hype) cards.push({ icon: '🎉', title: 'Animador da galera', value: who(hype), sub: `${hype.reactions} reações enviadas` });
    const dedications = log.filter(s => s.dedication);
    if (dedications.length) {
      const last = dedications[dedications.length - 1];
      cards.push({ icon: '💌', title: `${dedications.length} dedicatória${dedications.length === 1 ? '' : 's'}`, value: `“${last.dedication}”`, sub: `${last.title} · ${last.addedBy.name}` });
    }
    const themes = [...new Set(log.filter(s => s.theme).map(s => s.theme))];
    if (themes.length) cards.push({ icon: '🎨', title: 'Rodadas temáticas', value: themes.slice(0, 3).join(' · '), sub: `${log.filter(s => s.theme).length} músicas no tema` });

    const achievements = list.filter(p => p.achievements.length)
      .sort((a, b) => b.achievements.length - a.achievements.length)
      .map(p => ({ name: p.name, avatar: p.avatar, badges: p.achievements.map(id => ({ id, ...ACHIEVEMENTS[id] })) }));
    return { code, cards, achievements, songs: log.slice(-50).map(s => ({ title: s.title, artist: s.artist, videoId: s.videoId, likes: s.likes, wasVetoed: s.wasVetoed })) };
  }

  // ---------- Visão pública ----------
  function publicState(connection) {
    const desafio = state.mode === 'desafio';
    let current = null;
    const s = state.currentSong;
    if (s) {
      const elapsed = songElapsed(s);
      const isRevealed = !desafio || s.revealed;
      const voteEntries = Object.entries(s.votes || {});
      const connected = Array.from(players.values()).filter(p => p.connected);
      const brief = p => ({ id: p.id, name: p.name, avatar: p.avatar });
      // Durante o mistério o autor também aparece como "falta votar", para não ser descoberto por eliminação.
      const pendingVoters = connected.filter(p => !s.votes[p.id] && (!isRevealed || p.id !== s.addedBy.id)).map(brief);
      current = {
        id: s.id, videoId: s.videoId, streamReady: Boolean(s.streamReady),
        title: s.title, artist: s.artist, thumbnail: s.thumbnail, duration: s.duration,
        dedication: s.dedication || null, theme: s.theme || null,
        elapsedSeconds: elapsed,
        mysteryRemainingSeconds: isRevealed ? 0 : Math.max(0, MYSTERY_SECONDS - elapsed),
        isRevealed,
        addedBy: isRevealed ? s.addedBy : MYSTERY_OWNER,
        likesCount: voteEntries.filter(([, v]) => v.type === 'like').length,
        dislikesRawCount: voteEntries.filter(([, v]) => v.type === 'dislike').length,
        dislikesEffective: voteEntries.filter(([, v]) => v.type === 'dislike').reduce((sum, [, v]) => sum + (v.weight || 1), 0),
        dislikeThreshold: getDislikeThreshold(),
        pendingVoters,
        voterIds: Object.keys(s.votes || {})
      };
    }
    const queue = state.queue.map(item => {
      const { pinned, ...rest } = item;
      return desafio ? { ...rest, addedBy: { ...MYSTERY_OWNER, name: '🕵️ Mistério' } } : rest;
    });
    const playerList = Array.from(players.values())
      .sort((a, b) => b.score - a.score)
      .map((p, idx) => ({
        id: p.id, name: p.name, avatar: p.avatar, score: p.score, ammo: p.ammo, isRanzinza: p.isRanzinza,
        connected: p.connected, songsPlayed: p.songsPlayed, songsVetoed: p.songsVetoed, songsApproved: p.songsApproved,
        achievements: p.achievements.map(id => ({ id, icon: ACHIEVEMENTS[id].icon, name: ACHIEVEMENTS[id].name })),
        rank: idx + 1
      }));
    return {
      code,
      mode: state.mode,
      isPaused: state.isPaused,
      hasHistory: state.history.length > 0,
      fixedPlayerCount: state.fixedPlayerCount,
      totalParticipants: getActiveParticipantCount(),
      dislikeThreshold: getDislikeThreshold(),
      currentSong: current,
      queue,
      history: state.history.slice(0, 8),
      players: playerList,
      lastSkipAlert: state.lastSkipAlert,
      settings: { ...state.settings },
      theme: state.theme,
      connection
    };
  }

  // Informações só para um aparelho: quais pedidos são dele e o que ele pode fazer.
  function viewFor(playerId, isHost) {
    const s = state.currentSong;
    return {
      playerId,
      isHost,
      canControl: canControlPlayback(isHost),
      currentIsMine: Boolean(s && playerId && s.addedBy.id === playerId),
      mySongIds: playerId ? state.queue.filter(item => item.addedBy.id === playerId).map(item => item.id) : []
    };
  }

  function serialize() {
    return { version: 2, code, hostKeyHash, gameState: state, players: Array.from(players.values()) };
  }

  return {
    code,
    get qrMode() { return state.qrMode; },
    get lastActivity() { return state.lastActivity; },
    isHostKey: key => typeof key === 'string' && key.length <= 128 && secretEquals(hashKey(key), hostKeyHash),
    hasPlayer: id => players.has(id),
    join, setConnected, addSong, vote, react, control, tick, summary, publicState, viewFor, serialize,
    _state: state
  };
}

module.exports = { createParty, generateCode, normalizeCode, validCode, validSaved, hashKey, ACHIEVEMENTS, MYSTERY_SECONDS };
