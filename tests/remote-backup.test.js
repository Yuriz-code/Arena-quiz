'use strict';

/**
 * Backup remoto no GitHub, testado contra um servidor HTTP falso que imita a
 * API "Contents" (GET raw/JSON com sha, PUT com sha). Cada cenário roda o
 * db.js em processo separado (assíncrono, para o servidor falso continuar
 * respondendo) — não precisa de rede nem de socket.io.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const store = { file: null, sha: null, puts: 0, mode: 'ok' }; // mode: 'ok' | 'down'
let server; let apiUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{}'); }
    if (store.mode === 'down') { res.writeHead(500); return res.end('boom'); }
    if (req.method === 'GET') {
      if (!store.file) { res.writeHead(404); return res.end('{}'); }
      if (String(req.headers.accept).includes('raw')) { res.writeHead(200); return res.end(store.file); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sha: store.sha }));
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        if (store.sha && j.sha !== store.sha) { res.writeHead(409); return res.end('{}'); }
        store.file = Buffer.from(j.content, 'base64');
        store.sha = crypto.createHash('sha1').update(store.file).digest('hex');
        store.puts += 1;
        res.writeHead(store.puts === 1 ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function envFor(root, extra = {}) {
  return {
    ...process.env,
    DATA_DIR: path.join(root, 'data'),
    BACKUP_DIR: path.join(root, 'backups'),
    BACKUP_INTERVAL_MINUTES: '0',
    GITHUB_BACKUP_INTERVAL_MINUTES: '0',
    GITHUB_BACKUP_REPO: 'eu/quizarena-backup',
    GITHUB_BACKUP_TOKEN: 'tok',
    GITHUB_API_URL: apiUrl,
    ...extra,
  };
}
function run(code, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: ROOT, env }, (err, out, errOut) => {
      if (err) { err.stderr = errOut; return reject(err); }
      resolve(out);
    });
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quizarena-remote-'));
const SEED_AND_PUSH = `(async () => {
  const db = require('./db');
  db.createUser({ id: 'u1', username: 'ana', passwordHash: 'h', recoveryCodeHash: null, avatar: 'x' });
  db.upsertPlayerStatsBatch({ k1: { nickname: 'Ana', avatar: 'x', gamesPlayed: 3, wins: 2, correctAnswers: 5, wrongAnswers: 1, totalScore: 99 } });
  console.log('PUSHED ' + (await db.pushRemote()));
  db.close();
})();`;
const READ = `const db = require('./db');
console.log('RESULT ' + JSON.stringify({ user: !!db.getUserByUsername('ana'), stats: Object.keys(db.loadAllPlayerStats()).length }));
db.close();`;
const parse = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));

test('envia ao GitHub e um disco NOVO restaura contas e placar de lá', async () => {
  store.mode = 'ok';
  const a = tmp();
  // Sem alteração desde o boot, nada é enviado; com dados novos, envia.
  assert.match(await run(SEED_AND_PUSH, envFor(a)), /PUSHED true/);
  assert.equal(store.puts, 1);
  assert.ok(store.file.length > 0);

  const b = tmp(); // "deploy novo": disco vazio, sem backups locais
  assert.deepEqual(parse(await run(READ, envFor(b))), { user: true, stats: 1 });
});

test('sem alterações desde o último envio, não envia de novo', async () => {
  store.mode = 'ok';
  const putsBefore = store.puts;
  const root = tmp();
  await run(READ, envFor(tmp())); // restaura e fecha
  const out = await run(`(async () => { const db = require('./db');
    console.log('PUSHED ' + (await db.pushRemote())); db.close(); })();`, envFor(root));
  assert.match(out, /PUSHED false/); // banco novo/vazio: nada a enviar
  assert.equal(store.puts, putsBefore);
});

test('GitHub fora do ar no boot sem banco: o servidor NÃO sobe (não sobrescreve o backup)', async () => {
  store.mode = 'down';
  await assert.rejects(run(READ, envFor(tmp())), (err) => {
    assert.match(err.stderr, /Restauração do backup remoto/);
    return true;
  });
  store.mode = 'ok';
});

test('REMOTE_RESTORE_OPTIONAL=1 aceita subir vazio se o GitHub falhar', async () => {
  store.mode = 'down';
  const out = await run(`const db = require('./db'); console.log('RESULT ' + JSON.stringify({ user: !!db.getUserByUsername('ana'), stats: 0 })); db.close();`,
    envFor(tmp(), { REMOTE_RESTORE_OPTIONAL: '1' }));
  assert.deepEqual(parse(out), { user: false, stats: 0 });
  store.mode = 'ok';
});

test('ainda sem backup remoto (404): começa com banco novo, sem erro', async () => {
  const saved = { ...store };
  store.file = null; store.sha = null; store.puts = 0;
  const out = await run(`const db = require('./db'); console.log('RESULT ' + JSON.stringify({ user: !!db.getUserByUsername('ana'), stats: 0 })); db.close();`, envFor(tmp()));
  assert.deepEqual(parse(out), { user: false, stats: 0 });
  Object.assign(store, saved);
});

test('arquivo remoto corrompido é recusado (não vira banco)', async () => {
  const saved = { ...store };
  store.file = require('zlib').gzipSync(Buffer.from('isto não é sqlite'));
  store.sha = 'x';
  await assert.rejects(run(READ, envFor(tmp())), (err) => /não é um banco SQLite íntegro/.test(err.stderr));
  Object.assign(store, saved);
});
