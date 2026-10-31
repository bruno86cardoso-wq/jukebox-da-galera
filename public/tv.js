const socket = createPartySocket();
const videoEl = document.getElementById('tvVideoPlayer');
const audioCoverStage = document.getElementById('audioCoverStage');
const loadingOverlay = document.getElementById('loadingOverlay');
const unmuteOverlay = document.getElementById('unmuteOverlay');
const idleScreen = document.getElementById('idleScreen');

let currentPlayingSongId = null;
let currentVideoId = null;
let currentQrMode = 'auto';
let lastState = null;
let audioUnlocked = false;
let isPrimaryTv = false;
let lastYou = null;
let initialPartyCode = readPartyFromUrl() || (() => {
  try {
    const last = localStorage.getItem('jukebox_last_party');
    const lastCreated = Number(localStorage.getItem('jukebox_last_party_created') || 0);
    // Se a última festa foi criada há mais de 10 horas, abre uma nova limpa
    if (lastCreated && (Date.now() - lastCreated) > 10 * 60 * 60 * 1000) {
      localStorage.removeItem('jukebox_last_party');
      return null;
    }
    return last && getHostKey(last) ? last : null; // reabre a última festa que este telão criou
  } catch { return null; }
})();
let tvMediaMode = 'video'; // Padrão no Telão é Vídeo + Áudio! (se falhar, cai para Capa + Áudio)
let tvLoadedMediaMode = null;

function setTvMediaMode(mode) {
  tvMediaMode = mode === 'video' ? 'video' : 'audio';
  const btnTop = document.getElementById('btnTvMediaMode');
  const btnModalAudio = document.getElementById('modalMediaAudio');
  const btnModalVideo = document.getElementById('modalMediaVideo');

  if (btnModalAudio && btnModalVideo) {
    btnModalAudio.classList.toggle('active', tvMediaMode === 'audio');
    btnModalVideo.classList.toggle('active', tvMediaMode === 'video');
  }

  if (btnTop) {
    if (tvMediaMode === 'audio') {
      btnTop.innerHTML = '🎵 Só Música (Rápido ⚡)';
      btnTop.style.background = 'rgba(16, 185, 129, 0.2)';
      btnTop.style.borderColor = '#10b981';
      btnTop.style.color = '#34d399';
    } else {
      btnTop.innerHTML = '🎬 Música + Clipe';
      btnTop.style.background = 'rgba(56, 189, 248, 0.2)';
      btnTop.style.borderColor = '#38bdf8';
      btnTop.style.color = '#38bdf8';
    }
  }

  if (lastState && lastState.currentSong) {
    tvLoadedMediaMode = null;
    syncVideoPlayer(lastState.currentSong);
  }
}

function toggleTvMediaMode() {
  setTvMediaMode(tvMediaMode === 'audio' ? 'video' : 'audio');
}

async function claimTv() {
  isPrimaryTv = await socket.claimPlayback();
  if (isPrimaryTv) syncVideoPlayer(lastState?.currentSong);
  return isPrimaryTv;
}

// Entra na festa do link (ou na última criada aqui); se não existir, cria uma nova.
async function ensureParty() {
  const code = socket.party.code || initialPartyCode;
  if (code) {
    const joined = await socket.joinParty(code);
    if (joined.ok) return partyReady(joined);
    partyNotice('A festa ' + code + ' não existe mais. Criando uma nova…');
  }
  const created = await socket.createParty();
  if (created.ok) return partyReady(created);
  partyNotice(created.error || 'Não foi possível criar a festa.');
  return false;
}

function partyReady(result) {
  initialPartyCode = result.code;
  setPartyInUrl(result.code);
  for (const id of ['partyCodeBadge', 'qrPartyCode', 'settingsCode']) {
    const el = document.getElementById(id);
    if (el) el.textContent = result.code;
  }
  refreshQrCode(currentQrMode);
  return true;
}

socket.on('connect', async () => {
  if (await ensureParty()) claimTv();
});
socket.on('disconnect', () => {
  isPrimaryTv = false;
  stopTvPlayback();
});
function stopTvPlayback() {
  tvRecovery.reset();
  currentPlayingSongId = null;
  currentVideoId = null;
  tvLoadedMediaMode = null;
  videoEl.pause();
  videoEl.muted = true;
  videoEl.removeAttribute('src');
  videoEl.load();
}

// Se outra janela/navegador abrir o Telão, esta janela antiga silencia automaticamente!
socket.on('tvDeactivated', () => {
  isPrimaryTv = false;
  stopTvPlayback();
});

