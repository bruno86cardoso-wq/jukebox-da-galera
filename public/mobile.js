const socket = createPartySocket();
let myPlayerId = localStorage.getItem('jukebox_player_id');
let myPlayerName = localStorage.getItem('jukebox_player_name') || '';
let latestState = null;
let currentSearchResults = [];
let jblModeActive = false;
let jblMediaMode = 'audio';
let jblCurrentSongId = null;
let jblCurrentVideoId = null;
let jblLoadedMediaMode = null;
let partyInviteUrl = window.location.origin;
const jblAudioEl = document.getElementById('mobJblAudio');
const jblClipEl = document.getElementById('mobJblVideo');
let jblVideoEl = jblMediaMode === 'audio' ? jblAudioEl : jblClipEl;
let jblPlaybackState = 'idle';

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function onJblTimeUpdate() {
  const el = jblVideoEl;
  if (!el) return;
  const current = el.currentTime || 0;
  const total = el.duration || 0;
  if (total > 0) {
    const pct = Math.min(100, Math.max(0, (current / total) * 100));
    const bar = document.getElementById('playerProgressBar');
    if (bar) bar.style.width = pct + '%';

    const curLabel = document.getElementById('playerCurrentTime');
    if (curLabel) curLabel.textContent = formatTime(current);

    const totLabel = document.getElementById('playerTotalTime');
    if (totLabel) totLabel.textContent = formatTime(total);
  }
}

function seekJblPlayer(e) {
  const track = document.getElementById('playerProgressTrack');
  const el = jblVideoEl;
  if (!track || !el || !el.duration) return;
  const rect = track.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));
  el.currentTime = ratio * el.duration;
  onJblTimeUpdate();
}

function toggleJblPlayPause() {
  if (!jblModeActive) {
    toggleJblMode();
    return;
  }
  if (jblVideoEl.paused) {
    playJblMedia();
  } else {
    jblVideoEl.pause();
  }
}

function updatePlaybackStatus(status = jblPlaybackState) {
  jblPlaybackState = status;
  const labels = { idle: 'Aguardando música.', loading: 'Carregando música…', playing: 'Tocando neste aparelho',
    paused: 'Música pausada.', blocked: 'Toque em ▶ Tocar música para liberar o som no celular.',
    error: 'Não foi possível tocar esta música. Toque em tentar novamente ou pule.' };
  
  const statusEl = document.getElementById('jblPlaybackStatus');
  if (statusEl) statusEl.textContent = labels[status] || status;
  
  const button = document.getElementById('btnResumeAudio');
  if (button) {
    button.hidden = !['blocked', 'error', 'paused', 'loading'].includes(status);
    button.textContent = status === 'error' ? '↻ Tentar novamente' : (status === 'playing' ? '⏸ Pausar' : '▶ Tocar música');
  }
  
  const badge = document.getElementById('playbackBadge');
  if (badge) {
    badge.textContent = !latestState?.currentSong ? 'AGUARDANDO MÚSICA' : !jblModeActive ? 'REPRODUÇÃO EM OUTRO APARELHO'
      : { idle: 'AGUARDANDO', loading: 'CARREGANDO…', playing: '▶ TOCANDO AQUI', paused: '⏸ PAUSADO', blocked: 'TOQUE PARA OUVIR', error: 'ÁUDIO INDISPONÍVEL' }[status] || 'CARREGANDO…';
    badge.title = !jblModeActive ? 'Toque para assumir o som neste aparelho' : 'Tocando neste aparelho';
  }

  // Atualiza controles customizados modernos estilo Spotify
  const iconPlay = document.getElementById('iconCustomPlay');
  const iconPause = document.getElementById('iconCustomPause');
  const eq = document.getElementById('playerEqAnimation');
  const isPlaying = status === 'playing';

  if (iconPlay && iconPause) {
    iconPlay.style.display = isPlaying ? 'none' : 'block';
    iconPause.style.display = isPlaying ? 'block' : 'none';
  }
  if (eq) {
    eq.classList.toggle('playing', isPlaying);
  }
}

