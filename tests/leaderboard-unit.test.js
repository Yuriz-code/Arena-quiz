'use strict';

// Testes da lógica pura de ranking (leaderboard.js) — sem servidor nem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBoard } = require('../leaderboard');

const row = (key, o = {}) => ({
  key, nickname: key, avatar: '', games: 1, wins: 0, correct: 0, wrong: 0, score: 0, ...o,
});

test('points: ordena pela soma de pontos e desempata por vitórias', () => {
  const rows = [
    row('a', { games: 2, score: 100, wins: 0 }),
    row('b', { games: 2, score: 100, wins: 1 }),
    row('c', { games: 1, score: 150 }),
  ];
  const { rows: out } = buildBoard(rows, { metric: 'points' });
  assert.deepEqual(out.map((r) => r.nickname), ['c', 'b', 'a']);
  assert.deepEqual(out.map((r) => r.rank), [1, 2, 3]);
});

test('average: quem joga muito mas joga mal NÃO passa quem joga menos e melhor', () => {
  const rows = [
    row('grinder', { games: 50, score: 2500 }), // média 50
    row('craque', { games: 5, score: 400 }),    // média 80
  ];
  const points = buildBoard(rows, { metric: 'points' }).rows.map((r) => r.nickname);
  const average = buildBoard(rows, { metric: 'average', minGamesForRates: 5 }).rows.map((r) => r.nickname);
  assert.deepEqual(points, ['grinder', 'craque']);
  assert.deepEqual(average, ['craque', 'grinder']);
});

test('average/accuracy exigem mínimo de partidas; points/wins não', () => {
  const rows = [
    row('sortudo', { games: 1, score: 200, wins: 1, correct: 1, wrong: 0 }),
    row('veterano', { games: 6, score: 300, wins: 2, correct: 40, wrong: 20 }),
  ];
  const avg = buildBoard(rows, { metric: 'average', minGamesForRates: 5 });
  assert.deepEqual(avg.rows.map((r) => r.nickname), ['veterano']);
  assert.equal(avg.minGames, 5);

  const acc = buildBoard(rows, { metric: 'accuracy', minGamesForRates: 5 });
  assert.deepEqual(acc.rows.map((r) => r.nickname), ['veterano']);

  const wins = buildBoard(rows, { metric: 'wins', minGamesForRates: 5 });
  assert.deepEqual(wins.rows.map((r) => r.nickname), ['veterano', 'sortudo']);
  assert.equal(wins.minGames, 1);
});

test('accuracy: percentual de acertos', () => {
  const rows = [
    row('a', { games: 5, correct: 30, wrong: 10 }), // 75%
    row('b', { games: 5, correct: 9, wrong: 1 }),   // 90%
  ];
  const { rows: out } = buildBoard(rows, { metric: 'accuracy', minGamesForRates: 5 });
  assert.deepEqual(out.map((r) => [r.nickname, r.accuracy]), [['b', 90], ['a', 75]]);
});

test('me: devolve a posição real mesmo fora do top; isMe marca a linha dentro do top', () => {
  const rows = Array.from({ length: 15 }, (_, i) => row(`p${i}`, { games: 1, score: 1000 - i * 10 }));
  const outside = buildBoard(rows, { metric: 'points', limit: 10, myKey: 'p13' });
  assert.equal(outside.rows.length, 10);
  assert.ok(outside.rows.every((r) => r.isMe === false));
  assert.equal(outside.me.rank, 14);
  assert.equal(outside.me.nickname, 'p13');

  const inside = buildBoard(rows, { metric: 'points', limit: 10, myKey: 'p2' });
  assert.equal(inside.me.rank, 3);
  assert.equal(inside.rows.find((r) => r.isMe).nickname, 'p2');
});

test('meNeeded: quantas partidas faltam para entrar em média/precisão', () => {
  const rows = [row('eu', { games: 2, score: 100 }), row('outro', { games: 6, score: 300 })];
  const board = buildBoard(rows, { metric: 'average', minGamesForRates: 5, myKey: 'eu' });
  assert.equal(board.me, null);
  assert.equal(board.meNeeded, 3);
});

test('consulta anônima ou jogador desconhecido: sem me e sem meNeeded', () => {
  const rows = [row('a', { score: 10 })];
  const anon = buildBoard(rows, { metric: 'points', myKey: null });
  assert.equal(anon.me, null);
  assert.equal(anon.meNeeded, null);
  const unknown = buildBoard(rows, { metric: 'average', minGamesForRates: 5, myKey: 'ninguem' });
  assert.equal(unknown.me, null);
  assert.equal(unknown.meNeeded, null);
});

test('critério inválido cai em points; lista vazia não quebra', () => {
  const rows = [row('a', { score: 5 }), row('b', { score: 9 })];
  assert.deepEqual(buildBoard(rows, { metric: 'inventado' }).rows.map((r) => r.nickname), ['b', 'a']);
  const empty = buildBoard([], { metric: 'wins' });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.me, null);
});