videoEl.addEventListener('pause', () => {
  if (isPrimaryTv && currentVideoId && !videoEl.ended) {
    socket.emit('hostAction', { action: 'syncPauseState', payload: { paused: true } });
  }
});

videoEl.addEventListener('play', () => {
  if (isPrimaryTv && currentVideoId) {
    socket.emit('hostAction', { action: 'syncPauseState', payload: { paused: false } });
  }
});

// Eventos nativos do player de vídeo HTML5
videoEl.addEventListener('loadstart', () => {
  if (currentPlayingSongId) {
    loadingOverlay.style.display = 'flex';
    document.getElementById('tvPlaybackStatus').textContent = tvMediaMode === 'audio' ? 'Carregando somente o áudio…' : 'Carregando áudio e vídeo…';
    document.getElementById('btnRetryTv').hidden = true;
  }
});

videoEl.addEventListener('canplay', () => {
  loadingOverlay.style.display = 'none';
});

videoEl.addEventListener('playing', () => {
  loadingOverlay.style.display = 'none';
  if (!videoEl.muted) {
    unmuteOverlay.style.display = 'none';
  }
});

videoEl.addEventListener('waiting', () => {
  if (currentPlayingSongId) {
    loadingOverlay.style.display = 'flex';
  }
});

videoEl.addEventListener('ended', () => {
  if (isPrimaryTv && currentPlayingSongId) {
    socket.emit('hostAction', {
      action: 'songEnded',
      payload: { songId: currentPlayingSongId }
    });
  }
});

videoEl.addEventListener('error', () => {
  if (isPrimaryTv && currentVideoId && tvMediaMode === 'video') {
    console.log('Vídeo indisponível no Telão. Alternando automaticamente para capa + áudio.');
    setTvMediaMode('audio');
  }
});

const tvRecovery = attachMediaRecovery(videoEl, {
  isActive: () => isPrimaryTv,
  source: () => currentVideoId ? (tvMediaMode === 'video' ? '/api/stream/' : '/api/audio/') + currentVideoId : null,
  play: () => { if (!lastState?.isPaused) tryPlayVideo(); },
  failed: showTvPlaybackError
});

let tvYtPlayer = null;
let tvYtFallbackActive = false;
let pendingTvYtSong = null;

function loadTvYtApi() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (typeof window !== 'undefined' && window.YT && window.YT.Player) return;
  if (typeof window !== 'undefined' && window._ytTvApiLoading) return;
  if (typeof window !== 'undefined') window._ytTvApiLoading = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.referrerPolicy = 'strict-origin-when-cross-origin';
  const first = typeof document.getElementsByTagName === 'function' ? document.getElementsByTagName('script')[0] : null;
  if (first && first.parentNode) first.parentNode.insertBefore(tag, first);
  else if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(tag);
  else if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(tag);
}

if (typeof window !== 'undefined') {
  window.onYouTubeIframeAPIReady = function() {
    if (tvYtFallbackActive && pendingTvYtSong) {
      activateTvYtFallback(pendingTvYtSong);
    }
  };
  loadTvYtApi();
}

function activateTvYtFallback(song) {
  if (!song || !isPrimaryTv) return;
  pendingTvYtSong = song;
  tvYtFallbackActive = true;
  loadingOverlay.style.display = 'none';
  audioCoverStage.style.display = 'none';
  try {
    videoEl.pause();
    videoEl.removeAttribute('src');
  } catch (e) {}

  const box = document.getElementById('tvYtFallbackBox');
  if (box) box.style.display = 'block';

  currentPlayingSongId = song.id;
  currentVideoId = song.videoId;

  if (tvYtPlayer && typeof tvYtPlayer.loadVideoById === 'function') {
    try {
      tvYtPlayer.loadVideoById(song.videoId);
    } catch (e) {}
    return;
  }

  if (typeof window === 'undefined' || !window.YT || !window.YT.Player) {
    loadTvYtApi();
    return;
  }

  const container = document.getElementById('tvYtPlayer');
  if (!container) return;

  const currentOrigin = (typeof window !== 'undefined' && window.location && window.location.origin)
    ? window.location.origin
    : 'https://jukebox-da-galera.onrender.com';

  try {
    tvYtPlayer = new window.YT.Player('tvYtPlayer', {
      height: '100%',
      width: '100%',
      videoId: song.videoId,
      host: 'https://www.youtube.com',
      playerVars: {
        autoplay: 1,
        controls: 1,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        enablejsapi: 1,
        origin: currentOrigin,
        widget_referrer: currentOrigin
      },
      events: {
        onReady: (e) => {
          const iframe = e.target.getIframe?.() || document.querySelector('#tvYtPlayerWrap iframe');
          if (iframe && typeof iframe.setAttribute === 'function') {
            iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          }
          if (!lastState?.isPaused) {
            try { e.target.playVideo(); } catch (err) {}
          }
        },
        onStateChange: (e) => {
          if (typeof window === 'undefined' || !window.YT) return;
          if (e.data === window.YT.PlayerState.ENDED) {
            if (isPrimaryTv && currentPlayingSongId) {
              socket.emit('hostAction', {
                action: 'songEnded',
                payload: { songId: currentPlayingSongId }
              });
            }
          }
        }
      }
    });
  } catch (e) {
    console.warn('Falha ao iniciar player YouTube no telão:', e);
  }
}

