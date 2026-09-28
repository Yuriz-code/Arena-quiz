'use strict';

/**
 * Backup manual do banco (contas, placar, histórico). Pode rodar com o
 * servidor LIGADO — usa um snapshot consistente, não copia o arquivo "cru".
 *
 *   node scripts/backup.js                 # grava em BACKUP_DIR (padrão: <dados>/backups)
 *   node scripts/backup.js ./meu-backup.db # grava nesse arquivo
 */

const fs = require('fs');
const path = require('path');
const persistence = require('../persistence');

const { dir: dataDir } = persistence.resolveDataDir();
const dbPath = path.join(dataDir, persistence.DB_FILE);
if (!fs.existsSync(dbPath)) {
  console.error(`Nenhum banco encontrado em ${dbPath}. Defina DATA_DIR se ele estiver em outro lugar.`);
  process.exit(1);
}

const arg = process.argv[2];
let dest;
if (arg) {
  dest = path.resolve(arg);
} else {
  const backupDir = persistence.resolveBackupDir(dataDir);
  fs.mkdirSync(backupDir, { recursive: true });
  dest = path.join(backupDir, `quizarena-${persistence.stamp()}-manual.db`);
}
if (fs.existsSync(dest)) {
  console.error(`O arquivo ${dest} já existe; escolha outro nome.`);
  process.exit(1);
}
persistence.snapshotFile(dbPath, dest);
console.log(`Backup gravado em ${dest}`);
