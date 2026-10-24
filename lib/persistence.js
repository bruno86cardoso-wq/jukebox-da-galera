const fs = require('node:fs');
const path = require('node:path');

function createPersistence(filename, snapshot, validate) {
  let timer;
  function load() {
    if (!filename || !fs.existsSync(filename)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (data.version !== 1 || !validate(data)) throw new Error('Formato de estado inválido');
      return data;
    } catch (error) {
      // Preserva o arquivo para recuperação manual; não sobrescreve dados ilegíveis.
      throw new Error(`Não foi possível recuperar ${filename}: ${error.message}`);
    }
  }
  function flush() {
    clearTimeout(timer);
    if (!filename) return;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...snapshot() }), { mode: 0o600 });
    fs.renameSync(temporary, filename);
  }
  function schedule() {
    if (!filename) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { flush(); } catch (error) { console.error('Falha ao salvar festa:', error.message); }
    }, 200);
    timer.unref();
  }
  return { load, flush, schedule };
}

module.exports = { createPersistence };
