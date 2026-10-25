/* Helpers compartilhados pelo celular e pelo telão. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function partyNotice(message) {
  let notice = document.getElementById('partyNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'partyNotice';
    notice.setAttribute('role', 'status');
    Object.assign(notice.style, { position: 'fixed', bottom: '62px', left: '16px', right: '16px',
      zIndex: '10000', padding: '14px', borderRadius: '12px', background: '#24263b', color: '#fff', textAlign: 'center' });
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(partyNotice.timer);
  partyNotice.timer = setTimeout(() => { notice.hidden = true; }, 6000);
}

function createPartySocket() {
  let playerToken = localStorage.getItem('jukebox_player_token');
  if (!/^[a-f0-9]{64}$/.test(playerToken || '')) {
    playerToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('jukebox_player_token', playerToken);
  }
  const socket = io({ auth: { playerToken } });
  const emit = socket.emit.bind(socket);
  const panel = document.createElement('div');
  Object.assign(panel.style, { position: 'fixed', bottom: '10px', right: '10px', zIndex: '9000',
    display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', borderRadius: '10px', background: 'rgba(22, 24, 39, 0.85)', backdropFilter: 'blur(8px)', transition: 'opacity 0.3s' });
  const status = document.createElement('span');
  status.textContent = 'Conectando…';
  status.setAttribute('role', 'status');
  status.style.cssText = 'color:#cbd5e1;font-size:12px;font-weight:600';
  panel.append(status);
  document.body.appendChild(panel);

  function request(event, data) {
    return new Promise(resolve => {
      if (!socket.connected) return resolve({ ok: false, error: 'Sem conexão. Aguarde reconectar.' });
      let complete = false;
      const timer = setTimeout(() => {
        complete = true;
        resolve({ ok: false, error: 'O servidor não respondeu. Confira a conexão.' });
      }, 8000);
      emit(event, data, result => {
        if (complete) return;
        clearTimeout(timer);
        resolve(result || { ok: false, error: 'Resposta inválida.' });
      });
    });
  }

  // ---------- Festa atual (código + chave do anfitrião) ----------
  socket.party = { code: null, hostKey: null, isHost: false };
  socket.joinParty = async (code, hostKey = getHostKey(code)) => {
    const result = await request('joinParty', { code, hostKey: hostKey || undefined });
    if (result.ok) {
      socket.party = { code: result.code, hostKey: result.isHost ? hostKey : null, isHost: result.isHost };
      try { localStorage.setItem('jukebox_last_party', result.code); } catch {}
    }
    return result;
  };
  socket.createParty = async () => {
    const created = await request('createParty', {});
    if (!created.ok) return created;
    saveHostKey(created.code, created.hostKey);
    return socket.joinParty(created.code, created.hostKey);
  };
  // Ao reconectar, volta para a mesma festa antes de qualquer outro evento.
  socket.on('connect', () => {
    if (!socket.party.code) return;
    emit('joinParty', { code: socket.party.code, hostKey: socket.party.hostKey || getHostKey(socket.party.code) || undefined }, result => {
      if (!result?.ok) socket.onPartyLost?.(result);
    });
  });
  socket.claimPlayback = async () => {
    const result = await request('registerTv', {});
    if (!result.ok) partyNotice(result.error);
    return result.ok;
  };

  // Não enfileira comandos offline, que poderiam executar contra outra música.
  socket.emit = function (event, data = {}, callback) {
    if (['hostAction', 'registerTv'].includes(event)) {
      (async () => {
        const result = await request(event, data);
        if (!result.ok) partyNotice(result.error);
        callback?.(result);
      })();
      return socket;
    }
    if (['registerPlayer', 'addSong', 'voteSong', 'sendReaction', 'releaseTv', 'getSummary'].includes(event)) {
      request(event, data).then(result => {
        if (!result.ok) partyNotice(result.error);
        callback?.(result);
      });
      return socket;
    }
    return emit(event, data, callback);
  };
  socket.on('connect', () => {
    status.textContent = '● Conectado';
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    clearTimeout(panel._hideTimer);
    panel._hideTimer = setTimeout(() => {
      panel.style.opacity = '0';
      setTimeout(() => { if (panel.style.opacity === '0') panel.style.display = 'none'; }, 300);
    }, 2000);
  });
  socket.on('disconnect', () => {
    clearTimeout(panel._hideTimer);
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    status.textContent = 'Reconectando…';
  });
  socket.on('connect_error', () => {
    clearTimeout(panel._hideTimer);
    panel.style.display = 'flex';
    panel.style.opacity = '1';
    status.textContent = 'Sem conexão';
  });
  socket.on('actionError', result => partyNotice(result.error));
  return socket;
}

function readHostKeys() {
  try { return JSON.parse(localStorage.getItem('jukebox_host_keys') || '{}') || {}; } catch { return {}; }
}
function getHostKey(code) { return code ? readHostKeys()[code] || null : null; }
function saveHostKey(code, key) {
  if (!code || !/^[a-f0-9]{20,128}$/.test(key || '')) return;
  const keys = readHostKeys();
  keys[code] = key;
  try { localStorage.setItem('jukebox_host_keys', JSON.stringify(keys)); } catch {}
}

/** Lê ?festa= e ?chave= da URL, guarda a chave e tira ela da barra de endereço. */
function readPartyFromUrl() {
  const params = new URLSearchParams(window.location.search || '');
  const code = (params.get('festa') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const key = params.get('chave');
  if (code && key) {
    saveHostKey(code, key);
    params.delete('chave');
    try { history.replaceState(null, '', window.location.pathname + '?' + params.toString()); } catch {}
  }
  return code;
}

function setPartyInUrl(code) {
  try { history.replaceState(null, '', window.location.pathname + '?festa=' + encodeURIComponent(code)); } catch {}
}

/** Contagem regressiva do mistério feita no próprio aparelho (o servidor não manda nada a cada segundo). */
function createMysteryClock(render) {
  let base = null;
  let timer = null;
  function update(song, paused) {
    clearInterval(timer);
    timer = null;
    if (!song || song.isRevealed) { base = null; return; }
    base = { id: song.id, remaining: song.mysteryRemainingSeconds, at: Date.now(), paused };
    render(base.remaining);
    if (!paused) timer = setInterval(() => render(remaining()), 500);
  }
  function remaining() {
    if (!base) return 0;
    const passed = base.paused ? 0 : Math.floor((Date.now() - base.at) / 1000);
    return Math.max(0, base.remaining - passed);
  }
  return { update, remaining };
}

/** Cor média da capa (servida pelo próprio servidor para o canvas poder ler). */
function coverColor(videoId) {
  return new Promise(resolve => {
    if (!videoId || typeof Image === 'undefined') return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 24; canvas.height = 24;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2]);
          const min = Math.min(data[i], data[i + 1], data[i + 2]);
          const w = 1 + (max - min) / 32; // valoriza pixels coloridos, não cinza
          r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; weight += w;
        }
        resolve([r, g, b].map(v => Math.round(v / weight)));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = '/api/thumb/' + videoId;
  });
}

function attachMediaRecovery(video, { isActive, source, play, failed }) {
  let attempts = 0;
  let timer;
  let generation = 0;
  video.addEventListener('error', () => {
    if (!isActive() || !source() || timer) return;
    if (attempts >= 2) {
      failed();
      partyNotice('Esta música está indisponível. Use Próxima para continuar a festa.');
      return;
    }
    attempts++;
    const expected = generation;
    const url = source();
    const position = video.currentTime || 0;
    timer = setTimeout(() => {
      timer = null;
      if (expected !== generation || !isActive() || source() !== url) return;
      video.src = url + '?retry=' + attempts;
      video.addEventListener('loadedmetadata', () => {
        if (expected === generation && position > 0) video.currentTime = position;
      }, { once: true });
      play();
    }, attempts * 2000);
  });
  return {
    reset() { generation++; attempts = 0; clearTimeout(timer); timer = null; }
  };
}
