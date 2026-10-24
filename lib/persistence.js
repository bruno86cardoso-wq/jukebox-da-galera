const fs = require('node:fs');
const path = require('node:path');

function createPersistence(filename, snapshot, validate) {
  let timer;
  function load() {
    if (!filename || !fs.existsSync(filename)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!validate(data)) throw new Error('Formato de estado inválido');
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
    fs.writeFileSync(temporary, JSON.stringify(snapshot()), { mode: 0o600 });
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
  function remove() {
    clearTimeout(timer);
    if (filename) fs.rmSync(filename, { force: true });
  }
  return { load, flush, schedule, remove };
}

module.exports = { createPersistence };
