const socket = createPartySocket();
let myPlayerId = localStorage.getItem('jukebox_player_id');
let myPlayerName = localStorage.getItem('jukebox_player_name') || '';
let latestState = null;
let lastYou = null;
let partyCode = readPartyFromUrl() || (() => {
  try {
    const last = localStorage.getItem('jukebox_last_party');
    const lastCreated = Number(localStorage.getItem('jukebox_last_party_created') || 0);
    if (lastCreated && (Date.now() - lastCreated) > 10 * 60 * 60 * 1000) {
      localStorage.removeItem('jukebox_last_party');
      return null;
    }
    return last;
  } catch { return null; }
})();
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
    const miniBar = document.getElementById('topMiniProgressBar');
    if (miniBar) miniBar.style.width = pct + '%';

    const curLabel = document.getElementById('playerCurrentTime');
    if (curLabel) curLabel.textContent = formatTime(current);

    const totLabel = document.getElementById('playerTotalTime');
    if (totLabel) totLabel.textContent = formatTime(total);
  }
}

function seekJblPlayer(e) {
  const track = document.getElementById('playerProgressTrack');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, clickX / rect.width));

  if (ytFallbackActive && mobYtPlayer && typeof mobYtPlayer.getDuration === 'function') {
    const total = mobYtPlayer.getDuration() || 0;
    if (total > 0) {
      mobYtPlayer.seekTo(ratio * total, true);
    }
    return;
  }

  const el = jblVideoEl;
  if (!el || !el.duration) return;
  el.currentTime = ratio * el.duration;
  onJblTimeUpdate();
}

function toggleJblPlayPause() {
  try { if (navigator.vibrate) navigator.vibrate(18); } catch (e) {}
  if (!jblModeActive) {
    toggleJblMode();
    return;
  }
  if (ytFallbackActive && mobYtPlayer && typeof mobYtPlayer.getPlayerState === 'function') {
    const s = mobYtPlayer.getPlayerState();
    if (s === 1) { // PLAYING
      mobYtPlayer.pauseVideo();
    } else {
      mobYtPlayer.playVideo();
    }
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
  const miniIconPlay = document.getElementById('miniIconPlay');
  const miniIconPause = document.getElementById('miniIconPause');
  const eq = document.getElementById('playerEqAnimation');
  const isPlaying = status === 'playing';

  if (iconPlay && iconPause) {
    iconPlay.style.display = isPlaying ? 'none' : 'block';
    iconPause.style.display = isPlaying ? 'block' : 'none';
  }
  if (miniIconPlay && miniIconPause) {
    miniIconPlay.style.display = isPlaying ? 'none' : 'block';
    miniIconPause.style.display = isPlaying ? 'block' : 'none';
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
    if (error.name !== 'NotAllowedError' && latestState?.currentSong) {
      activateYtFallback(latestState.currentSong);
    }
  }
}

function resumeJblPlayback() {
  if (!jblModeActive) return;
  if (ytFallbackActive) {
    if (mobYtPlayer && typeof mobYtPlayer.playVideo === 'function') {
      try { mobYtPlayer.playVideo(); } catch (e) {}
    }
    return;
  }
  if (jblPlaybackState === 'error') {
    if (latestState?.currentSong) {
      activateYtFallback(latestState.currentSong);
      return;
    }
    jblRecovery.reset();
    jblVideoEl.load();
    updatePlaybackStatus('loading');
  }
  // Chamado diretamente pelo clique, preservando a permissão de áudio do navegador.
  playJblMedia();
}

for (const element of [jblAudioEl, jblClipEl]) {
  for (const [event, status] of [['loadstart', 'loading'], ['waiting', 'loading'], ['playing', 'playing'], ['pause', 'paused']]) {
    element.addEventListener(event, () => {
      if (element === jblVideoEl && jblModeActive && jblCurrentSongId && !ytFallbackActive) updatePlaybackStatus(status);
    });
  }

  element.addEventListener('error', () => {
    if (element === jblVideoEl && jblModeActive && jblCurrentSongId && !ytFallbackActive) {
      updatePlaybackStatus('error');
      if (latestState?.currentSong) {
        activateYtFallback(latestState.currentSong);
      }
    }
  });

  element.addEventListener('timeupdate', () => {
    if (element === jblVideoEl && jblModeActive && !ytFallbackActive) onJblTimeUpdate();
  });

  element.addEventListener('ended', () => {
    if (element === jblVideoEl && jblModeActive && jblCurrentSongId && !ytFallbackActive) {
      socket.emit('hostAction', {
        action: 'songEnded',
        payload: { songId: jblCurrentSongId }
      });
    }
  });

  element.addEventListener('pause', () => {
    if (element === jblVideoEl && jblModeActive && jblCurrentVideoId && !jblVideoEl.ended && !ytFallbackActive) {
      socket.emit('hostAction', { action: 'syncPauseState', payload: { paused: true } });
    }
  });

  element.addEventListener('play', () => {
    if (element === jblVideoEl && jblModeActive && jblCurrentVideoId && !ytFallbackActive) {
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
    requestScreenWakeLock();
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
    releaseScreenWakeLock();
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

// ==========================================
// TRAVA DE TELA (SCREEN WAKE LOCK MANAGER)
// ==========================================
let wakeLockSentinel = null;
let userWakeLockEnabled = true;
let noSleepVideoEl = null;

function enableNoSleepFallback() {
  if (typeof document === 'undefined' || !document.createElement) return;
  if (!noSleepVideoEl) {
    noSleepVideoEl = document.createElement('video');
    noSleepVideoEl.setAttribute('playsinline', '');
    noSleepVideoEl.setAttribute('muted', '');
    noSleepVideoEl.setAttribute('loop', '');
    noSleepVideoEl.src = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAADpmcmVlAAABzW1kYXQAAAAAAAABAAAAAGQAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
    noSleepVideoEl.style.position = 'fixed';
    noSleepVideoEl.style.bottom = '-9999px';
    noSleepVideoEl.style.opacity = '0.01';
    noSleepVideoEl.style.pointerEvents = 'none';
    if (document.body && document.body.appendChild) document.body.appendChild(noSleepVideoEl);
  }
  try { noSleepVideoEl.play().catch(() => {}); } catch (e) {}
}

function disableNoSleepFallback() {
  if (noSleepVideoEl) {
    try { noSleepVideoEl.pause(); } catch (e) {}
  }
}

async function requestScreenWakeLock() {
  if (!userWakeLockEnabled) return;
  try {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && navigator.wakeLock) {
      if (wakeLockSentinel !== null && !wakeLockSentinel.released) return;
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
        if (userWakeLockEnabled && jblModeActive) {
          updateWakeLockUi(false);
        }
      });
      updateWakeLockUi(true);
      return;
    }
  } catch (e) {}
  enableNoSleepFallback();
  updateWakeLockUi(true);
}

function releaseScreenWakeLock() {
  if (wakeLockSentinel) {
    try { wakeLockSentinel.release().catch(() => {}); } catch (e) {}
    wakeLockSentinel = null;
  }
  disableNoSleepFallback();
  updateWakeLockUi(false);
}

function updateWakeLockUi(active) {
  if (typeof document === 'undefined') return;
  const pill = document.getElementById('wakeLockStatus');
  const txt = document.getElementById('wakeLockText');
  if (!pill || !txt) return;
  pill.classList.toggle('disabled', !active);
  txt.textContent = active ? '💡 Tela sempre ativa: Ligada' : '💡 Tela sempre ativa: Desligada';
}

function toggleUserWakeLock() {
  userWakeLockEnabled = !userWakeLockEnabled;
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(20); } catch (e) {}
  if (userWakeLockEnabled) {
    requestScreenWakeLock();
    showToast('💡 Tela sempre ativa ATIVADA! O celular não vai apagar.');
  } else {
    releaseScreenWakeLock();
    showToast('💤 Tela sempre ativa DESATIVADA.');
  }
}

// ==========================================
// FALLBACK DO PLAYER OFICIAL YOUTUBE (PLANO B)
// ==========================================
let ytFallbackActive = false;
let mobYtPlayer = null;
let ytProgressTimer = null;
let pendingYtFallbackSong = null;
let isYtApiReady = false;

function loadYtIframeApi() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (typeof window !== 'undefined' && window.YT && window.YT.Player) {
    isYtApiReady = true;
    return;
  }
  if (typeof window !== 'undefined' && window._ytApiLoading) return;
  if (typeof window !== 'undefined') window._ytApiLoading = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  const first = typeof document.getElementsByTagName === 'function' ? document.getElementsByTagName('script')[0] : null;
  if (first && first.parentNode) first.parentNode.insertBefore(tag, first);
  else if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(tag);
  else if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(tag);
}

