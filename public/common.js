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
    display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', borderRadius: '10px', background: 'rgba(22, 24, 39, 0.85)', backdropFilter: 'blur(8px)' });
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

  socket.requestHost = () => Promise.resolve(true);
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
    if (['registerPlayer', 'addSong', 'voteSong', 'sendReaction', 'releaseTv'].includes(event)) {
      request(event, data).then(result => {
        if (!result.ok) partyNotice(result.error);
        callback?.(result);
      });
      return socket;
    }
    return emit(event, data, callback);
  };
  socket.on('connect', () => { status.textContent = '● Conectado'; });
  socket.on('disconnect', () => {
    status.textContent = 'Reconectando…';
  });
  socket.on('connect_error', () => { status.textContent = 'Sem conexão'; });
  socket.on('actionError', result => partyNotice(result.error));
  return socket;
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
