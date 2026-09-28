/**
 * Persistência em SQLite — placar geral, histórico anti-repetição de
 * perguntas e log de partidas (usado por futuros placares semanais/mensais).
 *
 * Por quê SQLite em vez dos arquivos JSON antigos (data/player-stats.json e
 * data/question-history.json): um único arquivo, gravação transacional (não
 * fica pela metade se o processo cair no meio) e é a forma padrão de dar
 * "estado" a um serviço num host efêmero.
 *
 * IMPORTANTE — isso sozinho NÃO sobrevive a um redeploy no Render (ou
 * qualquer host com disco efêmero): o arquivo .db mora em DATA_DIR, e se
 * DATA_DIR estiver no disco normal do serviço, ele é apagado a cada deploy
 * igual antes. O que resolve de verdade é apontar DATA_DIR para um **disco
 * persistente** (Render Disks, por exemplo, montado em /data) — ver README.
 *
 * Usa o módulo nativo `node:sqlite` (sem dependência externa, sem compilação
 * nativa) — disponível a partir do Node 22.5. Por isso o `engines` do
 * package.json exige Node >=22.5.
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
// Nota: o aviso "ExperimentalWarning: SQLite is an experimental feature" é
// esperado (usamos node:sqlite de propósito) e é silenciado via a flag
// --disable-warning=ExperimentalWarning no script "start" do package.json —
// um listener de process.on('warning') NÃO impede a impressão padrão do Node.

const persistence = require('./persistence');

// Onde ficam os dados (ver persistence.js): DATA_DIR, senão ~/.quizarena —
// fora da pasta do projeto, para atualizar/substituir o código não apagar
// contas nem placar.
const { dir: DATA_DIR, source: DATA_DIR_SOURCE } = persistence.resolveDataDir();
const BACKUP_DIR = persistence.resolveBackupDir(DATA_DIR);
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
// 0 desliga só o backup periódico (início e encerramento continuam).
const BACKUP_INTERVAL_MINUTES = process.env.BACKUP_INTERVAL_MINUTES !== undefined
  ? Number(process.env.BACKUP_INTERVAL_MINUTES) || 0
  : 360;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`Não foi possível criar DATA_DIR (${DATA_DIR}):`, err.message);
}

const DB_PATH = path.join(DATA_DIR, persistence.DB_FILE);

// Antes de abrir: (1) traz o banco antigo que morava na pasta do projeto;
// (2) se não há banco (disco novo/apagado), restaura o backup mais recente.
const adoptedLegacy = persistence.adoptLegacyDatabase(DATA_DIR);
const remote = require('./remote-backup');
const remoteConfig = remote.getConfig();

// Sem banco local + backup no GitHub configurado (Render: disco novo a cada
// deploy): baixa o backup remoto ANTES de abrir o banco. Roda num processo
// filho porque este arquivo é síncrono. Se falhar, o servidor NÃO sobe:
// começar vazio e depois enviar esse banco vazio por cima do backup bom
// seria pior. (REMOTE_RESTORE_OPTIONAL=1 aceita subir vazio mesmo assim.)
const dbFileAtBoot = path.join(DATA_DIR, persistence.DB_FILE);
if (remoteConfig && !(fs.existsSync(dbFileAtBoot) && fs.statSync(dbFileAtBoot).size > 0)) {
  try {
    process.stdout.write(require('child_process').execFileSync(
      process.execPath, [path.join(__dirname, 'scripts', 'remote-restore.js')],
      { env: process.env, timeout: 90_000, stdio: ['ignore', 'pipe', 'inherit'] }
    ));
  } catch (err) {
    if (process.env.REMOTE_RESTORE_OPTIONAL === '1') {
      console.error('[db] Restauração remota falhou; subindo com banco novo (REMOTE_RESTORE_OPTIONAL=1).');
    } else {
      throw new Error('Restauração do backup remoto (GitHub) falhou — abortando para não sobrescrever o backup com um banco vazio. Veja o erro acima.');
    }
  }
}

const restoredFrom = persistence.restoreLatestBackupIfNeeded(DATA_DIR, BACKUP_DIR);
if (adoptedLegacy) console.log(`[db] Banco antigo de ${persistence.LEGACY_DATA_DIR} copiado para ${DB_PATH}.`);
if (restoredFrom) console.log(`[db] Nenhum banco encontrado: restaurado o backup ${restoredFrom}.`);

const isNewDatabase = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);

// WAL: leituras não bloqueiam gravações e vice-versa; menor risco de
// corrupção que o modo padrão se o processo for encerrado abruptamente.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');

/** O banco tem algo que valha proteger? (nunca gera backup de banco vazio: ele empurraria os bons pela rotação) */
function hasUserData() {
  try {
    return ['users', 'player_stats', 'game_log'].some(
      (t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get() !== undefined
    );
  } catch {
    return false; // tabelas ainda não existem
  }
}

/** Backup agora (a menos que o banco esteja vazio ou idêntico ao último backup). */
function backupNow(label = '', { force = false } = {}) {
  try {
    if (!force && !hasUserData()) return null;
    const file = persistence.createBackup(db, BACKUP_DIR, label, { skipIfSame: !force });
    if (file) persistence.pruneBackups(BACKUP_DIR, BACKUP_KEEP);
    return file;
  } catch (err) {
    console.error('[db] Falha ao criar backup:', err.message);
    return null;
  }
}

// Snapshot ANTES das migrações de esquema abaixo: se a versão nova do código
// mexer no banco, o estado anterior à atualização fica guardado.
const startupBackup = isNewDatabase ? null : backupNow('inicio');

db.exec(`
  CREATE TABLE IF NOT EXISTS player_stats (
    key              TEXT PRIMARY KEY,
    nickname         TEXT NOT NULL,
    avatar           TEXT NOT NULL,
    games_played     INTEGER NOT NULL DEFAULT 0,
    wins             INTEGER NOT NULL DEFAULT 0,
    correct_answers  INTEGER NOT NULL DEFAULT 0,
    wrong_answers    INTEGER NOT NULL DEFAULT 0,
    total_score      REAL NOT NULL DEFAULT 0,
    -- Contadores que valem para o RANKING (partidas com jogadores suficientes,
    -- ver MIN_RANKED_PLAYERS no server.js). Os campos acima seguem contando
    -- tudo, para o placar pessoal de cada jogador.
    ranked_games     INTEGER NOT NULL DEFAULT 0,
    ranked_wins      INTEGER NOT NULL DEFAULT 0,
    ranked_correct   INTEGER NOT NULL DEFAULT 0,
    ranked_wrong     INTEGER NOT NULL DEFAULT 0,
    ranked_score     REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS question_history (
    category  TEXT PRIMARY KEY,
    ids_json  TEXT NOT NULL DEFAULT '[]'
  );

  -- Log append-only de resultados por jogador/partida. Não é usado ainda
  -- pelo servidor (placar geral continua vindo de player_stats), mas é a
  -- base pronta para um placar semanal/mensal (WHERE played_at > ...) sem
  -- precisar migrar o esquema de novo depois.
  CREATE TABLE IF NOT EXISTS game_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_key    TEXT NOT NULL,
    nickname      TEXT NOT NULL,
    avatar        TEXT NOT NULL,
    score         REAL NOT NULL,
    correct_count INTEGER NOT NULL,
    wrong_count   INTEGER NOT NULL,
    is_winner     INTEGER NOT NULL,
    played_at     INTEGER NOT NULL,
    ranked        INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_game_log_played_at ON game_log (played_at);
  CREATE INDEX IF NOT EXISTS idx_game_log_player_key ON game_log (player_key);

  -- "Reportar pergunta errada": um jogador reporta um problema (resposta
  -- errada, ambígua, erro de digitação...) numa pergunta específica durante
  -- a partida. Não corrige nada sozinho — é insumo pra quem mantém o banco
  -- de perguntas revisar (ver scripts/list-reports.js).
  CREATE TABLE IF NOT EXISTS question_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id    TEXT NOT NULL,
    category       TEXT NOT NULL,
    question_text  TEXT NOT NULL,
    reason         TEXT NOT NULL,
    room_id        TEXT NOT NULL,
    nickname       TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_question_reports_question_id ON question_reports (question_id);

  -- Contas de usuário (login por usuário+senha). Totalmente separado do
  -- sessionToken de sala: uma conta identifica a PESSOA (entre dispositivos
  -- e partidas diferentes); o sessionToken continua identificando só a
  -- presença dela dentro de UMA sala específica.
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    -- Hash (mesmo esquema scrypt de password_hash) do código de recuperação
    -- mostrado UMA VEZ no cadastro. Null só é possível em conta migrada de
    -- antes deste campo existir (ver ensureColumn abaixo) — nesse caso
    -- "esqueci a senha" não tem como validar e recusa (ver auth:forgot_password).
    recovery_code_hash  TEXT,
    avatar              TEXT NOT NULL,
    created_at          INTEGER NOT NULL
  );

  -- Tokens de sessão de LOGIN (authToken), não confundir com o sessionToken
  -- de sala. Guardados à parte (não como coluna única em "users") para
  -- permitir a mesma conta logada em vários dispositivos ao mesmo tempo.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token         TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens (user_id);
`);

db.exec('PRAGMA foreign_keys = ON;'); // ativa o ON DELETE CASCADE de auth_tokens acima

// ----------------------------------------------------------------------------
// Migração de esquema para bancos criados antes das colunas de ranking.
// CREATE TABLE IF NOT EXISTS não altera tabela existente, então adiciona-se
// a coluna à mão, uma vez só (checa PRAGMA table_info antes).
// ----------------------------------------------------------------------------

function ensureColumn(table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (exists) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

const addedRankedColumns = [
  ensureColumn('player_stats', 'ranked_games', 'INTEGER NOT NULL DEFAULT 0'),
  ensureColumn('player_stats', 'ranked_wins', 'INTEGER NOT NULL DEFAULT 0'),
  ensureColumn('player_stats', 'ranked_correct', 'INTEGER NOT NULL DEFAULT 0'),
  ensureColumn('player_stats', 'ranked_wrong', 'INTEGER NOT NULL DEFAULT 0'),
  ensureColumn('player_stats', 'ranked_score', 'REAL NOT NULL DEFAULT 0'),
].some(Boolean);
// game_log antigo: todas as linhas já existentes valem para o ranking (DEFAULT 1).
ensureColumn('game_log', 'ranked', 'INTEGER NOT NULL DEFAULT 1');
// Contas criadas antes do código de recuperação existir: coluna fica NULL
// (nenhum dado antigo pra migrar aqui — "esqueci a senha" recusa até a
// pessoa trocar a senha logada, que já grava um código novo).
ensureColumn('users', 'recovery_code_hash', 'TEXT');

if (addedRankedColumns) {
  // Placar que já existia (antes de haver a distinção) conta inteiro para o
  // ranking — ninguém perde posição por causa da atualização.
  db.exec(`
    UPDATE player_stats SET
      ranked_games = games_played, ranked_wins = wins,
      ranked_correct = correct_answers, ranked_wrong = wrong_answers,
      ranked_score = total_score
  `);
}

// ----------------------------------------------------------------------------
// Migração única dos arquivos JSON antigos, se existirem e o banco for novo.
// Depois de importar, renomeia os arquivos originais para .migrado-<ts> em
// vez de apagar — melhor um arquivo extra parado no disco do que perder dado
// de produção por um bug na migração.
// ----------------------------------------------------------------------------

function migrateLegacyJsonIfNeeded() {
  if (!isNewDatabase) return; // banco já existia: já rodou (ou nunca precisou)

  const legacyStatsFile = path.join(__dirname, 'data', 'player-stats.json');
  const legacyHistoryFile = path.join(__dirname, 'data', 'question-history.json');

  const readJsonSafe = (filePath) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const legacyStats = readJsonSafe(legacyStatsFile);
  if (legacyStats && Object.keys(legacyStats).length > 0) {
    console.log(`Migrando ${Object.keys(legacyStats).length} jogador(es) de player-stats.json para SQLite...`);
    upsertPlayerStatsBatch(legacyStats);
    try { fs.renameSync(legacyStatsFile, `${legacyStatsFile}.migrado-${Date.now()}`); } catch { /* melhor esforço */ }
  }

  const legacyHistory = readJsonSafe(legacyHistoryFile);
  if (legacyHistory && Object.keys(legacyHistory).length > 0) {
    console.log(`Migrando histórico de perguntas de ${Object.keys(legacyHistory).length} categoria(s) para SQLite...`);
    saveQuestionHistoryBatch(legacyHistory);
    try { fs.renameSync(legacyHistoryFile, `${legacyHistoryFile}.migrado-${Date.now()}`); } catch { /* melhor esforço */ }
  }
}

// ----------------------------------------------------------------------------
// Placar geral (player_stats)
// ----------------------------------------------------------------------------

/** @returns {Record<string, {nickname:string, avatar:string, gamesPlayed:number, wins:number, correctAnswers:number, wrongAnswers:number, totalScore:number}>} */
function loadAllPlayerStats() {
  const rows = db.prepare('SELECT * FROM player_stats').all();
  const out = {};
  for (const r of rows) {
    out[r.key] = {
      nickname: r.nickname,
      avatar: r.avatar,
      gamesPlayed: r.games_played,
      wins: r.wins,
      correctAnswers: r.correct_answers,
      wrongAnswers: r.wrong_answers,
      totalScore: r.total_score,
      rankedGames: r.ranked_games,
      rankedWins: r.ranked_wins,
      rankedCorrect: r.ranked_correct,
      rankedWrong: r.ranked_wrong,
      rankedScore: r.ranked_score,
    };
  }
  return out;
}

const upsertPlayerStatsStmt = db.prepare(`
  INSERT INTO player_stats (key, nickname, avatar, games_played, wins, correct_answers, wrong_answers, total_score,
                            ranked_games, ranked_wins, ranked_correct, ranked_wrong, ranked_score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    nickname = excluded.nickname,
    avatar = excluded.avatar,
    games_played = excluded.games_played,
    wins = excluded.wins,
    correct_answers = excluded.correct_answers,
    wrong_answers = excluded.wrong_answers,
    total_score = excluded.total_score,
    ranked_games = excluded.ranked_games,
    ranked_wins = excluded.ranked_wins,
    ranked_correct = excluded.ranked_correct,
    ranked_wrong = excluded.ranked_wrong,
    ranked_score = excluded.ranked_score
`);

/** Executa o upsert de uma entrada (aceita entradas antigas sem campos ranked_*: valem inteiras). */
function runUpsertPlayerStats(key, e) {
  upsertPlayerStatsStmt.run(
    key,
    e.nickname,
    e.avatar,
    e.gamesPlayed || 0,
    e.wins || 0,
    e.correctAnswers || 0,
    e.wrongAnswers || 0,
    e.totalScore || 0,
    e.rankedGames ?? (e.gamesPlayed || 0),
    e.rankedWins ?? (e.wins || 0),
    e.rankedCorrect ?? (e.correctAnswers || 0),
    e.rankedWrong ?? (e.wrongAnswers || 0),
    e.rankedScore ?? (e.totalScore || 0)
  );
}

/** Grava (upsert) o objeto inteiro de placar geral numa única transação. */
function upsertPlayerStatsBatch(playerStatsObj) {
  const entries = Object.entries(playerStatsObj);
  if (entries.length === 0) return;
  db.exec('BEGIN');
  try {
    for (const [key, e] of entries) runUpsertPlayerStats(key, e);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Zera o placar por inteiro: o geral (player_stats) E o log de partidas
 * (game_log), de onde saem os placares de 7/30 dias — senão "limpar" deixaria
 * os rankings por período mostrando dados que o geral já não tem.
 */
function clearAllPlayerStats() {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM player_stats');
    db.exec('DELETE FROM game_log');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Passa o placar de uma chave para outra (ex.: histórico do aparelho "d:..."
 * reivindicado por uma conta "u:..."), numa única transação: grava a entrada
 * nova, apaga a antiga e reaponta o log de partidas.
 */
function movePlayerStats(oldKey, newKey, entry) {
  db.exec('BEGIN');
  try {
    runUpsertPlayerStats(newKey, entry);
    db.prepare('DELETE FROM player_stats WHERE key = ?').run(oldKey);
    db.prepare('UPDATE game_log SET player_key = ? WHERE player_key = ?').run(newKey, oldKey);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Histórico anti-repetição de perguntas (question_history)
// ----------------------------------------------------------------------------

/** @returns {Record<string, string[]>} */
function loadQuestionHistory() {
  const rows = db.prepare('SELECT * FROM question_history').all();
  const out = {};
  for (const r of rows) {
    try {
      out[r.category] = JSON.parse(r.ids_json);
    } catch {
      out[r.category] = [];
    }
  }
  return out;
}

const upsertHistoryStmt = db.prepare(`
  INSERT INTO question_history (category, ids_json) VALUES (?, ?)
  ON CONFLICT(category) DO UPDATE SET ids_json = excluded.ids_json
`);

/** Grava (upsert) o objeto inteiro de histórico numa única transação. */
function saveQuestionHistoryBatch(historyObj) {
  const entries = Object.entries(historyObj);
  if (entries.length === 0) return;
  db.exec('BEGIN');
  try {
    for (const [category, ids] of entries) {
      upsertHistoryStmt.run(category, JSON.stringify(ids));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Log de partidas (base para placar semanal/mensal futuro)
// ----------------------------------------------------------------------------

const insertGameLogStmt = db.prepare(`
  INSERT INTO game_log (player_key, nickname, avatar, score, correct_count, wrong_count, is_winner, played_at, ranked)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** @param {{playerKey:string, nickname:string, avatar:string, score:number, correctCount:number, wrongCount:number, isWinner:boolean, ranked?:boolean}[]} entries */
function appendGameLog(entries) {
  if (!entries || entries.length === 0) return;
  const playedAt = Date.now();
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      insertGameLogStmt.run(e.playerKey, e.nickname, e.avatar, e.score, e.correctCount, e.wrongCount, e.isWinner ? 1 : 0, playedAt, e.ranked === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Totais por jogador das partidas que valem para o ranking desde `sinceMs`
 * (placares de 7/30 dias). Nome/avatar vêm da última partida de cada um.
 * @returns {{key:string, nickname:string, avatar:string, games:number, wins:number, correct:number, wrong:number, score:number}[]}
 */
function listPeriodAggregates(sinceMs) {
  return db.prepare(`
    SELECT
      g.player_key AS key,
      (SELECT nickname FROM game_log x WHERE x.player_key = g.player_key ORDER BY x.id DESC LIMIT 1) AS nickname,
      (SELECT avatar   FROM game_log x WHERE x.player_key = g.player_key ORDER BY x.id DESC LIMIT 1) AS avatar,
      COUNT(*)            AS games,
      SUM(g.is_winner)    AS wins,
      SUM(g.correct_count) AS correct,
      SUM(g.wrong_count)   AS wrong,
      SUM(g.score)         AS score
    FROM game_log g
    WHERE g.ranked = 1 AND g.played_at >= ?
    GROUP BY g.player_key
  `).all(sinceMs);
}

// ----------------------------------------------------------------------------
// "Reportar pergunta errada" (question_reports) — ver report_question em
// server.js. Não corrige nada sozinho; só junta os relatos pra revisão
// manual depois (scripts/list-reports.js).
// ----------------------------------------------------------------------------

const insertQuestionReportStmt = db.prepare(`
  INSERT INTO question_reports (question_id, category, question_text, reason, room_id, nickname, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/** @param {{questionId:string, category:string, questionText:string, reason:string, roomId:string, nickname:string}} entry */
function insertQuestionReport(entry) {
  insertQuestionReportStmt.run(
    entry.questionId, entry.category, entry.questionText, entry.reason, entry.roomId, entry.nickname, Date.now()
  );
}

/**
 * Resumo agrupado por pergunta, mais reportada primeiro — é o que
 * scripts/list-reports.js exibe pra quem for revisar o banco de perguntas.
 */
function listQuestionReportsSummary() {
  return db.prepare(`
    SELECT
      question_id AS questionId,
      category,
      question_text AS questionText,
      COUNT(*) AS reportCount,
      GROUP_CONCAT(DISTINCT reason) AS reasons,
      MIN(created_at) AS firstReportedAt,
      MAX(created_at) AS lastReportedAt
    FROM question_reports
    GROUP BY question_id
    ORDER BY reportCount DESC, lastReportedAt DESC
  `).all();
}

// ----------------------------------------------------------------------------
// Contas de usuário (users / auth_tokens) — ver comentário das tabelas acima.
// Nada aqui sabe o que é uma "sala"; essa é a fronteira proposital entre
// login e o resto do jogo.
// ----------------------------------------------------------------------------

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, username, password_hash, recovery_code_hash, avatar, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/**
 * Cria uma conta nova. Lança (erro do SQLite, mensagem contém "UNIQUE") se o
 * username já existir — quem chama decide como traduzir isso pro usuário.
 * @param {{id:string, username:string, passwordHash:string, recoveryCodeHash:string, avatar:string}} u
 */
function createUser(u) {
  insertUserStmt.run(u.id, u.username, u.passwordHash, u.recoveryCodeHash, u.avatar, Date.now());
}

/** @returns {object|null} linha crua da tabela users (inclui password_hash) */
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

/** @returns {object|null} linha crua da tabela users (inclui password_hash) */
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

const updatePasswordStmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
/** Troca a senha (fluxo logado ou recuperação por código já validados por quem chama). */
function updateUserPassword(userId, passwordHash) {
  updatePasswordStmt.run(passwordHash, userId);
}

const updateRecoveryCodeStmt = db.prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ?');
/** Substitui o código de recuperação (cadastro, ou toda vez que "esqueci a senha" é usado com sucesso). */
function updateRecoveryCodeHash(userId, recoveryCodeHash) {
  updateRecoveryCodeStmt.run(recoveryCodeHash, userId);
}

/**
 * Edita usuário/avatar de uma conta já existente. Lança (mensagem contém
 * "UNIQUE") se o novo username já pertencer a outra conta.
 * @param {string} userId
 * @param {{username:string, avatar:string}} fields
 */
function updateUserProfile(userId, { username, avatar }) {
  db.prepare('UPDATE users SET username = ?, avatar = ? WHERE id = ?').run(username, avatar, userId);
}

const insertTokenStmt = db.prepare(`
  INSERT INTO auth_tokens (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
`);

/** Gera e grava um novo authToken para o usuário (login bem-sucedido ou cadastro). */
function createAuthToken(userId) {
  const token = crypto.randomUUID();
  const now = Date.now();
  insertTokenStmt.run(token, userId, now, now);
  return token;
}

const touchAuthTokenStmt = db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token = ?');

/**
 * Resolve um authToken para a conta dona dele (usado no "lembrar login" ao
 * reconectar). Atualiza last_seen_at de brinde — não é usado pra nada ainda,
 * mas fica pronto pra um futuro "encerrar sessões inativas".
 * @returns {object|null} linha crua da tabela users, ou null se o token não existir
 */
function getUserByToken(token) {
  const row = db.prepare(`
    SELECT u.* FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(token);
  if (row) touchAuthTokenStmt.run(Date.now(), token);
  return row || null;
}

/** Igual a getUserByToken, mas só lê (não atualiza last_seen_at) — usado em consultas de placar. */
function peekUserByToken(token) {
  return db.prepare(`
    SELECT u.* FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `).get(token) || null;
}

/** Invalida um authToken (logout). Silencioso se o token não existir mais. */
function deleteAuthToken(token) {
  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

/**
 * "Sair de todos os aparelhos" / segurança pós-troca-de-senha: apaga todos os
 * authTokens da conta. Passe `exceptToken` para manter a sessão atual (ex.:
 * trocar senha estando logado não precisa deslogar quem está fazendo isso).
 */
function deleteAuthTokensForUser(userId, exceptToken) {
  if (exceptToken) {
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token != ?').run(userId, exceptToken);
  } else {
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId);
  }
}

/**
 * Expira sessões de login inativas há mais de `maxAgeMs` (baseado em
 * last_seen_at, atualizado a cada auth:resume). Chamado periodicamente pelo
 * server.js — não é crítico rodar exatamente no horário, só de vez em quando.
 * @returns {number} quantos tokens foram removidos
 */
function pruneOldAuthTokens(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare('DELETE FROM auth_tokens WHERE last_seen_at < ?').run(cutoff);
  return result.changes || 0;
}

migrateLegacyJsonIfNeeded();

// Log de diagnóstico sempre visível no início: é a forma mais rápida de
// perceber "por que minha conta/placar sumiu depois de atualizar o
// código" — se DATA_DIR não estiver fixado num lugar estável (fora da
// pasta do código, ou um disco persistente em produção), cada nova cópia
// do projeto abre um banco NOVO E VAZIO neste caminho, mesmo que o código
// em si esteja correto. Ver a seção de persistência no README.
console.log(`[db] Banco de dados em: ${DB_PATH} (${DATA_DIR_SOURCE})${isNewDatabase ? ' — novo, nenhuma conta/placar anterior encontrado aqui' : ''}`);
console.log(`[db] Backups em: ${BACKUP_DIR} (mantém ${BACKUP_KEEP}${startupBackup ? `; backup de início: ${path.basename(startupBackup)}` : ''})`);

// Backup periódico. unref(): o timer nunca segura o processo vivo.
if (BACKUP_INTERVAL_MINUTES > 0) {
  setInterval(() => backupNow('auto'), BACKUP_INTERVAL_MINUTES * 60 * 1000).unref();
}

// ---- Envio do backup para o GitHub -----------------------------------------
const REMOTE_INTERVAL_MINUTES = process.env.GITHUB_BACKUP_INTERVAL_MINUTES !== undefined
  ? Number(process.env.GITHUB_BACKUP_INTERVAL_MINUTES) || 0
  : 10;
// total_changes() = linhas alteradas por ESTA conexão desde que abriu: contador
// exato de "houve gravação?", sem depender de relógio/mtime de arquivo. O que já
// veio do backup remoto (ou das migrações do boot) não precisa voltar.
const totalChanges = () => Number(db.prepare('SELECT total_changes() AS n').get().n);
let lastRemotePushChanges = totalChanges();
let remotePushing = null;

/**
 * Envia o estado atual ao GitHub se houve alteração desde o último envio e o
 * banco tem dados. Nunca lança: falha de rede vira log e nova tentativa no
 * próximo ciclo. `force` ignora a checagem de alteração.
 */
function pushRemote({ force = false } = {}) {
  if (!remoteConfig) return Promise.resolve(false);
  if (remotePushing) return remotePushing; // já tem um envio em andamento
  const changesNow = totalChanges();
  if (!hasUserData() || (!force && changesNow <= lastRemotePushChanges)) return Promise.resolve(false);
  let snapshot;
  remotePushing = (async () => {
    try {
      snapshot = exportSnapshot();
      await remote.upload(remoteConfig, fs.readFileSync(snapshot), `backup ${new Date().toISOString()}`);
      lastRemotePushChanges = changesNow;
      return true;
    } catch (err) {
      console.error('[backup-remoto] Falha ao enviar para o GitHub:', err.message);
      return false;
    } finally {
      if (snapshot) fs.rm(snapshot, { force: true }, () => {});
      remotePushing = null;
    }
  })();
  return remotePushing;
}

if (remoteConfig) {
  console.log(`[db] Backup remoto no GitHub: ${remoteConfig.repo}/${remoteConfig.path}`);
  if (REMOTE_INTERVAL_MINUTES > 0) {
    setInterval(() => { pushRemote(); }, REMOTE_INTERVAL_MINUTES * 60 * 1000).unref();
  }
}

/** Snapshot avulso num arquivo temporário (para download pelo admin). O chamador apaga o arquivo. */
function exportSnapshot() {
  const file = path.join(os.tmpdir(), `quizarena-export-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

function close() {
  backupNow('encerramento'); // último estado gravado antes de fechar
  try { db.close(); } catch { /* melhor esforço no encerramento */ }
}

module.exports = {
  DATA_DIR,
  DB_PATH,
  BACKUP_DIR,
  backupNow,
  pushRemote,
  exportSnapshot,
  loadAllPlayerStats,
  upsertPlayerStatsBatch,
  clearAllPlayerStats,
  movePlayerStats,
  listPeriodAggregates,
  peekUserByToken,
  loadQuestionHistory,
  saveQuestionHistoryBatch,
  appendGameLog,
  insertQuestionReport,
  listQuestionReportsSummary,
  createUser,
  getUserByUsername,
  getUserById,
  updateUserPassword,
  updateRecoveryCodeHash,
  updateUserProfile,
  createAuthToken,
  getUserByToken,
  deleteAuthToken,
  deleteAuthTokensForUser,
  pruneOldAuthTokens,
  close,
};