if (typeof window !== 'undefined') {
  window.onYouTubeIframeAPIReady = function() {
    isYtApiReady = true;
    if (ytFallbackActive && pendingYtFallbackSong) {
      activateYtFallback(pendingYtFallbackSong);
    }
  };
  // Pré-carrega a biblioteca oficial do YouTube para reprodução instantânea
  loadYtIframeApi();
}

function activateYtFallback(song) {
  if (!song || !jblModeActive) return;
  pendingYtFallbackSong = song;
  ytFallbackActive = true;
  requestScreenWakeLock();

  if (jblVideoEl) {
    try {
      jblVideoEl.pause();
      jblVideoEl.removeAttribute('src');
    } catch (e) {}
  }
  const btnResume = document.getElementById('btnResumeAudio');
  if (btnResume) {
    btnResume.hidden = false;
    btnResume.textContent = '▶ Tocar música (YouTube)';
  }

  const box = document.getElementById('mobYtFallbackBox');
  if (box) box.style.display = 'block';

  jblCurrentSongId = song.id;
  jblCurrentVideoId = song.videoId;
  updateJblUi();
  updateMediaSession(song);

  if (typeof window === 'undefined' || !window.YT || !window.YT.Player) {
    loadYtIframeApi();
    showToast('⚡ Conectando reprodução direta do YouTube...');
    return;
  }

  if (mobYtPlayer && typeof mobYtPlayer.loadVideoById === 'function') {
    try {
      mobYtPlayer.loadVideoById(song.videoId);
      updatePlaybackStatus(latestState?.isPaused ? 'paused' : 'playing');
    } catch (e) {}
    return;
  }

  const container = document.getElementById('mobYtPlayer');
  if (!container) return;

  try {
    mobYtPlayer = new window.YT.Player('mobYtPlayer', {
      height: '100%',
      width: '100%',
      videoId: song.videoId,
      playerVars: {
        autoplay: 1,
        controls: 1,
        playsinline: 1,
        rel: 0,
        modestbranding: 1
      },
      events: {
        onReady: (e) => {
          if (!latestState?.isPaused) {
            try { e.target.playVideo(); } catch (err) {}
          }
        },
        onStateChange: onMobYtStateChange,
        onError: (err) => {
          console.warn('Erro no player do YouTube:', err);
        }
      }
    });
  } catch (err) {
    console.warn('Falha ao instanciar YouTube Player:', err);
  }
}

