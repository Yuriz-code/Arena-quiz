'use strict';

/**
 * Atualizar o código não pode apagar contas nem placar. Cada cenário roda o
 * db.js em processos separados (como reiniciar o servidor de verdade) com
 * DATA_DIR/BACKUP_DIR temporários — não precisa de socket nem de rede.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'quizarena-persist-')); }

function runNode(code, env) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], {
    cwd: ROOT, env: { ...process.env, BACKUP_INTERVAL_MINUTES: '0', ...env },
  }).toString();
}
function runScript(script, args, env) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join('scripts', script), ...args], {
    cwd: ROOT, env: { ...process.env, ...env },
  }).toString();
}

const SEED = `const db = require('./db');
db.createUser({ id: 'u1', username: 'ana', passwordHash: 'h', recoveryCodeHash: null, avatar: 'x' });
db.upsertPlayerStatsBatch({ k1: { nickname: 'Ana', avatar: 'x', gamesPlayed: 3, wins: 2, correctAnswers: 5, wrongAnswers: 1, totalScore: 99 } });
db.close();`;
const READ = `const db = require('./db');
console.log('RESULT ' + JSON.stringify({ user: !!db.getUserByUsername('ana'), stats: Object.keys(db.loadAllPlayerStats()).length }));
db.close();`;
const result = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));

test('banco apagado: o backup mais recente é restaurado no boot (contas e placar voltam)', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  runNode(SEED, env);
  assert.ok(fs.readdirSync(env.BACKUP_DIR).some((f) => f.endsWith('.db')), 'backup criado ao encerrar');

  fs.rmSync(env.DATA_DIR, { recursive: true }); // simula disco novo / pasta substituída
  assert.deepEqual(result(runNode(READ, env)), { user: true, stats: 1 });
});

test('reiniciar sem mudanças não acumula backups idênticos', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  runNode(SEED, env);
  runNode(READ, env);
  const after1 = fs.readdirSync(env.BACKUP_DIR).length;
  runNode(READ, env);
  runNode(READ, env);
  assert.equal(fs.readdirSync(env.BACKUP_DIR).length, after1);
});

test('banco vazio nunca gera backup (não empurra os bons pela rotação)', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  runNode(`require('./db').close();`, env);
  assert.deepEqual(fs.existsSync(env.BACKUP_DIR) ? fs.readdirSync(env.BACKUP_DIR) : [], []);
});

test('rotação mantém só BACKUP_KEEP backups', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups'), BACKUP_KEEP: '2' };
  runNode(SEED, env);
  for (let i = 0; i < 4; i++) {
    runNode(`const db = require('./db');
      db.upsertPlayerStatsBatch({ k${i}: { nickname: 'P${i}', avatar: 'x', gamesPlayed: 1, wins: 0, correctAnswers: 1, wrongAnswers: 0, totalScore: ${i} } });
      db.close();`, env);
  }
  assert.equal(fs.readdirSync(env.BACKUP_DIR).filter((f) => f.endsWith('.db')).length, 2);
});

test('scripts backup e restore: restaura um arquivo e guarda o banco anterior', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  runNode(SEED, env);
  const manual = path.join(root, 'manual.db');
  runScript('backup.js', [manual], env);
  assert.ok(fs.existsSync(manual));

  // Estraga o banco atual (perde tudo) e restaura do arquivo manual.
  fs.rmSync(env.DATA_DIR, { recursive: true });
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.DATA_DIR, 'quizarena.db'), 'lixo');
  runScript('restore.js', [manual], env);
  assert.deepEqual(result(runNode(READ, env)), { user: true, stats: 1 });
});

test('restore recusa arquivo que não é um banco íntegro', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  const bad = path.join(root, 'ruim.db');
  fs.writeFileSync(bad, 'isto não é sqlite');
  assert.throws(() => runScript('restore.js', [bad], { ...env }), /Command failed/);
});
