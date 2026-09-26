/**
 * Lógica pura dos rankings (sem banco, sem sockets) — recebe linhas já
 * agregadas por jogador e devolve o placar ordenado, com a posição de quem
 * está consultando. Fica separada do server.js para ser testada sozinha.
 *
 * Linha de entrada (uma por jogador):
 *   { key, nickname, avatar, games, wins, correct, wrong, score }
 *
 * Critérios:
 *   points   — soma de pontos
 *   average  — pontos por partida (exige mínimo de partidas, senão uma única
 *              partida boa já lideraria o ranking)
 *   wins     — vitórias
 *   accuracy — % de acertos (exige o mesmo mínimo de partidas)
 */

'use strict';

const METRICS = ['points', 'average', 'wins', 'accuracy'];
const PERIODS = ['all', 'month', 'week'];

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function averageOf(row) {
  return row.games > 0 ? row.score / row.games : 0;
}

function accuracyOf(row) {
  const total = row.correct + row.wrong;
  return total > 0 ? (row.correct / total) * 100 : 0;
}

function metricValue(row, metric) {
  switch (metric) {
    case 'average': return averageOf(row);
    case 'wins': return row.wins;
    case 'accuracy': return accuracyOf(row);
    case 'points':
    default: return row.score;
  }
}

/** Critérios "de taxa" precisam de um mínimo de partidas; os de contagem, só de 1. */
function minGamesFor(metric, minGamesForRates) {
  return metric === 'average' || metric === 'accuracy' ? Math.max(1, minGamesForRates) : 1;
}

/**
 * Ordena por critério (maior primeiro). Desempates, em ordem: pontos, vitórias,
 * menos partidas jogadas (mesmo resultado em menos partidas é melhor), nome.
 */
function compareRows(metric) {
  return (a, b) =>
    (metricValue(b, metric) - metricValue(a, metric)) ||
    (b.score - a.score) ||
    (b.wins - a.wins) ||
    (a.games - b.games) ||
    String(a.nickname).localeCompare(String(b.nickname), 'pt-BR');
}

function publicRow(row, rank, isMe) {
  return {
    rank,
    nickname: row.nickname,
    avatar: row.avatar || '',
    games: row.games,
    wins: row.wins,
    correct: row.correct,
    wrong: row.wrong,
    score: round2(row.score),
    average: round2(averageOf(row)),
    accuracy: round1(accuracyOf(row)),
    isMe,
  };
}

/**
 * @param {object[]} rows linhas agregadas (ver topo do arquivo)
 * @param {{metric?:string, minGamesForRates?:number, limit?:number, myKey?:string|null}} opts
 * @returns {{rows:object[], me:object|null, meNeeded:number|null, minGames:number}}
 *   rows     — top `limit`, cada um com `isMe`
 *   me       — a linha de quem consultou (com `rank` real), ou null se não está no ranking
 *   meNeeded — quantas partidas faltam para essa pessoa entrar neste critério (ou null)
 *   minGames — mínimo de partidas exigido por este critério
 */
function buildBoard(rows, { metric = 'points', minGamesForRates = 5, limit = 10, myKey = null } = {}) {
  const m = METRICS.includes(metric) ? metric : 'points';
  const minGames = minGamesFor(m, minGamesForRates);

  const eligible = rows.filter((r) => r.games >= minGames).sort(compareRows(m));

  let me = null;
  const top = [];
  eligible.forEach((row, i) => {
    const isMe = myKey != null && row.key === myKey;
    if (isMe) me = publicRow(row, i + 1, true);
    if (i < limit) top.push(publicRow(row, i + 1, isMe));
  });

  let meNeeded = null;
  if (!me && myKey != null) {
    const mine = rows.find((r) => r.key === myKey);
    if (mine && mine.games > 0 && mine.games < minGames) meNeeded = minGames - mine.games;
  }

  return { rows: top, me, meNeeded, minGames };
}

module.exports = { METRICS, PERIODS, buildBoard, metricValue, minGamesFor };