async function playJblMedia() {
  const element = jblVideoEl;
  if (!jblModeActive || !jblCurrentSongId) return;
  try { await element.play(); }
  catch (error) {
    if (element !== jblVideoEl || !jblModeActive || error.name === 'AbortError') return;
    updatePlaybackStatus(error.name === 'NotAllowedError' ? 'blocked' : 'error');
  }
}

function resumeJblPlayback() {
  if (!jblModeActive) return;
  if (jblPlaybackState === 'error') {
    jblRecovery.reset();
    jblVideoEl.load();
    updatePlaybackStatus('loading');
  }
  // Chamado diretamente pelo clique, preservando a permissão de áudio do navegador.
  playJblMedia();
}

for (const element of [jblAudioEl, jblClipEl]) {
  for (const [event, status] of [['loadstart', 'loading'], ['waiting', 'loading'], ['playing', 'playing'], ['pause', 'paused'], ['error', 'error']]) {
    element.addEventListener(event, () => {
      if (element === jblVideoEl && jblModeActive && jblCurrentSongId) updatePlaybackStatus(status);
    });
  }

  element.addEventListener('timeupdate', () => {
    if (element === jblVideoEl && jblModeActive) onJblTimeUpdate();
  });


element.addEventListener('ended', () => {
  if (element === jblVideoEl && jblModeActive && jblCurrentSongId) {
    socket.emit('hostAction', {
      action: 'songEnded',
      payload: { songId: jblCurrentSongId }
    });
  }
});

element.addEventListener('pause', () => {
  if (element === jblVideoEl && jblModeActive && jblCurrentVideoId && !jblVideoEl.ended) {
    socket.emit('hostAction', { action: 'syncPauseState', payload: { paused: true } });
  }
});

element.addEventListener('play', () => {
  if (element === jblVideoEl && jblModeActive && jblCurrentVideoId) {
    socket.emit('hostAction', { action: 'syncPauseState', payload: { paused: false } });
  }
});

}

socket.on('tvDeactivated', () => {
  if (jblModeActive) {
    jblModeActive = false;
    syncJblPlayer(null);
    updateJblUi();
    showToast('📺 O som passou para outro aparelho/Telão!');
  }
});

socket.on('playerCommand', ({ command }) => {
  if (!jblModeActive || !jblCurrentVideoId) return;
  if (command === 'pause') {
    jblVideoEl.pause();
  } else if (command === 'play') {
    playJblMedia();
  } else if (command === 'restart') {
    jblVideoEl.currentTime = 0;
    playJblMedia();
  }
});

function handlePlaybackBadgeClick() {
  if (!jblModeActive) {
    toggleJblMode(true);
  }
}

async function toggleJblMode(forcedState) {
  const nextState = typeof forcedState === 'boolean' ? forcedState : !jblModeActive;
  if (nextState === jblModeActive) return;
  if (nextState) {
    jblModeActive = true;
    updateJblUi();
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
    if (latestState && latestState.currentSong) {
      syncJblPlayer(latestState.currentSong);
    }
    // Desbloqueia áudio de imediato no contexto do toque do usuário
    playJblMedia();
    const claimed = await socket.claimPlayback();
    if (!claimed) {
      jblModeActive = false;
      syncJblPlayer(null);
      updateJblUi();
      return;
    }
    showToast('🔊 Som assumido! Este aparelho está tocando.');
  } else {
    jblModeActive = false;
    socket.emit('releaseTv', {});
    jblRecovery.reset();
    jblCurrentSongId = null;
    jblCurrentVideoId = null;
    jblLoadedMediaMode = null;
    jblVideoEl.pause();
    jblVideoEl.removeAttribute('src');
    jblVideoEl.load();
    showToast('🔇 Som liberado. Outro aparelho pode assumir.');
    updateJblUi();
  }
}