function showTvPlaybackError() {
  if (lastState?.currentSong) {
    activateTvYtFallback(lastState.currentSong);
    return;
  }
  loadingOverlay.style.display = 'flex';
  document.getElementById('loadingSongText').textContent = 'Não foi possível tocar esta música';
  document.getElementById('tvPlaybackStatus').textContent = 'Tente novamente ou use Próxima para continuar.';
  document.getElementById('btnRetryTv').hidden = false;
}

function retryTvPlayback() {
  if (!isPrimaryTv || !currentVideoId) return;
  tvRecovery.reset();
  videoEl.load();
  tryPlayVideo();
}

function unlockAudioContext() {
  audioUnlocked = true;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) {}
}

async function startTvWithMode(mode) {
  unlockAudioContext();
  if (!isPrimaryTv && !await claimTv()) return;
  document.getElementById('startModal').style.display = 'none';
  setMode(mode);
  forcePlayWithSound();
}

function forcePlayWithSound() {
  unlockAudioContext();
  unmuteOverlay.style.display = 'none';
  videoEl.muted = false;
  videoEl.volume = 1.0;
  if (currentVideoId && videoEl.paused) {
    videoEl.play().catch(() => {});
  }
}

async function tryPlayVideo() {
  if (!isPrimaryTv || !currentVideoId) return;
  const expectedSong = currentPlayingSongId;
  try {
    videoEl.muted = false;
    await videoEl.play();
    unmuteOverlay.style.display = 'none';
  } catch (err) {
    if (!isPrimaryTv || currentPlayingSongId !== expectedSong || err.name === 'AbortError') return;
    if (err.name !== 'NotAllowedError') {
      showTvPlaybackError();
      return;
    }
    // Se o navegador bloquear som automático por falta de clique, inicia mudo e mostra o botão de ativar som!
    console.warn('Autoplay com som bloqueado pelo navegador, iniciando vídeo e exibindo botão de som.');
    videoEl.muted = true;
    unmuteOverlay.style.display = 'flex';
    videoEl.play().catch(() => {});
  }
}

function syncVideoPlayer(song) {
  if (!isPrimaryTv) return;
  if (!song) {
    idleScreen.style.display = 'flex';
    audioCoverStage.style.display = 'none';
    loadingOverlay.style.display = 'none';
    unmuteOverlay.style.display = 'none';
    const ytBox = document.getElementById('tvYtFallbackBox');
    if (ytBox) ytBox.style.display = 'none';
    if (tvYtPlayer && typeof tvYtPlayer.stopVideo === 'function') {
      try { tvYtPlayer.stopVideo(); } catch (err) {}
    }
    tvYtFallbackActive = false;
    tvRecovery.reset();
    currentPlayingSongId = null;
    currentVideoId = null;
    tvLoadedMediaMode = null;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    return;
  }

  if (tvYtFallbackActive) {
    if (song.id !== currentPlayingSongId || song.videoId !== currentVideoId) {
      activateTvYtFallback(song);
    }
    return;
  }

  idleScreen.style.display = 'none';

  // Atualiza visual de capa caso esteja no modo Só Música (Rápido)
  if (tvMediaMode === 'audio') {
    audioCoverStage.style.display = 'flex';
    document.getElementById('audioStageThumb').src = song.thumbnail || '';
    document.getElementById('audioStageTitle').textContent = song.title || '';
    document.getElementById('audioStageArtist').textContent = song.artist || '';
  } else {
    audioCoverStage.style.display = 'none';
  }

  if (
    song.id !== currentPlayingSongId ||
    song.videoId !== currentVideoId ||
    tvLoadedMediaMode !== tvMediaMode
  ) {
    const resumeTime = (song.id === currentPlayingSongId && videoEl.currentTime > 1)
      ? videoEl.currentTime
      : 0;

    tvRecovery.reset();
    currentPlayingSongId = song.id;
    currentVideoId = song.videoId;
    tvLoadedMediaMode = tvMediaMode;

    document.getElementById('loadingSongText').textContent = `Carregando: ${song.title}`;
    loadingOverlay.style.display = 'flex';
    videoEl.poster = song.thumbnail || '';
    videoEl.src = tvMediaMode === 'video'
      ? `/api/stream/${song.videoId}`
      : `/api/audio/${song.videoId}`;

    if (resumeTime > 0) {
      videoEl.addEventListener('loadedmetadata', function onMeta() {
        videoEl.removeEventListener('loadedmetadata', onMeta);
        videoEl.currentTime = resumeTime;
      });
    }
    if (!lastState?.isPaused) tryPlayVideo();
  }
}

