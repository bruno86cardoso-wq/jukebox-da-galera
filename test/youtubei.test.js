const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieHeader } = require('../lib/youtubei');

test('lê só os cookies do youtube.com do arquivo no formato Netscape', () => {
  const file = path.join(os.tmpdir(), 'teste-cookies-youtubei.txt');
  fs.writeFileSync(file, [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tvalor1',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tvalor2',
    '.google.com\tTRUE\t/\tTRUE\t1893456000\tNID\tnao-entra',
    ''
  ].join('\n'));
  try {
    assert.equal(cookieHeader(file), 'SID=valor1; __Secure-3PSID=valor2');
    assert.equal(cookieHeader(path.join(os.tmpdir(), 'nao-existe-cookies.txt')), '');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