function setJblMediaMode(mode) {
  const next = mode === 'video' ? 'video' : 'audio';
  if (next === jblMediaMode) return;
  jblMediaMode = next;
  localStorage.setItem('jukebox_media_mode', next);
  updateJblUi();
  if (jblModeActive && latestState?.currentSong) syncJblPlayer(latestState.currentSong);
}

function updateJblUi() {
  const btn = document.getElementById('btnToggleJbl');
  const btnText = document.getElementById('btnToggleJblText');
  if (btn) {
    btn.classList.toggle('jbl-active', jblModeActive);
    const label = jblModeActive ? '🔊 Tocando neste Aparelho' : '🔊 Assumir Som da Caixa';
    if (btnText) {
      btnText.textContent = label;
    } else {
      btn.textContent = label;
    }
  }
  const box = document.getElementById('jblPlayerBox');
  if (box) {
    box.style.display = jblModeActive && latestState?.currentSong ? 'block' : 'none';
  }
  const statusText = document.getElementById('jblModeStatusText');
  if (statusText) {
    statusText.textContent = '🎵 Som no Celular / JBL';
  }
  if (jblAudioEl) jblAudioEl.style.display = jblMediaMode === 'audio' ? 'block' : 'none';
  if (jblClipEl) jblClipEl.style.display = jblMediaMode === 'video' ? 'block' : 'none';
  const pillAudio = document.getElementById('btnPillAudio');
  const pillVideo = document.getElementById('btnPillVideo');
  if (pillAudio && pillVideo) {
    pillAudio.classList.toggle('active', jblMediaMode === 'audio');
    pillVideo.classList.toggle('active', jblMediaMode === 'video');
  }
  for (const mode of ['audio', 'video']) {
    const button = document.getElementById(mode === 'audio' ? 'btnMediaAudio' : 'btnMediaVideo');
    if (button) {
      button.classList.toggle('active', jblMediaMode === mode);
      button.setAttribute('aria-pressed', String(jblMediaMode === mode));
    }
  }
  updatePlaybackStatus();
}

function castToTv() {
  openQrModal();
}

function closeCastModal() {}

async function startCastWithMode(mode) {
  closeCastModal();
  jblMediaMode = mode; // 'audio' ou 'video'

  if (!jblModeActive) {
    jblModeActive = true;
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  }

  jblLoadedMediaMode = null;
  updateJblUi();

  if (latestState && latestState.currentSong) {
    syncJblPlayer(latestState.currentSong);
  }
  playJblMedia();
  socket.claimPlayback().catch(() => {});

  const targetEl = (mode === 'video' ? jblClipEl : jblVideoEl);
  // Tenta abrir o seletor nativo de Chromecast (Android/Chrome)
  if (targetEl.remote && typeof targetEl.remote.prompt === 'function') {
    try {
      await targetEl.remote.prompt();
      return;
    } catch (e) {}
  }
  // Tenta abrir o seletor nativo de AirPlay (iPhone/Safari)
  if (typeof targetEl.webkitShowPlaybackTargetPicker === 'function') {
    try {
      targetEl.webkitShowPlaybackTargetPicker();
      return;
    } catch (e) {}
  }

  if (mode === 'audio') {
    showToast('🎵 Modo Só Música ativo! Conecte no Bluetooth/JBL ou espelhe o som na TV.');
  } else {
    showToast('🎬 Clipe ativado! Toque no ícone de Transmitir no vídeo ou espelhe na TV.');
  }
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Jukebox da Galera',
      artist: song.artist || 'YouTube Music',
      album: 'Jukebox da Galera',
      artwork: song.thumbnail ? [{ src: song.thumbnail, sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => remoteControl('togglePause'));
    navigator.mediaSession.setActionHandler('pause', () => remoteControl('togglePause'));
    navigator.mediaSession.setActionHandler('previoustrack', () => remoteControl('previousSong'));
    navigator.mediaSession.setActionHandler('nexttrack', () => remoteControl('skipSong'));
  } catch (e) {}
}

