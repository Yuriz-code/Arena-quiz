'use strict';

/**
 * Restaura o banco a partir de um backup. PARE O SERVIDOR antes de rodar.
 * O banco atual não é perdido: uma cópia dele fica em <backups>/ com o sufixo
 * "antes-da-restauracao".
 *
 *   node scripts/restore.js ./meu-backup.db
 *   node scripts/restore.js --latest        # o backup mais recente de BACKUP_DIR
 */

const fs = require('fs');
const path = require('path');
const persistence = require('../persistence');

const { dir: dataDir } = persistence.resolveDataDir();
const backupDir = persistence.resolveBackupDir(dataDir);
const dbPath = path.join(dataDir, persistence.DB_FILE);

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: node scripts/restore.js <arquivo.db>   (ou --latest)');
  process.exit(1);
}
const source = arg === '--latest'
  ? persistence.listBackups(backupDir).find((b) => persistence.isValidDb(b.file))?.file
  : path.resolve(arg);

if (!source || !fs.existsSync(source)) {
  console.error('Backup não encontrado.');
  process.exit(1);
}
if (!persistence.isValidDb(source)) {
  console.error(`${source} não é um banco SQLite íntegro; restauração cancelada.`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dbPath)) {
  fs.mkdirSync(backupDir, { recursive: true });
  const safety = path.join(backupDir, `quizarena-${Date.now()}-antes-da-restauracao.db`);
  try {
    persistence.snapshotFile(dbPath, safety);
  } catch {
    // Banco atual corrompido (o motivo mais comum de restaurar): guarda o arquivo como está.
    fs.copyFileSync(dbPath, safety);
  }
  console.log(`Banco atual guardado em ${safety}`);
}
for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
fs.copyFileSync(source, dbPath);
console.log(`Restaurado: ${source} -> ${dbPath}. Já pode iniciar o servidor.`);
