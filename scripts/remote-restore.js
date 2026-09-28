'use strict';

/**
 * Baixa o backup do GitHub para <dados>/quizarena.db quando NÃO existe banco
 * local (disco novo do Render). Chamado pelo db.js no boot (num processo
 * filho, porque o db.js é síncrono), mas também dá para rodar à mão.
 *
 * Códigos de saída: 0 = ok (restaurou, ou não havia nada a fazer/remoto
 * ainda vazio); 1 = falha de rede/credencial. Falhar de propósito é o
 * comportamento seguro: subir com banco vazio e depois enviar esse banco
 * vazio por cima do backup bom seria pior do que não subir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const persistence = require('../persistence');
const remote = require('../remote-backup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = remote.getConfig();
  if (!cfg) return console.log('[backup-remoto] não configurado (GITHUB_BACKUP_REPO/TOKEN) — nada a fazer.');

  const { dir } = persistence.resolveDataDir();
  const dbPath = path.join(dir, persistence.DB_FILE);
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    return console.log('[backup-remoto] já existe banco local — nada a restaurar.');
  }

  let buf;
  for (let attempt = 1; ; attempt++) {
    try {
      buf = await remote.download(cfg);
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`[backup-remoto] tentativa ${attempt} falhou (${err.message}); tentando de novo...`);
      await sleep(2000 * attempt);
    }
  }

  if (!buf) return console.log(`[backup-remoto] ainda não há backup em ${cfg.repo}/${cfg.path} — começando com banco novo.`);

  // Só grava se o arquivo baixado for um SQLite íntegro.
  const tmp = path.join(os.tmpdir(), `quizarena-remote-${process.pid}.db`);
  fs.writeFileSync(tmp, buf);
  try {
    if (!persistence.isValidDb(tmp)) throw new Error('o arquivo baixado não é um banco SQLite íntegro');
    fs.mkdirSync(dir, { recursive: true });
    for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
    fs.copyFileSync(tmp, dbPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  console.log(`[backup-remoto] banco restaurado de ${cfg.repo}/${cfg.path} (${buf.length} bytes).`);
})().catch((err) => {
  console.error(`[backup-remoto] FALHA ao restaurar: ${err.message}`);
  process.exit(1);
});