const recoveries = new Map([jblAudioEl, jblClipEl].map(element => [element, attachMediaRecovery(element, {
  isActive: () => jblModeActive && element === jblVideoEl,
  source: () => jblCurrentVideoId ? (element === jblClipEl ? '/api/stream/' : '/api/audio/') + jblCurrentVideoId : null,
  play: () => { if (!latestState?.isPaused) playJblMedia(); },
  failed: () => updatePlaybackStatus('error')
})]));
let jblRecovery = recoveries.get(jblVideoEl);

function syncJblPlayer(song) {
  const box = document.getElementById('jblPlayerBox');
  if (!jblModeActive || !song) {
    box.style.display = 'none';
    jblRecovery.reset();
    jblCurrentSongId = null;
    jblCurrentVideoId = null;
    jblLoadedMediaMode = null;
    jblVideoEl.pause();
    jblVideoEl.removeAttribute('src');
    jblVideoEl.load();
    return;
  }

  box.style.display = 'block';
  updateJblUi();

  if (
    song.id !== jblCurrentSongId ||
    song.videoId !== jblCurrentVideoId ||
    jblLoadedMediaMode !== jblMediaMode
  ) {
    const resumeTime = (song.id === jblCurrentSongId && jblVideoEl.currentTime > 1)
      ? jblVideoEl.currentTime
      : 0;

    jblRecovery.reset();
    const previous = jblVideoEl;
    jblVideoEl = jblMediaMode === 'audio' ? jblAudioEl : jblClipEl;
    jblRecovery = recoveries.get(jblVideoEl);
    jblRecovery.reset();
    if (previous !== jblVideoEl) {
      previous.pause();
      previous.removeAttribute('src');
      previous.load();
    }
    jblCurrentSongId = song.id;
    jblCurrentVideoId = song.videoId;
    jblLoadedMediaMode = jblMediaMode;

    if (jblMediaMode === 'video') jblVideoEl.poster = song.thumbnail || '';
    const endpoint = jblMediaMode === 'video'
      ? `/api/stream/${song.videoId}`
      : `/api/audio/${song.videoId}`;

    updatePlaybackStatus(latestState?.isPaused ? 'paused' : 'loading');
    jblVideoEl.preload = 'auto';
    jblVideoEl.src = endpoint;
    jblVideoEl.load();
    if (resumeTime > 0) {
      jblVideoEl.addEventListener('loadedmetadata', function onMeta() {
        jblVideoEl.removeEventListener('loadedmetadata', onMeta);
        jblVideoEl.currentTime = resumeTime;
      });
    }
    if (!latestState?.isPaused) playJblMedia();
    updateMediaSession(song);
  }
}

async function openQrModal() {
  document.getElementById('qrModal').style.display = 'flex';
  try {
    const res = await fetch('/api/qrcode');
    const data = await res.json();
    partyInviteUrl = data.url;
    document.getElementById('mobQrImage').src = data.dataUrl;
    document.getElementById('mobQrUrl').textContent = data.url;
  } catch (e) {}
}

function closeQrModal() {
  document.getElementById('qrModal').style.display = 'none';
}

async function sharePartyLink() {
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Jukebox da Galera 🎵',
        text: 'Entre na fila de músicas da festa:',
        url: partyInviteUrl
      });
      return;
    } catch (e) {}
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(partyInviteUrl);
    showToast('🔗 Link da festa copiado!');
  }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (e) => {
    if (jblModeActive && jblVideoEl && jblVideoEl.paused && !latestState?.isPaused && jblCurrentSongId && jblPlaybackState === 'blocked') {
      playJblMedia();
    }
  }, { passive: true });
}

if (!myPlayerId) {
  myPlayerId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem('jukebox_player_id', myPlayerId);
}