let tvPreloadMediaEl = null;
function preloadNextTvTrack(videoId, isVideo) {
  if (!videoId || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (!tvPreloadMediaEl) {
    tvPreloadMediaEl = document.createElement(isVideo ? 'video' : 'audio');
    tvPreloadMediaEl.preload = 'auto';
    tvPreloadMediaEl.muted = true;
    tvPreloadMediaEl.style.display = 'none';
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(tvPreloadMediaEl);
    }
  }
  const targetSrc = (isVideo ? '/api/stream/' : '/api/audio/') + videoId;
  if (!tvPreloadMediaEl.src || !tvPreloadMediaEl.src.endsWith(targetSrc)) {
    tvPreloadMediaEl.src = targetSrc;
    tvPreloadMediaEl.load();
  }
}

function playSoundEffect(type) {
  if (!audioUnlocked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (type === 'veto') {
      const playBuzzerTone = (startOffset, duration) => {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sawtooth';
        osc2.type = 'square';
        osc1.frequency.setValueAtTime(160, ctx.currentTime + startOffset);
        osc2.frequency.setValueAtTime(168, ctx.currentTime + startOffset);
        osc1.frequency.linearRampToValueAtTime(100, ctx.currentTime + startOffset + duration);
        osc2.frequency.linearRampToValueAtTime(104, ctx.currentTime + startOffset + duration);
        gain.gain.setValueAtTime(0.3, ctx.currentTime + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + startOffset + duration);
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);
        osc1.start(ctx.currentTime + startOffset);
        osc2.start(ctx.currentTime + startOffset);
        osc1.stop(ctx.currentTime + startOffset + duration);
        osc2.stop(ctx.currentTime + startOffset + duration);
      };
      playBuzzerTone(0, 0.28);
      playBuzzerTone(0.32, 0.45);
    } else if (type === 'reveal') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(554.37, ctx.currentTime + 0.12);
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.24);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    }
  } catch (e) {}
}

async function refreshQrCode(mode) {
  try {
    if (!socket.party.code) return;
    const res = await fetch(`/api/qrcode?festa=${encodeURIComponent(socket.party.code)}&mode=${mode || currentQrMode}`);
    const data = await res.json();
    document.getElementById('qrImage').src = data.dataUrl;
    document.getElementById('qrUrlText').textContent = data.url;
    const badge = document.getElementById('qrModeBadge');
    if (data.url.includes('trycloudflare.com')) {
      badge.textContent = '🌐 4G/5G & Wi-Fi Liberado';
    } else {
      badge.textContent = '📶 Rede Wi-Fi Local';
    }
  } catch (e) {
    console.error('Erro ao carregar QR Code:', e);
  }
}

function toggleQrMode() {
  currentQrMode = currentQrMode === 'local' ? 'auto' : 'local';
  socket.emit('hostAction', {
    action: 'toggleQrMode',
    payload: { mode: currentQrMode }
  });
  refreshQrCode(currentQrMode);
}

function setMode(mode) {
  unlockAudioContext();
  socket.emit('hostAction', { action: 'setMode', payload: { mode } });
}

function updateFixedPlayers(val) {
  socket.emit('hostAction', { action: 'setFixedPlayerCount', payload: { count: val } });
}

function previousSong() {
  unlockAudioContext();
  socket.emit('hostAction', { action: 'previousSong' });
}

