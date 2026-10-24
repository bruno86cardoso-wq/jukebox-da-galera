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

function askHostCode() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Ativar controles de anfitrião');
    dialog.style.cssText = 'margin:auto;width:min(420px,90vw);padding:24px;border:1px solid #64748b;border-radius:18px;background:#161827;color:#fff;box-shadow:0 0 0 100vmax #0009';
    const form = document.createElement('form');
    const title = document.createElement('h2');
    title.textContent = 'Controles do anfitrião';
    const description = document.createElement('p');
    description.innerHTML = 'Para controlar a reprodução, pular faixas ou usar o <strong>Modo JBL</strong>, informe o PIN do anfitrião.<br/><small style="display:block;margin-top:6px;color:#94a3b8">Convidados não precisam de código para pedir músicas ou votar.</small>';
    description.style.cssText = 'margin:12px 0;color:#cbd5e1;font-size:14px;line-height:1.4';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = 'Digite o PIN (ex: HOST_PIN)';
    input.setAttribute('aria-label', 'Código do anfitrião');
    input.required = true;
    input.style.cssText = 'width:100%;padding:12px;background:#0f172a;color:#fff;border:1px solid #64748b;border-radius:8px;margin-bottom:14px;font-size:16px';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Ativar controles 🚀';
    submit.style.cssText = 'padding:12px 18px;border:0;border-radius:8px;background:#6846c7;color:white;margin-right:8px;cursor:pointer;font-weight:700';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    cancel.style.cssText = 'padding:12px 16px;border:1px solid #64748b;border-radius:8px;background:transparent;color:white;cursor:pointer';
    function finish(value) { input.value = ''; dialog.close(); dialog.remove(); resolve(value); }
    form.addEventListener('submit', event => { event.preventDefault(); finish(input.value.trim()); });
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    form.append(title, description, input, submit, cancel);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
  });
}

function createPartySocket() {
  let playerToken = localStorage.getItem('jukebox_player_token');
  if (!/^[a-f0-9]{64}$/.test(playerToken || '')) {
    playerToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('jukebox_player_token', playerToken);
  }
  const socket = io({ auth: { playerToken, hostToken: sessionStorage.getItem('jukebox_host_token') || '' } });
  const emit = socket.emit.bind(socket);
  let authorized = false;
  let authorization;
  const panel = document.createElement('div');
  Object.assign(panel.style, { position: 'fixed', bottom: '10px', right: '10px', zIndex: '9000',
    display: 'flex', gap: '8px', alignItems: 'center', padding: '8px', borderRadius: '10px', background: '#161827' });
  const status = document.createElement('span');
  status.textContent = 'Conectando…';
  status.setAttribute('role', 'status');
  status.style.cssText = 'color:#cbd5e1;font-size:12px';
  const button = document.createElement('button');
  button.textContent = '🔑 Anfitrião';
  button.style.cssText = 'background:#6846c7;color:white;border:0;border-radius:8px;padding:9px;cursor:pointer';
  panel.append(status, button);
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

  socket.requestHost = function () {
    if (authorized) return Promise.resolve(true);
    if (authorization) return authorization;
    authorization = (async () => {
      if (!socket.connected) { partyNotice('Aguarde a conexão com a festa.'); return false; }
      let result;
      const token = sessionStorage.getItem('jukebox_host_token');
      if (token) result = await request('authenticateHost', { token });
      if (!result?.ok) {
        const pin = await askHostCode();
        if (!pin) return false;
        result = await request('authenticateHost', { pin: pin.trim() });
      }
      if (!result.ok) { partyNotice(result.error); return false; }
      authorized = true;
      sessionStorage.setItem('jukebox_host_token', result.token);
      socket.auth.hostToken = result.token;
      button.textContent = '🔑 Anfitrião ativo';
      return true;
    })().finally(() => { authorization = null; });
    return authorization;
  };
  button.addEventListener('click', () => socket.requestHost());
  socket.claimPlayback = async () => {
    if (!await socket.requestHost()) return false;
    const result = await request('registerTv', {});
    if (!result.ok) partyNotice(result.error);
    return result.ok;
  };

  // Não enfileira comandos offline, que poderiam executar contra outra música.
  socket.emit = function (event, data = {}, callback) {
    if (['hostAction', 'registerTv'].includes(event)) {
      (async () => {
        if (!await socket.requestHost()) return callback?.({ ok: false, error: 'Ação cancelada.' });
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
    authorized = false;
    button.textContent = '🔑 Anfitrião';
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