if (myPlayerName) {
  document.getElementById('playerNameInput').value = myPlayerName;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    t.style.display = 'none';
  }, 3000);
}

function joinParty() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) {
    return showToast('Digite seu nome ou apelido!');
  }
  myPlayerName = name;
  localStorage.setItem('jukebox_player_name', myPlayerName);

  socket.emit('registerPlayer', { playerId: myPlayerId, name: myPlayerName }, (res) => {
    if (res && res.ok) {
      myPlayerId = res.player.id;
      localStorage.setItem('jukebox_player_id', myPlayerId);
      document.getElementById('loginScreen').style.display = 'none';
      updateMyHeader(res.player);
    }
  });
}

let reclaimJbl = false;
socket.on('disconnect', () => {
  reclaimJbl = jblModeActive;
  jblModeActive = false;
  syncJblPlayer(null);
  updateJblUi();
});
socket.on('connect', async () => {
  if (reclaimJbl) {
    reclaimJbl = false;
    jblModeActive = await socket.claimPlayback();
    if (jblModeActive) syncJblPlayer(latestState?.currentSong);
    updateJblUi();
  }
  if (myPlayerName) {
    socket.emit('registerPlayer', { playerId: myPlayerId, name: myPlayerName }, (res) => {
      if (res && res.ok) {
        myPlayerId = res.player.id;
        localStorage.setItem('jukebox_player_id', myPlayerId);
        document.getElementById('loginScreen').style.display = 'none';
        updateMyHeader(res.player);
      }
    });
  }
});

function changeAppMode(mode) {
  socket.emit('hostAction', { action: 'setMode', payload: { mode } }, result => {
    if (result.ok) showToast(mode === 'livre' ? '🟢 Modo Livre ativado!' : '🔥 Modo Desafio ativado!');
  });
}

function updateMyHeader(me) {
  if (!me) return;
  document.getElementById('myAvatar').textContent = me.avatar || '🎸';
  document.getElementById('myName').textContent = me.name;
  document.getElementById('myAmmo').textContent = `💣 ${me.ammo}/3`;
  document.getElementById('myScore').textContent = `🏆 ${me.score} pts`;
  const isDesafio = latestState && latestState.mode === 'desafio';
  document.getElementById('ranzinzaBanner').style.display = (isDesafio && me.isRanzinza) ? 'block' : 'none';
}

function isMustVoteLocked() {
  if (!latestState || latestState.mode !== 'desafio' || !latestState.currentSong) {
    return false;
  }
  const s = latestState.currentSong;
  const isMine = s.realAddedById === myPlayerId;
  const alreadyVoted = (s.voterIds || []).includes(myPlayerId);
  return !isMine && !alreadyVoted;
}

