/**
 * Proteção dos dados (contas, placar geral, histórico) contra atualizações do
 * código. Só usa fs/os/path/node:sqlite — não depende do db.js, então roda
 * ANTES de o banco principal ser aberto.
 *
 * Três camadas:
 *  1. LOCAL ESTÁVEL: sem DATA_DIR, o banco vive em ~/.quizarena (fora da pasta
 *     do projeto). Trocar/substituir a pasta do código não toca nele. Bancos
 *     antigos em <projeto>/data/quizarena.db são adotados (copiados) sozinhos.
 *  2. BACKUPS AUTOMÁTICOS: snapshots consistentes (VACUUM INTO) ao iniciar
 *     — ou seja, ANTES de qualquer migração de esquema da nova versão —, de
 *     tempos em tempos e ao encerrar; só os N mais recentes são mantidos.
 *  3. AUTO-RESTAURAÇÃO: se o banco não existe (disco novo/apagado) mas há
 *     backup válido em BACKUP_DIR, o mais recente é restaurado no boot.
 *
 * Limite honesto: se DATA_DIR e BACKUP_DIR ficarem no MESMO disco efêmero
 * (Render free, container sem volume), o host apaga os dois juntos. Nesse
 * caso é preciso um disco/volume persistente (ver README).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const LEGACY_DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = 'quizarena.db';
const BACKUP_RE = /^quizarena-.*\.db$/;

function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Onde ficam os dados: DATA_DIR, senão ~/.quizarena, senão (último caso) <projeto>/data. */
function resolveDataDir() {
  if (process.env.DATA_DIR) return { dir: path.resolve(process.env.DATA_DIR), source: 'DATA_DIR' };
  let home = '';
  try { home = os.homedir(); } catch { /* sem home: cai no fallback */ }
  if (home) {
    const stable = path.join(home, '.quizarena');
    if (canWriteDir(stable)) return { dir: stable, source: 'pasta do usuário' };
  }
  return { dir: LEGACY_DATA_DIR, source: 'pasta do projeto (fallback)' };
}

function resolveBackupDir(dataDir) {
  return process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(dataDir, 'backups');
}

/** Snapshot consistente (inclui o que ainda está no WAL) de um .db para um arquivo novo. */
function snapshotFile(srcPath, destPath) {
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    src.prepare('VACUUM INTO ?').run(destPath);
  } finally {
    try { src.close(); } catch { /* melhor esforço */ }
  }
}

/** true se o arquivo abre e passa no integrity_check. */
function isValidDb(filePath) {
  let d;
  try {
    d = new DatabaseSync(filePath, { readOnly: true });
    return d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    try { d?.close(); } catch { /* melhor esforço */ }
  }
}

/** Backups existentes, do mais novo para o mais antigo. */
function listBackups(backupDir) {
  let names;
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  return names
    .filter((n) => BACKUP_RE.test(n))
    .map((n) => {
      const file = path.join(backupDir, n);
      return { name: n, file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/**
 * Primeira execução numa pasta de dados nova: se ainda existe um banco na pasta
 * antiga do projeto (<projeto>/data), adota uma cópia consistente dele.
 * Não apaga nada do original.
 */
function adoptLegacyDatabase(dataDir) {
  const target = path.join(dataDir, DB_FILE);
  const legacy = path.join(LEGACY_DATA_DIR, DB_FILE);
  if (path.resolve(dataDir) === LEGACY_DATA_DIR) return false;
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return false;
  try {
    snapshotFile(legacy, target);
    return true;
  } catch {
    try { fs.copyFileSync(legacy, target); return true; } catch { return false; }
  }
}

/** Banco ausente/vazio + backup válido disponível → restaura o mais recente. */
function restoreLatestBackupIfNeeded(dataDir, backupDir) {
  const target = path.join(dataDir, DB_FILE);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return null;
  for (const b of listBackups(backupDir)) {
    if (!isValidDb(b.file)) continue;
    for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
    fs.copyFileSync(b.file, target);
    return b.name;
  }
  return null;
}

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Cria um backup a partir da conexão viva `db`. Grava em .tmp e renomeia (nunca
 * deixa arquivo pela metade). Com `skipIfSame`, descarta o snapshot se o
 * conteúdo for idêntico ao do último backup (reinício sem mudanças não gera cópia).
 * @returns {string|null} caminho do backup, ou null se foi descartado por ser idêntico
 */
function createBackup(db, backupDir, label = '', { skipIfSame = false } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  const base = `quizarena-${stamp()}${label ? `-${label}` : ''}`;
  let final = path.join(backupDir, `${base}.db`);
  for (let i = 2; fs.existsSync(final); i++) final = path.join(backupDir, `${base}-${i}.db`);
  const tmp = `${final}.tmp`;
  fs.rmSync(tmp, { force: true });
  db.prepare('VACUUM INTO ?').run(tmp);
  if (skipIfSame) {
    const latest = listBackups(backupDir)[0];
    if (latest && sha256OfFile(latest.file) === sha256OfFile(tmp)) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
  }
  fs.renameSync(tmp, final);
  return final;
}

/** Mantém só os `keep` backups mais recentes. */
function pruneBackups(backupDir, keep) {
  for (const b of listBackups(backupDir).slice(Math.max(1, keep))) {
    fs.rmSync(b.file, { force: true });
  }
}

module.exports = {
  LEGACY_DATA_DIR,
  DB_FILE,
  resolveDataDir,
  resolveBackupDir,
  snapshotFile,
  isValidDb,
  listBackups,
  adoptLegacyDatabase,
  restoreLatestBackupIfNeeded,
  stamp,
  createBackup,
  pruneBackups,
};