function onMobYtStateChange(e) {
  if (typeof window === 'undefined' || !window.YT) return;
  const state = e.data;
  const btnResume = document.getElementById('btnResumeAudio');
  if (state === window.YT.PlayerState.PLAYING) {
    updatePlaybackStatus('playing');
    jblPlaybackState = 'playing';
    if (btnResume) btnResume.hidden = true;
    requestScreenWakeLock();

    clearInterval(ytProgressTimer);
    ytProgressTimer = setInterval(() => {
      if (!mobYtPlayer || typeof mobYtPlayer.getCurrentTime !== 'function') return;
      const cur = mobYtPlayer.getCurrentTime() || 0;
      const total = mobYtPlayer.getDuration() || 0;
      if (total > 0) {
        const pct = Math.min(100, Math.max(0, (cur / total) * 100));
        const bar = document.getElementById('playerProgressBar');
        if (bar) bar.style.width = pct + '%';
        const miniBar = document.getElementById('topMiniProgressBar');
        if (miniBar) miniBar.style.width = pct + '%';
        const curLabel = document.getElementById('playerCurrentTime');
        if (curLabel) curLabel.textContent = formatTime(cur);
        const totLabel = document.getElementById('playerTotalTime');
        if (totLabel) totLabel.textContent = formatTime(total);
      }
    }, 400);
  } else if (state === window.YT.PlayerState.PAUSED) {
    updatePlaybackStatus('paused');
    jblPlaybackState = 'paused';
    if (btnResume) {
      btnResume.hidden = false;
      btnResume.textContent = '▶ Continuar música';
    }
  } else if (state === 5 /* CUED - Autoplay bloqueado pelo navegador */) {
    updatePlaybackStatus('blocked');
    if (btnResume) {
      btnResume.hidden = false;
      btnResume.textContent = '▶ Tocar música (Liberar som)';
    }
  } else if (state === window.YT.PlayerState.ENDED) {
    clearInterval(ytProgressTimer);
    if (jblModeActive && jblCurrentSongId) {
      socket.emit('hostAction', {
        action: 'songEnded',
        payload: { songId: jblCurrentSongId }
      });
    }
  }
}