socket.on('stateUpdate', (state) => {
  latestState = state;
  const isDesafio = state.mode === 'desafio';

  // Atualiza botões de modo no celular
  document.getElementById('mobBtnLivre').classList.toggle('active', !isDesafio);
  document.getElementById('mobBtnDesafio').classList.toggle('active', isDesafio);

  const playPauseBtn = document.getElementById('mobBtnPlayPause');
  if (playPauseBtn) {
    playPauseBtn.textContent = state.isPaused ? '▶️ Continuar' : '⏸️ Pausar';
  }

  syncJblPlayer(state.currentSong);
  updatePlaybackStatus();

  // Pré-aquece a próxima música da fila para tocar sem nenhum delay!
  if (state.queue && state.queue.length > 0 && jblModeActive) {
    const nextSong = state.queue[0];
    const endpoint = jblMediaMode === 'video'
      ? `/api/stream/${nextSong.videoId}`
      : `/api/audio/${nextSong.videoId}`;
    fetch(endpoint, { headers: { 'Range': 'bytes=0-0' } }).catch(() => {});
  }

  document.getElementById('desafioStatsBox').style.display = isDesafio ? 'flex' : 'none';
  document.getElementById('livreStatsBox').style.display = isDesafio ? 'none' : 'flex';

  const me = (state.players || []).find(p => p.id === myPlayerId);
  if (me) updateMyHeader(me);

  const nowMystery = document.getElementById('nowMysteryBadge');
  const nowContent = document.getElementById('nowPlayingContent');
  const voteArea = document.getElementById('voteArea');
  const promptTitle = document.getElementById('votePromptTitle');
  const btnLike = document.getElementById('btnVoteLike');
  const btnDislike = document.getElementById('btnVoteDislike');
  const dislikeSub = document.getElementById('dislikeBtnSub');

  if (!state.currentSong) {
    nowMystery.textContent = 'Silêncio no Telão';
    nowContent.innerHTML = `
      <div class="now-meta">
        <div class="now-title">Nenhuma música tocando</div>
        <div class="now-artist">Pesquise abaixo para colocar a primeira música!</div>
      </div>
    `;
    voteArea.style.display = 'none';
  } else {
    const s = state.currentSong;
    if (!s.isRevealed && isDesafio) {
      nowMystery.textContent = `🕵️ Mistério (${s.mysteryRemainingSeconds}s)`;
    } else {
      nowMystery.textContent = `🎧 Pedida por: ${s.addedBy.name}`;
    }

    const subStatus = isDesafio
      ? `<div style="font-size:12px; margin-top:4px; color:#38bdf8; font-weight:700;">👍 ${s.likesCount} Likes • 👎 ${s.dislikesEffective}/${s.dislikeThreshold} p/ Pular</div>`
      : `<div style="font-size:12px; margin-top:4px; color:#34d399; font-weight:700;">🟢 Modo Livre · sem votação</div>`;

    nowContent.innerHTML = `
      <img class="now-thumb" src="${escapeHtml(s.thumbnail)}" alt="Capa" />
      <div class="now-meta">
        <div class="now-title">${escapeHtml(s.title)}</div>
        <div class="now-artist">${escapeHtml(s.artist)}</div>
        ${subStatus}
      </div>
    `;

    // Área de Votação aparece apenas no Modo Desafio!
    if (!isDesafio) {
      voteArea.style.display = 'none';
    } else {
      voteArea.style.display = 'block';
      const isMine = s.realAddedById === myPlayerId;
      const alreadyVoted = (s.voterIds || []).includes(myPlayerId);
      const myAmmo = me ? me.ammo : 0;

      if (isMine) {
        voteArea.classList.remove('mandatory');
        promptTitle.style.color = '#a78bfa';
        promptTitle.textContent = s.isRevealed
          ? '🎸 Essa música foi pedida por VOCÊ!'
          : '🤫 Psiu! Essa música é SUA! Disfarce até os 30s acabarem!';
        btnLike.disabled = true;
        btnDislike.disabled = true;
      } else if (alreadyVoted) {
        voteArea.classList.remove('mandatory');
        promptTitle.style.color = '#34d399';
        promptTitle.textContent = '✅ Voto registrado nesta música! Pedidos liberados.';
        btnLike.disabled = true;
        btnDislike.disabled = true;
      } else {
        voteArea.classList.add('mandatory');
        promptTitle.style.color = '#fbbf24';
        promptTitle.textContent = '🚨 VOTO OBRIGATÓRIO! Vote para liberar seus pedidos:';
        btnLike.disabled = false;
        btnDislike.disabled = myAmmo <= 0;
        dislikeSub.textContent = myAmmo > 0 ? `Usa 1 💣 (Restam ${myAmmo})` : 'Sem 💣! Dê Likes p/ recarregar';
      }
    }
  }

  // Atualiza bloqueio de busca caso voto seja obrigatório no Modo Desafio
  const locked = isMustVoteLocked();
  document.getElementById('searchLockBanner').style.display = locked ? 'block' : 'none';
  document.getElementById('searchInput').disabled = locked;
  document.getElementById('btnSearchSubmit').disabled = locked;

  // Atualiza Fila no celular
  document.getElementById('mobQueueCount').textContent = state.queue.length;
  const qList = document.getElementById('mobQueueList');
  if (state.queue.length === 0) {
    qList.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:20px;">Nenhuma música na fila ainda.</div>`;
  } else {
    qList.innerHTML = state.queue.map((item, idx) => {
      const isMine = item.addedBy.id === myPlayerId;
      const who = isMine
        ? '⭐ VOCÊ'
        : (isDesafio ? '🕵️ Mistério' : escapeHtml(item.addedBy.name));
      return `
        <div class="song-item" style="${isMine ? 'border-color:#8b5cf6;' : ''}">
          <div style="font-weight:800; color:var(--text-muted); width:20px;">${idx + 1}</div>
          <img src="${escapeHtml(item.thumbnail)}" alt="" />
          <div class="song-item-info">
            <div class="song-item-title">${escapeHtml(item.title)}</div>
            <div class="song-item-sub">${escapeHtml(item.artist)} • <strong style="color:#c4b5fd;">${who}</strong></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Atualiza Ranking / Galera no celular
  const rList = document.getElementById('mobRankList');
  rList.innerHTML = (state.players || []).map((p, idx) => {
    const subText = isDesafio
      ? `Munição: ${'💣'.repeat(p.ammo)} • Tocadas: ${p.songsPlayed}`
      : `Músicas pedidas: ${p.songsPlayed}`;
    const rightText = isDesafio ? `${p.score} pts` : '🎵 Na festa';
    return `
      <div class="song-item" style="${p.id === myPlayerId ? 'border-color:#38bdf8;' : ''}">
        <div style="font-weight:900; width:24px; color:#fbbf24;">#${idx + 1}</div>
        <div class="song-item-info">
          <div class="song-item-title">
            ${p.avatar} ${escapeHtml(p.name)} ${(isDesafio && p.isRanzinza) ? '😡' : ''}
          </div>
          <div class="song-item-sub">${subText}</div>
        </div>
        <div style="font-weight:900; color:#38bdf8;">${rightText}</div>
      </div>
    `;
  }).join('');
});

function castVote(type) {
  socket.emit('voteSong', { type, songId: latestState?.currentSong?.id }, (res) => {
    if (!res || !res.ok) {
      showToast(res?.error || 'Não foi possível votar.');
    } else {
      showToast(type === 'like' ? '👍 Like enviado! (+2 pts)' : '👎 Dislike enviado!');
    }
  });
}

function sendReaction(emoji) {
  socket.emit('sendReaction', { playerId: myPlayerId, emoji });
}

function remoteControl(action) {
  if (action === 'togglePause' && jblModeActive) {
    if (jblVideoEl.paused) resumeJblPlayback();
    else jblVideoEl.pause();
    return;
  }
  socket.emit('hostAction', { action });
}

function switchTab(tab) {
  document.getElementById('tabSearch').style.display = tab === 'search' ? 'block' : 'none';
  document.getElementById('tabQueue').style.display = tab === 'queue' ? 'block' : 'none';
  document.getElementById('tabRank').style.display = tab === 'rank' ? 'block' : 'none';

  document.getElementById('tabBtnSearch').classList.toggle('active', tab === 'search');
  document.getElementById('tabBtnQueue').classList.toggle('active', tab === 'queue');
  document.getElementById('tabBtnRank').classList.toggle('active', tab === 'rank');
}

let suggestTimer = null;
function onSearchInput(val) {
  toggleClearBtn();
  const trimmed = val.trim();
  clearTimeout(suggestTimer);
  if (trimmed.length < 2) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => {
    fetchSuggestions(trimmed);
  }, 220);
}

async function fetchSuggestions(term) {
  try {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(term)}`);
    if (!res.ok) return hideSuggestions();
    const data = await res.json();
    const suggestions = data.suggestions || [];
    renderSuggestions(suggestions);
  } catch {
    hideSuggestions();
  }
}

function renderSuggestions(list) {
  const box = document.getElementById('searchSuggestionsBox');
  if (!box) return;
  if (!list || list.length === 0) {
    box.style.display = 'none';
    return;
  }

  box.innerHTML = list.map(item => `
    <div class="suggestion-item" onclick="selectSuggestion('${escapeHtml(item).replace(/'/g, "\\'")}')">
      <span class="icon">🔍</span>
      <span>${escapeHtml(item)}</span>
    </div>
  `).join('');
  box.style.display = 'flex';
}

function hideSuggestions() {
  const box = document.getElementById('searchSuggestionsBox');
  if (box) box.style.display = 'none';
}

function selectSuggestion(query) {
  const inp = document.getElementById('searchInput');
  inp.value = query;
  hideSuggestions();
  toggleClearBtn();
  executeSearch(query);
}

if (typeof document.addEventListener === 'function') {
  document.addEventListener('click', (e) => {
    if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.search-input-wrap')) {
      hideSuggestions();
    }
  });
}

function toggleClearBtn() {
  const inp = document.getElementById('searchInput');
  const btn = document.getElementById('btnClearSearch');
  btn.style.display = inp.value.length > 0 ? 'flex' : 'none';
}

function clearSearchInput() {
  const inp = document.getElementById('searchInput');
  inp.value = '';
  toggleClearBtn();
  hideSuggestions();
  inp.focus();
}

let searchController;
async function handleSearch(e) {
  if (e) e.preventDefault();
  hideSuggestions();
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  executeSearch(q);
}

async function executeSearch(query) {
  if (isMustVoteLocked()) {
    return showToast('Vote 👍 ou 👎 na música atual primeiro!');
  }

  searchController?.abort();
  const controller = searchController = new AbortController();
  const resultsBox = document.getElementById('searchResults');
  resultsBox.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted);">🔎 Buscando músicas...</div>`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Busca indisponível.');
    const data = await res.json();
    currentSearchResults = data.results || [];
    if (currentSearchResults.length === 0) {
      resultsBox.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted);">Nenhuma música encontrada.</div>`;
      return;
    }

    resultsBox.innerHTML = currentSearchResults.map((song, idx) => `
      <div class="song-item">
        <img src="${escapeHtml(song.thumbnail)}" alt="Capa" />
        <div class="song-item-info">
          <div class="song-item-title">${escapeHtml(song.title)}</div>
          <div class="song-item-sub">${escapeHtml(song.artist)} • ${escapeHtml(song.duration)}</div>
        </div>
        <button type="button" class="btn-add" onclick="addSongByIndex(${idx}, this)">
          + Fila
        </button>
      </div>
    `).join('');
  } catch (err) {
    if (err.name === 'AbortError') return;
    resultsBox.innerHTML = `<div style="text-align:center; padding:24px; color:#ef4444;">Erro ao buscar músicas. Tente novamente.</div>`;
  }
}

function addSongByIndex(idx, btnEl) {
  const song = currentSearchResults[idx];
  if (!song) return;

  if (isMustVoteLocked()) {
    return showToast('Vote na música atual primeiro para liberar!');
  }
  // Pré-aquece a extração da mídia no servidor de imediato ao clicar em adicionar
  fetch(`/api/audio/${song.videoId}`, { headers: { 'Range': 'bytes=0-0' } }).catch(() => {});
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'Adicionando...';
  }
  socket.emit('addSong', { playerId: myPlayerId, name: myPlayerName, song }, (res) => {
    if (!res || !res.ok) {
      showToast(res?.error || 'Erro ao adicionar');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '+ Fila';
      }
    } else {
      showToast('🎵 Música adicionada! Já vai tocar no Telão!');
      if (btnEl) {
        btnEl.textContent = '✓ Na Fila';
      }
    }
  });
}

updateJblUi();
