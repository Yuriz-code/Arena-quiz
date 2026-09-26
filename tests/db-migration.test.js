'use strict';

// Um banco criado ANTES das colunas de ranking precisa ser atualizado sem
// perder nada — e o placar que já existia continua contando inteiro.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

test('banco antigo é migrado: colunas novas + placar existente vale para o ranking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-migr-'));
  const dbFile = path.join(dir, 'quizarena.db');

  // Esquema ANTIGO (sem ranked_*), com um jogador e uma linha de log.
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE player_stats (
      key TEXT PRIMARY KEY, nickname TEXT NOT NULL, avatar TEXT NOT NULL,
      games_played INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
      correct_answers INTEGER NOT NULL DEFAULT 0, wrong_answers INTEGER NOT NULL DEFAULT 0,
      total_score REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE game_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_key TEXT NOT NULL, nickname TEXT NOT NULL,
      avatar TEXT NOT NULL, score REAL NOT NULL, correct_count INTEGER NOT NULL,
      wrong_count INTEGER NOT NULL, is_winner INTEGER NOT NULL, played_at INTEGER NOT NULL
    );
    INSERT INTO player_stats VALUES ('d:antigo-0001', 'Veterano', '💀', 7, 3, 40, 10, 555.5);
    INSERT INTO game_log (player_key, nickname, avatar, score, correct_count, wrong_count, is_winner, played_at)
      VALUES ('d:antigo-0001', 'Veterano', '💀', 80, 6, 1, 1, ${Date.now()});
  `);
  old.close();

  const script = `
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
    const stats = db.loadAllPlayerStats();
    const period = db.listPeriodAggregates(0);
    db.close();
    console.log(JSON.stringify({ stats, period }));
  `;
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
    env: { ...process.env, DATA_DIR: dir }, encoding: 'utf-8',
  });
  const { stats, period } = JSON.parse(out.trim().split('\n').pop());

  const v = stats['d:antigo-0001'];
  assert.equal(v.gamesPlayed, 7);
  assert.equal(v.rankedGames, 7, 'histórico antigo conta inteiro para o ranking');
  assert.equal(v.rankedWins, 3);
  assert.equal(v.rankedScore, 555.5);
  assert.equal(period.length, 1, 'linha antiga do log vale para o ranking (ranked padrão = 1)');
  assert.equal(period[0].games, 1);
});