async function togglePause() {
  unlockAudioContext();
  if (!isPrimaryTv && !await claimTv()) return;
  if (videoEl.paused) tryPlayVideo();
  else videoEl.pause();
}

function skipSong() {
  unlockAudioContext();
  socket.emit('hostAction', { action: 'skipSong' });
}

document.getElementById('queueList').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-song]');
  if (button) removeSongFromQueue(button.dataset.removeSong);
});

function removeSongFromQueue(songId) {
  socket.emit('hostAction', { action: 'removeQueueItem', payload: { songId } });
}

function toggleFullscreen() {
  unlockAudioContext();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

socket.on('playerCommand', ({ command }) => {
  if (!currentVideoId) return;
  if (command === 'pause') {
    videoEl.pause();
  } else if (command === 'play') {
    tryPlayVideo();
  } else if (command === 'restart') {
    videoEl.currentTime = 0;
    tryPlayVideo();
  }
});

const mysteryClock = createMysteryClock(seconds => {
  const badge = document.getElementById('requesterBadge');
  if (badge && badge.classList.contains('mystery')) badge.innerHTML = `<span>🕵️ Mistério! Revela em ${seconds}s...</span>`;
});

socket.on('stateUpdate', (state, you) => {
  const prevUrl = lastState?.connection?.activeQrUrl;
  const prevSongId = lastState?.currentSong?.id;
  lastState = state;
  lastYou = you || null;
  document.body.classList.toggle('is-host', Boolean(you?.isHost));
  renderTheme(state.theme);
  renderDedication(state.currentSong);
  if (state.currentSong?.id !== prevSongId) updateAmbient(state.currentSong);
  const guestsInput = document.getElementById('guestsControlInput');
  if (guestsInput && state.settings) guestsInput.checked = Boolean(state.settings.guestsControl);

  // Se já tinha música tocando quando abriu a tela, fecha o modal inicial automaticamente
  if (state.currentSong && document.getElementById('startModal').style.display !== 'none') {
    document.getElementById('startModal').style.display = 'none';
  }

  if (state.connection?.activeQrUrl !== prevUrl) {
    refreshQrCode(currentQrMode);
  }

  const isDesafio = state.mode === 'desafio';

  document.getElementById('btnModeDesafio').classList.toggle('active', isDesafio);
  document.getElementById('btnModeLivre').classList.toggle('active', !isDesafio);

  document.getElementById('btnPlayPauseMain').innerHTML = state.isPaused ? '▶️ Tocar' : '⏸️ Pausar';

  document.getElementById('desafioVoteDashboard').style.display = isDesafio ? 'grid' : 'none';
  document.getElementById('livreStatusBar').style.display = isDesafio ? 'none' : 'flex';
  document.getElementById('bottomPanelTitle').textContent = isDesafio
    ? '🏆 Ranking de DJs da Festa'
    : '👥 Galera Conectada na Festa';
  document.getElementById('bottomPanelSub').textContent = isDesafio
    ? 'Likes +10 | Veto -15'
    : 'Pedindo músicas pelo QR Code';

  document.getElementById('activePlayersLabel').textContent =
    state.fixedPlayerCount > 0
      ? `(Fixo: ${state.totalParticipants})`
      : `(Conectados: ${state.totalParticipants})`;

  // Player e Música Atual
  syncVideoPlayer(state.currentSong);

  // Pré-carrega a próxima faixa no navegador para transição instantânea sem silêncio
  if (state.queue && state.queue.length > 0 && isPrimaryTv) {
    const nextSong = state.queue[0];
    preloadNextTvTrack(nextSong.videoId, tvMediaMode === 'video');
  }

  const nowTitle = document.getElementById('nowTitle');
  const nowArtist = document.getElementById('nowArtist');
  const badge = document.getElementById('requesterBadge');
  const likesEl = document.getElementById('likesCount');
  const dislikesEl = document.getElementById('dislikesCount');
  const vetoFill = document.getElementById('vetoBarFill');
  const vetoPercent = document.getElementById('vetoPercentLabel');
  const votersBox = document.getElementById('votersStatusBox');

  if (!state.currentSong) {
    nowTitle.textContent = 'Aguardando pedidos da galera...';
    nowArtist.textContent = 'Aponte a câmera para o QR Code e escolha uma música!';
    badge.className = 'requester-badge revealed';
    if (state.log && state.log.length > 0) {
      badge.innerHTML = '<button type="button" class="btn-summary-tv" onclick="requestSummary()">🏆 Ver Resumo da Noite</button>';
    } else {
      badge.innerHTML = '<span>🎧 DJ da Vez: —</span>';
    }
    likesEl.textContent = '0';
    dislikesEl.textContent = `0 / ${state.dislikeThreshold}`;
    vetoFill.style.width = '0%';
    vetoPercent.textContent = '0%';
    votersBox.innerHTML = '<span>⏳ Aguardando música para abrir votação...</span>';
  } else {
    const s = state.currentSong;
    nowTitle.textContent = s.title;
    nowArtist.textContent = s.artist;

    if (!s.isRevealed && isDesafio) {
      badge.className = 'requester-badge mystery';
      badge.innerHTML = `<span>🕵️ Mistério! Revela em ${s.mysteryRemainingSeconds}s...</span>`;
      mysteryClock.update(s, state.isPaused);
    } else {
      mysteryClock.update(null);
      badge.className = 'requester-badge revealed';
      badge.innerHTML = `<span>Pedida por: ${escapeHtml(s.addedBy.avatar || '🎧')} ${escapeHtml(s.addedBy.name)}</span>`;
    }

    likesEl.textContent = s.likesCount;
    dislikesEl.textContent = `${s.dislikesEffective} / ${s.dislikeThreshold}`;

    const pct = Math.min(100, Math.round((s.dislikesEffective / s.dislikeThreshold) * 100));
    vetoFill.style.width = `${pct}%`;
    vetoPercent.textContent = `${pct}%`;

    if (s.pendingVoters && s.pendingVoters.length > 0) {
      const chips = s.pendingVoters
        .map(p => `<span class="pending-chip">⏳ ${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</span>`)
        .join(' ');
      votersBox.innerHTML = `<strong>Faltam votar:</strong> ${chips}`;
    } else {
      votersBox.innerHTML = `<span style="color: #34d399; font-weight: 700;">✅ Todo mundo já votou nesta rodada!</span>`;
    }
  }

  // Renderiza Fila Inteligente
  const queueList = document.getElementById('queueList');
  document.getElementById('queueCount').textContent = state.queue.length;
  if (state.queue.length === 0) {
    queueList.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align:center; padding: 18px;">Fila vazia! Peça pelo QR Code 📱</div>`;
  } else {
    queueList.innerHTML = state.queue.map((item, idx) => {
      const who = isDesafio
        ? '🕵️ DJ Misterioso'
        : `${escapeHtml(item.addedBy.avatar || '🎵')} ${escapeHtml(item.addedBy.name)}`;
      return `
        <div class="queue-item">
          <div style="font-weight:800; color:var(--text-muted); width:20px;">${idx + 1}</div>
          <img class="queue-thumb" src="${escapeHtml(item.thumbnail)}" alt="Thumb" />
          <div class="queue-details">
            <div class="queue-title">${escapeHtml(item.title)}</div>
            <div class="queue-meta">
              <span>${escapeHtml(item.artist)}</span>
              <span>•</span>
              <span style="color:#a78bfa;">${who}</span>
            </div>
          </div>
          <button class="btn-action host-only" style="padding:4px 8px; font-size:11px;" data-remove-song="${escapeHtml(item.id)}" title="Remover da fila">✕</button>
        </div>
      `;
    }).join('');
  }

  // Renderiza Ranking ou Lista de Participantes
  const rankingList = document.getElementById('rankingList');
  if (state.players.length === 0) {
    rankingList.innerHTML = `<div style="color: var(--text-muted); font-size: 13px; text-align:center; padding: 18px;">Nenhum participante conectado ainda.</div>`;
  } else {
    rankingList.innerHTML = state.players.map((p, idx) => {
      const posClass = idx === 0 ? 'top1' : idx === 1 ? 'top2' : idx === 2 ? 'top3' : '';
      const ranzinzaBadge = isDesafio && p.isRanzinza
        ? `<span class="tag-ranzinza">😡 RANZINZA</span>`
        : '';
      const ammoIcons = isDesafio ? '💣'.repeat(p.ammo) : '';
      const badges = (p.achievements || []).map(a => `<span class="ach-icon" title="${escapeHtml(a.name)}">${escapeHtml(a.icon)}</span>`).join('');
      const rightInfo = isDesafio ? `${p.score} pts` : `${p.songsPlayed} pedidas`;
      return `
        <div class="rank-item">
          <div class="rank-pos ${posClass}">${idx + 1}</div>
          <div class="rank-name">
            <span>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</span>
            ${ranzinzaBadge}
            <span class="ach-row">${badges}</span>
            <span style="font-size:11px; opacity:0.75;">${ammoIcons}</span>
          </div>
          <div class="rank-score">${rightInfo}</div>
        </div>
      `;
    }).join('');
  }
});

socket.on('mysteryRevealed', () => {
  playSoundEffect('reveal');
});

socket.on('songVetoed', (info) => {
  playSoundEffect('veto');
  const overlay = document.getElementById('vetoOverlay');
  const sub = document.getElementById('vetoOverlaySub');
  sub.textContent = `"${info.title}" (pedida por ${info.addedBy.name}) levou ${info.dislikesEffective} Dislikes!`;
  overlay.classList.add('show');
  setTimeout(() => {
    overlay.classList.remove('show');
  }, 4200);
});

const recentReactions = [];
socket.on('liveReaction', ({ emoji, playerName, avatar }) => {
  spawnEmoji(emoji, playerName);
  // Muita gente reagindo junto vira "chuva" + tremidinha no telão.
  const now = Date.now();
  recentReactions.push(now);
  while (recentReactions.length && now - recentReactions[0] > 4000) recentReactions.shift();
  if (recentReactions.length >= 6 && !document.body.classList.contains('reaction-burst')) {
    document.body.classList.add('reaction-burst');
    for (let i = 0; i < 24; i++) setTimeout(() => spawnEmoji(emoji, null, true), i * 60);
    setTimeout(() => document.body.classList.remove('reaction-burst'), 1600);
    recentReactions.length = 0;
  }
});

function spawnEmoji(emoji, name, rain = false) {
  const el = document.createElement('div');
  el.className = rain ? 'floating-emoji rain' : 'floating-emoji';
  el.textContent = emoji;
  if (name && !rain) {
    const tag = document.createElement('small');
    tag.textContent = name;
    el.appendChild(tag);
  }
  el.style.left = `${Math.floor(5 + Math.random() * 90)}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ==========================================
// TEMA, DEDICATÓRIA E FUNDO QUE ACOMPANHA A CAPA
// ==========================================
function renderTheme(theme) {
  const el = document.getElementById('themeBanner');
  if (!el) return;
  el.hidden = !theme;
  if (theme) el.innerHTML = `🎨 Rodada temática: <strong>${escapeHtml(theme)}</strong>`;
}

function renderDedication(song) {
  const el = document.getElementById('dedicationBanner');
  if (!el) return;
  if (!song || !song.dedication) { el.hidden = true; el.dataset.song = ''; return; }
  if (el.dataset.song === song.id + (song.isRevealed ? 'r' : '')) return;
  el.dataset.song = song.id + (song.isRevealed ? 'r' : '');
  const from = song.isRevealed ? ` <small>— ${escapeHtml(song.addedBy.avatar)} ${escapeHtml(song.addedBy.name)}</small>` : ' <small>— 🕵️ alguém da festa</small>';
  el.innerHTML = `💌 ${escapeHtml(song.dedication)}${from}`;
  el.hidden = false;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

async function updateAmbient(song) {
  const root = document.documentElement;
  if (!song) { root.style.removeProperty('--ambient'); return; }
  const rgb = await coverColor(song.videoId);
  if (!rgb || lastState?.currentSong?.id !== song.id) return;
  root.style.setProperty('--ambient', `rgb(${rgb.join(',')})`);
}

socket.on('themeChanged', ({ theme }) => {
  const el = document.getElementById('themeBanner');
  if (theme && el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
});

// ==========================================
// CONQUISTAS
// ==========================================
const achievementQueue = [];
socket.on('achievement', item => {
  achievementQueue.push(item);
  if (achievementQueue.length === 1) showNextAchievement();
});
function showNextAchievement() {
  const item = achievementQueue[0];
  const el = document.getElementById('achievementPopup');
  if (!item || !el) return;
  el.innerHTML = `<div class="ach-big">${escapeHtml(item.achievement.icon)}</div>
    <div><small>CONQUISTA DESBLOQUEADA</small>
    <strong>${escapeHtml(item.player.avatar)} ${escapeHtml(item.player.name)} · ${escapeHtml(item.achievement.name)}</strong>
    <span>${escapeHtml(item.achievement.desc)}</span></div>`;
  el.hidden = false;
  playSoundEffect('reveal');
  setTimeout(() => {
    el.hidden = true;
    achievementQueue.shift();
    setTimeout(showNextAchievement, 300);
  }, 3800);
}

// ==========================================
// CONFIGURAÇÕES DO ANFITRIÃO
// ==========================================
function openSettings() {
  document.getElementById('settingsModal').hidden = false;
}
function closeSettings(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('settingsModal').hidden = true;
  document.getElementById('hostQrImage').hidden = true;
}
function setGuestsControl(value) {
  socket.emit('hostAction', { action: 'setSettings', payload: { guestsControl: Boolean(value) } });
}
function setTheme(theme) {
  socket.emit('hostAction', { action: 'setTheme', payload: { theme: String(theme || '').slice(0, 40) } });
}
async function showHostQr() {
  const key = socket.party.hostKey;
  if (!key) return partyNotice('Este aparelho não é o anfitrião.');
  try {
    const res = await fetch(`/api/qrcode?festa=${encodeURIComponent(socket.party.code)}&chave=${encodeURIComponent(key)}&mode=${currentQrMode}`);
    const data = await res.json();
    const img = document.getElementById('hostQrImage');
    img.src = data.dataUrl;
    img.hidden = false;
  } catch {}
}
function endCurrentPartyTv() {
  if (!confirm('Tem certeza que deseja encerrar a festa agora? Isso vai exibir o resumo final para a galera e liberar uma nova festa.')) return;
  socket.emit('hostAction', { action: 'endParty' });
}

socket.on('partyEnded', ({ summary }) => {
  try {
    localStorage.removeItem('jukebox_last_party');
    localStorage.removeItem('jukebox_last_party_created');
  } catch {}
  if (summary) showSummary(summary);
});

let newPartyArmed = false;
async function startNewParty() {
  const btn = document.getElementById('btnNewParty');
  if (!newPartyArmed) {
    newPartyArmed = true;
    btn.textContent = 'Toque de novo para confirmar';
    setTimeout(() => { newPartyArmed = false; btn.textContent = 'Começar uma festa nova'; }, 4000);
    return;
  }
  newPartyArmed = false;
  const created = await socket.createParty();
  if (!created.ok) return;
  partyReady(created);
  closeSettings();
  await claimTv();
}

// ==========================================
// RESUMO DA FESTA
// ==========================================
function showSummaryToAll() {
  closeSettings();
  socket.emit('hostAction', { action: 'showSummary' });
}
function requestSummary() {
  socket.emit('getSummary', {}, result => { if (result?.ok) showSummary(result.summary); });
}
socket.on('partySummary', showSummary);

let summaryTimer = null;
function showSummary(summary) {
  if (!summary) return;
  const slides = [...summary.cards];
  if (summary.achievements.length) slides.push({ icon: '🏅', title: 'Conquistas da noite', achievements: summary.achievements });
  const overlay = document.getElementById('summaryOverlay');
  const slideEl = document.getElementById('summarySlide');
  const dots = document.getElementById('summaryDots');
  let index = 0;
  function render() {
    const card = slides[index];
    slideEl.classList.remove('in');
    void slideEl.offsetWidth;
    slideEl.innerHTML = card.achievements
      ? `<div class="summary-icon">${card.icon}</div><h2>${escapeHtml(card.title)}</h2>
         <div class="summary-ach">${card.achievements.slice(0, 8).map(p => `<div><strong>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</strong> ${p.badges.map(b => `<span title="${escapeHtml(b.name)}">${escapeHtml(b.icon)}</span>`).join('')}</div>`).join('')}</div>`
      : `<div class="summary-icon">${escapeHtml(card.icon)}</div><h2>${escapeHtml(card.title)}</h2>
         <div class="summary-value">${escapeHtml(card.value)}</div><p>${escapeHtml(card.sub || '')}</p>`;
    slideEl.classList.add('in');
    dots.innerHTML = slides.map((_, i) => `<span class="${i === index ? 'on' : ''}"></span>`).join('');
  }
  clearInterval(summaryTimer);
  overlay.hidden = false;
  render();
  summaryTimer = setInterval(() => {
    index += 1;
    if (index >= slides.length) { clearInterval(summaryTimer); return; }
    render();
  }, 5000);
  overlay.onclick = event => {
    if (event.target.closest('.summary-close')) return;
    index = Math.min(slides.length - 1, index + 1);
    render();
  };
}
function closeSummary() {
  clearInterval(summaryTimer);
  document.getElementById('summaryOverlay').hidden = true;
}

// O QR é carregado assim que a festa estiver definida (ver partyReady).
