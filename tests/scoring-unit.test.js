'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateScore, desiredDifficultyFor, isBonusQuestionNumber, ANSWER_NETWORK_GRACE_MS,
} = require('../scoring');

const q = (over = {}) => ({
  difficulty: 'medio', correct_index: 2, startedAtServerTs: 1_000_000, __roomTimeLimitMs: 15_000, ...over,
});

test('acerto instantâneo vale o máximo (base × 1.0); no limite vale metade', () => {
  assert.equal(calculateScore(q(), 2, 1_000_000).points, 200);
  assert.equal(calculateScore(q(), 2, 1_015_000).points, 100);
});

test('resposta errada não pontua', () => {
  const r = calculateScore(q(), 1, 1_001_000);
  assert.equal(r.correct, false);
  assert.equal(r.points, 0);
});

test('dentro da folga de rede ainda entra, mas sem bônus de velocidade extra', () => {
  const r = calculateScore(q(), 2, 1_015_000 + ANSWER_NETWORK_GRACE_MS);
  assert.equal(r.correct, true);
  assert.equal(r.points, 100);
});

test('além da folga, ou antes de a pergunta abrir, é recusada', () => {
  assert.equal(calculateScore(q(), 2, 1_015_000 + ANSWER_NETWORK_GRACE_MS + 1).correct, false);
  assert.equal(calculateScore(q(), 2, 999_999).correct, false);
});

test('pergunta bônus dobra os pontos', () => {
  assert.equal(calculateScore(q({ __isBonus: true, difficulty: 'dificil' }), 2, 1_000_000).points, 600);
});

test('curva de dificuldade: fácil → médio → difícil, e 5ª pergunta é bônus difícil', () => {
  assert.equal(desiredDifficultyFor(1, 10), 'facil');
  assert.equal(desiredDifficultyFor(4, 10), 'medio');
  assert.equal(desiredDifficultyFor(8, 10), 'dificil');
  assert.equal(isBonusQuestionNumber(5), true);
  assert.equal(desiredDifficultyFor(5, 10), 'dificil');
  assert.equal(isBonusQuestionNumber(6), false);
});
