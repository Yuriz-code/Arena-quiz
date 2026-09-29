'use strict';

/**
 * Regras de pontuação e curva de dificuldade (extraído de server.js).
 * Funções puras: não dependem de sala, socket nem relógio próprio — o
 * timestamp de chegada é sempre passado pelo servidor (Date.now()).
 */

const BASE_POINTS = { facil: 100, medio: 200, dificil: 300 };

// A sala espera esse tanto A MAIS que roundTimeMs antes de revelar, e
// calculateScore usa EXATAMENTE o mesmo valor para aceitar a resposta —
// senão uma resposta que o servidor esperou seria pontuada como errada só por
// latência de rede.
const ANSWER_NETWORK_GRACE_MS = 300;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** A cada 5ª pergunta é "bônus": sempre difícil e vale pontuação em dobro. */
function isBonusQuestionNumber(questionNumber) {
  return questionNumber % 5 === 0;
}

function desiredDifficultyFor(questionNumber, totalQuestions) {
  if (isBonusQuestionNumber(questionNumber)) return 'dificil';
  const progress = questionNumber / totalQuestions;
  if (progress <= 0.34) return 'facil';
  if (progress <= 0.67) return 'medio';
  return 'dificil';
}

/**
 * Fonte única da verdade: deltaMs vem só de timestamps gerados pelo próprio
 * processo Node.js, nunca de qualquer valor vindo do cliente.
 */
function calculateScore(question, chosenIndex, answerReceivedAtServerTs) {
  const timeLimitMs = question.__roomTimeLimitMs || 15000;
  const deltaMs = answerReceivedAtServerTs - question.startedAtServerTs;

  if (deltaMs < 0 || deltaMs > timeLimitMs + ANSWER_NETWORK_GRACE_MS) {
    return { chosenIndex, deltaMs, correct: false, points: 0 };
  }

  const correct = chosenIndex === question.correct_index;
  if (!correct) return { chosenIndex, deltaMs, correct: false, points: 0 };

  // A folga de rede só decide se a resposta ENTRA; o fator de velocidade usa
  // o delta limitado a timeLimitMs.
  const clampedDeltaMs = Math.min(deltaMs, timeLimitMs);
  const speedFactor = 0.5 + 0.5 * (1 - clampedDeltaMs / timeLimitMs);
  let rawPoints = BASE_POINTS[question.difficulty] * speedFactor;
  if (question.__isBonus) rawPoints *= 2;
  return { chosenIndex, deltaMs, correct: true, points: round2(rawPoints) };
}

module.exports = {
  BASE_POINTS,
  ANSWER_NETWORK_GRACE_MS,
  round2,
  isBonusQuestionNumber,
  desiredDifficultyFor,
  calculateScore,
};