const recoveries = new Map([jblAudioEl, jblClipEl].map(element => [element, attachMediaRecovery(element, {
  isActive: () => jblModeActive && element === jblVideoEl,
  source: () => jblCurrentVideoId ? (element === jblClipEl ? '/api/stream/' : '/api/audio/') + jblCurrentVideoId : null,
  play: () => { if (!latestState?.isPaused) playJblMedia(); },
  failed: () => {
    updatePlaybackStatus('error');
    if (latestState?.currentSong) {
      activateYtFallback(latestState.currentSong);
    }
  }
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
    if (mobYtPlayer && typeof mobYtPlayer.stopVideo === 'function') {
      try { mobYtPlayer.stopVideo(); } catch (err) {}
    }
    const ytBox = document.getElementById('mobYtFallbackBox');
    if (ytBox) ytBox.style.display = 'none';
    clearInterval(ytProgressTimer);
    ytFallbackActive = false;
    jblVideoEl.pause();
    jblVideoEl.removeAttribute('src');
    jblVideoEl.load();
    return;
  }

  box.style.display = 'block';
  updateJblUi();

  if (ytFallbackActive) {
    if (song.id !== jblCurrentSongId || song.videoId !== jblCurrentVideoId) {
      activateYtFallback(song);
    }
    return;
  }

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

let jblPreloadMediaEl = null;
function preloadNextSongAudio(videoId, isVideo) {
  if (!videoId || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (!jblPreloadMediaEl) {
    jblPreloadMediaEl = document.createElement(isVideo ? 'video' : 'audio');
    jblPreloadMediaEl.preload = 'auto';
    jblPreloadMediaEl.muted = true;
    jblPreloadMediaEl.style.display = 'none';
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(jblPreloadMediaEl);
    }
  }
  const targetSrc = (isVideo ? '/api/stream/' : '/api/audio/') + videoId;
  if (!jblPreloadMediaEl.src || !jblPreloadMediaEl.src.endsWith(targetSrc)) {
    jblPreloadMediaEl.src = targetSrc;
    jblPreloadMediaEl.load();
  }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && jblModeActive && userWakeLockEnabled) {
      requestScreenWakeLock();
    }
  });
}

async function openQrModal() {
  if (!socket.party.code) return;
  document.getElementById('qrModal').style.display = 'flex';
  document.getElementById('mobQrCode').textContent = socket.party.code;
  try {
    const res = await fetch('/api/qrcode?festa=' + encodeURIComponent(socket.party.code));
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

function sharePartyWhatsApp() {
  try { if (navigator.vibrate) navigator.vibrate(20); } catch (e) {}
  const code = socket.party?.code || partyCode;
  const url = partyInviteUrl || window.location.href;
  const msg = encodeURIComponent(`🎉 Vem pra nossa festa no Jukebox da Galera!\n🎵 Peça suas músicas aqui: ${url}\n🔑 Código da festa: ${code}`);
  window.open(`https://api.whatsapp.com/send?text=${msg}`, '_blank');
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
if (partyCode) {
  document.getElementById('partyCodeInput').value = partyCode;
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

function readLoginName() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) {
    showToast('Digite seu nome ou apelido!');
    return null;
  }
  myPlayerName = name;
  localStorage.setItem('jukebox_player_name', myPlayerName);
  return name;
}

function showLogin(message) {
  document.getElementById('loginScreen').style.display = 'flex';
  if (message) {
    document.getElementById('loginHint').textContent = message;
    showToast(message);
  }
}

// Entra na festa pelo código e registra o apelido. "silent" = reconexão automática.
async function enterParty(code, name, silent = false) {
  code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) {
    if (!silent) showToast('Digite o código da festa (está no QR Code / Telão).');
    return false;
  }
  const joined = await socket.joinParty(code);
  if (!joined.ok) {
    if (!silent) {
      showLogin(joined.error || 'Festa não encontrada.');
    }
    return false;
  }
  return finishEntry(joined.code, name);
}

async function finishEntry(code, name) {
  partyCode = code;
  setPartyInUrl(code);
  document.getElementById('partyCodeInput').value = code;
  document.getElementById('myPartyCode').textContent = '🎉 ' + code;
  const res = await new Promise(resolve => socket.emit('registerPlayer', { name }, resolve));
  if (!res || !res.ok) return false;
  myPlayerId = res.player.id;
  localStorage.setItem('jukebox_player_id', myPlayerId);
  document.getElementById('loginScreen').style.display = 'none';
  updateMyHeader(res.player);
  return true;
}

async function joinParty() {
  const name = readLoginName();
  if (!name) return;
  const codeInput = document.getElementById('partyCodeInput');
  const code = codeInput ? codeInput.value.trim() : '';
  const success = await enterParty(code, name);
  if (!success) {
    // Se o código digitado ou salvo na URL não existe (ex: servidor reiniciou),
    // cria uma nova festa na hora para o usuário entrar sem travar!
    showToast('Festa anterior expirou. Criando uma nova festa para você...');
    await createPartyHere();
  }
}

async function createPartyHere() {
  const name = readLoginName();
  if (!name) return;
  const created = await socket.createParty();
  if (!created.ok) return showToast(created.error || 'Não foi possível criar a festa.');
  if (await finishEntry(created.code, name)) {
    showToast(`🎉 Festa criada! Código ${created.code}`);
    // Assume automaticamente o som da festa no aparelho que acabou de criar a sala
    jblModeActive = true;
    updateJblUi();
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
    playJblMedia();
    socket.claimPlayback().catch(() => {});
    openQrModal();
  }
}

socket.onPartyLost = result => showLogin(result?.error || 'A festa não existe mais. Entre em outra ou crie uma nova.');

let reclaimJbl = false;
socket.on('disconnect', () => {
  reclaimJbl = jblModeActive;
  jblModeActive = false;
  syncJblPlayer(null);
  updateJblUi();
});
socket.on('connect', async () => {
  // Entra sozinho na última festa (ou na do QR) se já tiver apelido salvo.
  const code = socket.party.code || partyCode;
  if (!myPlayerName || !code) return;
  if (!await enterParty(code, myPlayerName, true)) return;
  if (reclaimJbl) {
    reclaimJbl = false;
    jblModeActive = await socket.claimPlayback();
    if (jblModeActive) syncJblPlayer(latestState?.currentSong);
    updateJblUi();
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
  const isMine = Boolean(lastYou?.currentIsMine);
  const alreadyVoted = (s.voterIds || []).includes(myPlayerId);
  return !isMine && !alreadyVoted;
}

const mysteryClock = createMysteryClock(seconds => {
  const badge = document.getElementById('nowMysteryBadge');
  if (badge && badge.dataset.mystery === '1') badge.textContent = `🕵️ Mistério (${seconds}s)`;
});

socket.on('stateUpdate', (state, you) => {
  latestState = state;
  lastYou = you || null;
  const isDesafio = state.mode === 'desafio';
  if (document.body?.classList) {
    document.body.classList.toggle('is-host', Boolean(you?.isHost));
    document.body.classList.toggle('can-control', you ? Boolean(you.canControl) : true);
  }
  const guestsInput = document.getElementById('guestsControlInput');
  if (state.settings) guestsInput.checked = Boolean(state.settings.guestsControl);
  const themeBanner = document.getElementById('themeBanner');
  themeBanner.hidden = !state.theme;
  if (state.theme) themeBanner.innerHTML = `🎨 Rodada temática: <strong>${escapeHtml(state.theme)}</strong>`;
  const dedicationEl = document.getElementById('nowDedication');
  const ded = state.currentSong?.dedication;
  dedicationEl.hidden = !ded;
  if (ded) dedicationEl.textContent = `💌 ${ded}`;

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
    preloadNextSongAudio(nextSong.videoId, jblMediaMode === 'video');
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

  const searchHint = document.getElementById('searchNowPlayingHint');
  const searchHintText = document.getElementById('searchNowPlayingText');

  if (!state.currentSong) {
    nowMystery.textContent = 'Silêncio no Telão';
    nowContent.innerHTML = `
      <div class="now-meta">
        <div class="now-title">Nenhuma música tocando</div>
        <div class="now-artist">Toque em Buscar para pedir uma música!</div>
        <button type="button" class="btn-goto-search" onclick="switchTab('search')">🔍 Ir para Buscar Músicas</button>
      </div>
    `;
    voteArea.style.display = 'none';
    if (searchHint) searchHint.style.display = 'none';
  } else {
    if (searchHint) searchHint.style.display = 'flex';
    if (searchHintText) searchHintText.textContent = `Tocando: ${state.currentSong.title} • ${state.currentSong.artist}`;
    const s = state.currentSong;
    if (!s.isRevealed && isDesafio) {
      nowMystery.dataset.mystery = '1';
      nowMystery.textContent = `🕵️ Mistério (${s.mysteryRemainingSeconds}s)`;
      mysteryClock.update(s, state.isPaused);
    } else {
      nowMystery.dataset.mystery = '';
      mysteryClock.update(null);
      nowMystery.textContent = `🎧 Pedida por: ${s.addedBy.name}`;
    }

    const remainingToVeto = s.dislikeThreshold - s.dislikesEffective;
    const isVetoDanger = isDesafio && remainingToVeto === 1 && s.dislikeThreshold > 1;
    const vetoThreatNotice = isVetoDanger
      ? `<div class="veto-danger-pill">⚠️ PERIGO: Falta apenas 1 Dislike para derrubar essa música! 💣💥</div>`
      : '';

    const subStatus = isDesafio
      ? `<div style="font-size:12px; margin-top:4px; color:#38bdf8; font-weight:700;">👍 ${s.likesCount} Likes • 👎 ${s.dislikesEffective}/${s.dislikeThreshold} p/ Pular</div>${vetoThreatNotice}`
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
      const isMine = Boolean(lastYou?.currentIsMine);
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
  const mobCountEl = document.getElementById('mobQueueCount');
  const prevQueueCount = Number(mobCountEl?.textContent || 0);
  const newQueueCount = state.queue.length;
  if (mobCountEl) mobCountEl.textContent = newQueueCount;
  if (newQueueCount > prevQueueCount) {
    const btnQueue = document.getElementById('tabBtnQueue');
    if (btnQueue) {
      btnQueue.classList.remove('queue-bump');
      void btnQueue.offsetWidth;
      btnQueue.classList.add('queue-bump');
      setTimeout(() => btnQueue.classList.remove('queue-bump'), 800);
    }
  }
  const qList = document.getElementById('mobQueueList');
  if (state.queue.length === 0) {
    qList.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:20px;">Nenhuma música na fila ainda.</div>`;
  } else {
    qList.innerHTML = state.queue.map((item, idx) => {
      const isMine = (lastYou?.mySongIds || []).includes(item.id) || item.addedBy.id === myPlayerId;
      const removable = isMine || lastYou?.isHost;
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
            ${item.dedication ? `<div class="song-item-sub">💌 ${escapeHtml(item.dedication)}</div>` : ''}
          </div>
          ${removable ? `<button type="button" class="btn-remove" data-remove-song="${escapeHtml(item.id)}" aria-label="Remover da fila">✕</button>` : ''}
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
            ${escapeHtml(p.avatar)} ${escapeHtml(p.name)} ${(isDesafio && p.isRanzinza) ? '😡' : ''}
            <span class="ach-row">${(p.achievements || []).map(a => `<span title="${escapeHtml(a.name)}">${escapeHtml(a.icon)}</span>`).join('')}</span>
          </div>
          <div class="song-item-sub">${subText}</div>
        </div>
        <div style="font-weight:900; color:#38bdf8;">${rightText}</div>
      </div>
    `;
  }).join('');

  // Sincroniza botões da busca atual com o estado da fila / música tocando
  refreshSearchResultsButtons();
  updateTopMiniPlayerBar();
});

let currentActiveTab = 'search';

function parseDurationToSeconds(dur) {
  if (typeof dur === 'number') return dur;
  if (!dur || typeof dur !== 'string') return 0;
  const parts = dur.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function updateTopMiniPlayerBar() {
  const bar = document.getElementById('topMiniPlayerBar');
  if (!bar) return;
  if (!latestState || !latestState.currentSong || currentActiveTab === 'player') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const song = latestState.currentSong;
  const titleEl = document.getElementById('miniPlayerTitle');
  const artistEl = document.getElementById('miniPlayerArtist');
  if (titleEl) titleEl.textContent = song.title;
  if (artistEl) artistEl.textContent = song.artist;

  const isPlaying = jblModeActive ? !jblVideoEl.paused : !latestState.isPaused;
  const playIcon = document.getElementById('miniIconPlay');
  const pauseIcon = document.getElementById('miniIconPause');
  if (playIcon && pauseIcon) {
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
  }

  if (!jblModeActive && song) {
    const elapsed = song.elapsedSeconds || 0;
    const total = parseDurationToSeconds(song.duration);
    const miniBar = document.getElementById('topMiniProgressBar');
    if (miniBar) {
      const pct = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
      miniBar.style.width = pct + '%';
    }
    const playerBar = document.getElementById('playerProgressBar');
    if (playerBar && total > 0) {
      const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
      playerBar.style.width = pct + '%';
    }
    const curLabel = document.getElementById('playerCurrentTime');
    if (curLabel) curLabel.textContent = formatTime(elapsed);
    const totLabel = document.getElementById('playerTotalTime');
    if (totLabel && total > 0) totLabel.textContent = formatTime(total);
  }
}

function handleMiniPlayPause() {
  try { if (navigator.vibrate) navigator.vibrate(18); } catch (e) {}
  if (jblModeActive) {
    toggleJblPlayPause();
  } else {
    remoteControl('togglePause');
  }
}

function castVote(type) {
  socket.emit('voteSong', { type, songId: latestState?.currentSong?.id }, (res) => {
    if (!res || !res.ok) {
      showToast(res?.error || 'Não foi possível votar.');
    } else {
      showToast(type === 'like' ? '👍 Like enviado! (+2 pts)' : '👎 Dislike enviado!');
    }
  });
}

function spawnLocalReaction(emoji, x, y) {
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;

  const rot = (Math.random() * 26 - 13).toFixed(1);
  el.style.setProperty('--rot', `${rot}deg`);

  if (x && y) {
    const left = Math.max(16, Math.min(window.innerWidth - 75, x - 28 + (Math.random() * 30 - 15)));
    el.style.left = `${left}px`;
    el.style.top = `${y - 45}px`;
    el.style.bottom = 'auto';
  } else {
    el.style.left = `${Math.floor(15 + Math.random() * 70)}%`;
  }

  document.body.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 2200);
}

function sendReaction(emoji, evt) {
  try { if (navigator.vibrate) navigator.vibrate(18); } catch (e) {}
  if (evt) {
    if (evt.cancelable && evt.type === 'touchstart') {
      evt.preventDefault();
    }
    const x = evt.clientX || (evt.touches && evt.touches[0] ? evt.touches[0].clientX : null);
    const y = evt.clientY || (evt.touches && evt.touches[0] ? evt.touches[0].clientY : null);
    spawnLocalReaction(emoji, x, y);
  } else {
    spawnLocalReaction(emoji);
  }
  socket.emit('sendReaction', { playerId: myPlayerId, emoji });
}

socket.on('liveReaction', ({ emoji }) => {
  spawnLocalReaction(emoji);
});

socket.on('songVetoed', (info) => {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate([160, 80, 160]); } catch (e) {}
  }
  showToast(`💣 MÚSICA DERRUBADA! A galera vetou "${info?.title || 'a música'}"!`);
});

function remoteControl(action) {
  try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
  if (lastYou && !lastYou.canControl) {
    return showToast('🔒 O anfitrião deixou os controles só com ele.');
  }
  if (action === 'togglePause' && jblModeActive) {
    if (jblVideoEl.paused) resumeJblPlayback();
    else jblVideoEl.pause();
    return;
  }
  socket.emit('hostAction', { action });
}

function switchTab(tab) {
  currentActiveTab = tab;
  const p = document.getElementById('tabPlayer');
  const s = document.getElementById('tabSearch');
  const q = document.getElementById('tabQueue');
  const r = document.getElementById('tabRank');

  if (p) p.style.display = tab === 'player' ? 'block' : 'none';
  if (s) s.style.display = tab === 'search' ? 'block' : 'none';
  if (q) q.style.display = tab === 'queue' ? 'block' : 'none';
  if (r) r.style.display = tab === 'rank' ? 'block' : 'none';

  document.getElementById('tabBtnPlayer')?.classList.toggle('active', tab === 'player');
  document.getElementById('tabBtnSearch')?.classList.toggle('active', tab === 'search');
  document.getElementById('tabBtnQueue')?.classList.toggle('active', tab === 'queue');
  document.getElementById('tabBtnRank')?.classList.toggle('active', tab === 'rank');

  updateTopMiniPlayerBar();
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
  if (!btn) return;
  const hasText = inp && inp.value.trim().length > 0;
  const hasResults = currentSearchResults && currentSearchResults.length > 0;
  btn.style.display = (hasText || hasResults) ? 'flex' : 'none';
}

function closeSearchResults() {
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
  currentSearchResults = [];
  const inp = document.getElementById('searchInput');
  if (inp) inp.value = '';
  toggleClearBtn();
  hideSuggestions();
  const resultsBox = document.getElementById('searchResults');
  if (resultsBox) {
    resultsBox.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 13px; padding: 24px 10px;">
        Pesquise qualquer música ou clipe do <strong>YouTube Music</strong>!<br/>
        <small>Você pode adicionar quantas quiser (a fila organiza até 2 seguidas por pessoa).</small>
      </div>
    `;
  }
}

function clearSearchInput() {
  closeSearchResults();
  const inp = document.getElementById('searchInput');
  if (inp) inp.focus();
}

document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSearchResults();
    e.target.blur();
  }
});

function refreshSearchResultsButtons() {
  if (!currentSearchResults || currentSearchResults.length === 0) return;
  const queueVideoIds = new Set((latestState?.queue || []).map(item => item.videoId));
  const currentVideoId = latestState?.currentSong?.videoId;

  const buttons = document.querySelectorAll('#searchResults .btn-add');
  buttons.forEach(btn => {
    if (btn.dataset.adding === '1') return;
    const vid = btn.dataset.vid;
    if (!vid) return;

    const inQueue = queueVideoIds.has(vid);
    const isPlaying = currentVideoId && currentVideoId === vid;

    if (inQueue) {
      btn.disabled = true;
      btn.textContent = '✓ Na Fila';
      btn.classList.add('in-queue');
      btn.classList.remove('is-playing');
    } else if (isPlaying) {
      btn.disabled = true;
      btn.textContent = '▶ Tocando';
      btn.classList.add('is-playing');
      btn.classList.remove('in-queue');
    } else {
      btn.disabled = false;
      btn.textContent = '+ Fila';
      btn.classList.remove('in-queue');
      btn.classList.remove('is-playing');
    }
  });
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
  resultsBox.innerHTML = `
    <div class="search-results-header">
      <span class="search-results-count">Buscando...</span>
      <button type="button" class="btn-close-results" onclick="closeSearchResults()">✕ Fechar</button>
    </div>
    <div style="text-align:center; padding:24px; color:var(--text-muted);">🔎 Buscando músicas no YouTube Music...</div>
  `;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Busca indisponível.');
    const data = await res.json();
    currentSearchResults = data.results || [];
    toggleClearBtn();

    if (currentSearchResults.length === 0) {
      resultsBox.innerHTML = `
        <div class="search-results-header">
          <span class="search-results-count">Nenhuma música encontrada</span>
          <button type="button" class="btn-close-results" onclick="closeSearchResults()">✕ Fechar busca</button>
        </div>
        <div style="text-align:center; padding:24px; color:var(--text-muted);">Tente pesquisar por outro nome ou artista.</div>
      `;
      return;
    }

    const queueVideoIds = new Set((latestState?.queue || []).map(item => item.videoId));
    const currentVideoId = latestState?.currentSong?.videoId;

    const listHtml = currentSearchResults.map((song, idx) => {
      const inQueue = queueVideoIds.has(song.videoId);
      const isPlaying = currentVideoId && currentVideoId === song.videoId;

      let btnLabel = '+ Fila';
      let btnDisabled = false;
      let btnClass = 'btn-add';

      if (inQueue) {
        btnLabel = '✓ Na Fila';
        btnDisabled = true;
        btnClass = 'btn-add in-queue';
      } else if (isPlaying) {
        btnLabel = '▶ Tocando';
        btnDisabled = true;
        btnClass = 'btn-add is-playing';
      }

      return `
        <div class="song-item">
          <img src="${escapeHtml(song.thumbnail)}" alt="Capa" />
          <div class="song-item-info">
            <div class="song-item-title">${escapeHtml(song.title)}</div>
            <div class="song-item-sub">${escapeHtml(song.artist)} • ${escapeHtml(song.duration)}</div>
          </div>
          <button type="button" class="${btnClass}" data-vid="${escapeHtml(song.videoId)}" ${btnDisabled ? 'disabled' : ''} onclick="addSongByIndex(${idx}, this)">
            ${btnLabel}
          </button>
        </div>
      `;
    }).join('');

    resultsBox.innerHTML = `
      <div class="search-results-header">
        <span class="search-results-count">Resultados (${currentSearchResults.length})</span>
        <button type="button" class="btn-close-results" onclick="closeSearchResults()">✕ Fechar busca</button>
      </div>
      ${listHtml}
      <div style="text-align:center; padding: 14px 0 6px;">
        <button type="button" class="btn-close-results" onclick="closeSearchResults()">✕ Fechar busca</button>
      </div>
    `;
  } catch (err) {
    if (err.name === 'AbortError') return;
    resultsBox.innerHTML = `
      <div class="search-results-header">
        <span class="search-results-count" style="color:#ef4444;">Erro na busca</span>
        <button type="button" class="btn-close-results" onclick="closeSearchResults()">✕ Fechar</button>
      </div>
      <div style="text-align:center; padding:24px; color:#ef4444;">Erro ao buscar músicas. Tente novamente.</div>
    `;
  }
}

function addSongByIndex(idx, btnEl) {
  try { if (navigator.vibrate) navigator.vibrate(22); } catch (e) {}
  const song = currentSearchResults[idx];
  if (!song) return;

  if (isMustVoteLocked()) {
    return showToast('Vote na música atual primeiro para liberar!');
  }
  // Pré-aquece a extração da mídia no servidor de imediato ao clicar em adicionar
  fetch(`/api/audio/${song.videoId}`, { headers: { 'Range': 'bytes=0-0' } }).catch(() => {});
  if (btnEl) {
    btnEl.dataset.adding = '1';
    btnEl.disabled = true;
    btnEl.textContent = 'Adicionando...';
  }
  const dedicationInput = document.getElementById('dedicationInput');
  const dedication = (dedicationInput ? dedicationInput.value : '').trim().slice(0, 60);
  socket.emit('addSong', { song, dedication: dedication || undefined }, (res) => {
    if (btnEl) delete btnEl.dataset.adding;
    if (!res || !res.ok) {
      showToast(res?.error || 'Erro ao adicionar');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '+ Fila';
        btnEl.classList.remove('in-queue');
      }
    } else {
      try { if (navigator.vibrate) navigator.vibrate([25, 45, 25]); } catch (e) {}
      showToast(dedication ? '💌 Música com dedicatória na fila!' : '🎵 Música adicionada! Já vai tocar no Telão!');
      if (dedicationInput) dedicationInput.value = '';
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '✓ Na Fila';
        btnEl.classList.add('in-queue');
      }
    }
    refreshSearchResultsButtons();
  });
}

updateJblUi();

// ==========================================
// FILA: REMOVER OS PRÓPRIOS PEDIDOS
// ==========================================
document.getElementById('mobQueueList').addEventListener?.('click', event => {
  const button = event.target?.closest?.('[data-remove-song]');
  if (!button) return;
  socket.emit('hostAction', { action: 'removeQueueItem', payload: { songId: button.dataset.removeSong } }, result => {
    if (result?.ok) showToast('🗑️ Pedido removido da fila.');
  });
});

// ==========================================
// ANFITRIÃO: CONTROLES, TEMA E RESUMO
// ==========================================
function setGuestsControl(value) {
  socket.emit('hostAction', { action: 'setSettings', payload: { guestsControl: Boolean(value) } }, result => {
    if (result?.ok) showToast(value ? '🙌 A galera pode pular e pausar.' : '🔒 Só você controla a música agora.');
  });
}

function setTheme(theme) {
  socket.emit('hostAction', { action: 'setTheme', payload: { theme: String(theme || '').trim().slice(0, 40) } });
}

socket.on('themeChanged', ({ theme }) => {
  showToast(theme ? `🎨 Nova rodada temática: ${theme}!` : '🎨 Rodada temática encerrada.');
});

function leavePartyAndReset() {
  if (!confirm('Deseja realmente sair desta festa?')) return;
  try {
    localStorage.removeItem('jukebox_last_party');
    localStorage.removeItem('jukebox_last_party_created');
  } catch {}
  const url = new URL(window.location.href);
  url.searchParams.delete('festa');
  url.searchParams.delete('chave');
  window.history.replaceState({}, '', url.pathname);
  window.location.reload();
}

function endCurrentParty() {
  if (!confirm('Tem certeza que deseja encerrar a festa agora? Isso vai exibir o resumo final para todos e liberar uma nova festa.')) return;
  socket.emit('hostAction', { action: 'endParty' }, (res) => {
    if (!res || !res.ok) {
      showToast(res?.error || 'Não foi possível encerrar a festa.');
    }
  });
}

socket.on('partyEnded', ({ summary }) => {
  try {
    localStorage.removeItem('jukebox_last_party');
    localStorage.removeItem('jukebox_last_party_created');
  } catch {}
  showSummary(summary, true);
});

function showSummaryToAll() {
  socket.emit('hostAction', { action: 'showSummary' });
}

function requestSummary() {
  socket.emit('getSummary', {}, result => { if (result?.ok) showSummary(result.summary); });
}

socket.on('partySummary', (summary) => showSummary(summary, false));

function showSummary(summary, isEnded = false) {
  if (!summary) return;
  const titleEl = document.getElementById('summaryModalTitle');
  if (titleEl) titleEl.textContent = isEnded ? '🛑 Festa Encerrada! Resumo da noite:' : '📊 Resumo da festa';

  const list = document.getElementById('summaryList');
  const cards = summary.cards.map(card => `
    <div class="summary-item">
      <div class="summary-icon">${escapeHtml(card.icon)}</div>
      <div>
        <small>${escapeHtml(card.title)}</small>
        <strong>${escapeHtml(card.value)}</strong>
        <span>${escapeHtml(card.sub || '')}</span>
      </div>
    </div>`).join('');
  const badges = summary.achievements.length ? `
    <div class="summary-item column">
      <small>🏅 Conquistas da noite</small>
      ${summary.achievements.map(p => `<div class="summary-ach"><strong>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</strong> ${p.badges.map(b => `<span title="${escapeHtml(b.name)}: ${escapeHtml(b.desc)}">${escapeHtml(b.icon)}</span>`).join('')}</div>`).join('')}
    </div>` : '';
  list.innerHTML = cards + badges;

  const endedBox = document.getElementById('summaryEndedActions');
  if (endedBox) {
    if (isEnded) {
      endedBox.style.display = 'flex';
      if (lastYou?.isHost) {
        endedBox.innerHTML = `
          <button type="button" class="btn-new-party-primary" onclick="createPartyHere()">🎉 Iniciar Nova Festa Agora</button>
        `;
      } else {
        endedBox.innerHTML = `
          <button type="button" class="btn-new-party-primary" onclick="leavePartyAndReset()">🚪 Sair / Entrar em Outra Festa</button>
        `;
      }
    } else {
      endedBox.style.display = 'none';
      endedBox.innerHTML = '';
    }
  }

  document.getElementById('summaryModal').hidden = false;
}

function closeSummary(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('summaryModal').hidden = true;
}

// ==========================================
// CONQUISTAS
// ==========================================
socket.on('achievement', ({ player, achievement }) => {
  if (player.id !== myPlayerId) {
    showToast(`${achievement.icon} ${player.name} desbloqueou: ${achievement.name}`);
    return;
  }
  const el = document.getElementById('achievementPopup');
  el.innerHTML = `<div class="ach-big">${escapeHtml(achievement.icon)}</div>
    <div><small>VOCÊ DESBLOQUEOU</small><strong>${escapeHtml(achievement.name)}</strong><span>${escapeHtml(achievement.desc)}</span></div>`;
  el.hidden = false;
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
  clearTimeout(window._achTimer);
  window._achTimer = setTimeout(() => { el.hidden = true; }, 3800);
});
