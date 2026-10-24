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
let tvMediaMode = 'audio'; // 'audio' (padrão rápido) | 'video' (clipe)
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
socket.on('connect', claimTv);
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

const tvRecovery = attachMediaRecovery(videoEl, {
  isActive: () => isPrimaryTv,
  source: () => currentVideoId ? (tvMediaMode === 'video' ? '/api/stream/' : '/api/audio/') + currentVideoId : null,
  play: () => { if (!lastState?.isPaused) tryPlayVideo(); },
  failed: showTvPlaybackError
});

function showTvPlaybackError() {
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
    tvRecovery.reset();
    currentPlayingSongId = null;
    currentVideoId = null;
    tvLoadedMediaMode = null;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
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

function playSoundEffect(type) {
  if (!audioUnlocked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (type === 'veto') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.6);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.65);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.65);
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
    const res = await fetch(`/api/qrcode?mode=${mode || currentQrMode}`);
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

socket.on('stateUpdate', (state) => {
  const prevUrl = lastState?.connection?.activeQrUrl;
  lastState = state;

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
    badge.innerHTML = '<span>🎧 DJ da Vez: —</span>';
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
    } else {
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
          <button class="btn-action" style="padding:4px 8px; font-size:11px;" data-remove-song="${escapeHtml(item.id)}" title="Remover da fila">✕</button>
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
      const rightInfo = isDesafio ? `${p.score} pts` : `${p.songsPlayed} pedidas`;
      return `
        <div class="rank-item">
          <div class="rank-pos ${posClass}">${idx + 1}</div>
          <div class="rank-name">
            <span>${escapeHtml(p.avatar)} ${escapeHtml(p.name)}</span>
            ${ranzinzaBadge}
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

socket.on('liveReaction', ({ emoji }) => {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = `${Math.floor(15 + Math.random() * 70)}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
});

refreshQrCode('auto');
