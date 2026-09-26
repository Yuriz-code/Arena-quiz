'use strict';

/**
 * Fonte única de verdade do "formato de pergunta" do QuizArena: categorias
 * válidas, dificuldades válidas, e a validação usada tanto para gerar o
 * banco particionado (generate-questions.js) quanto para importar CSVs
 * novos (import-csv.js). Se um dia adicionar/renomear uma categoria, é
 * SÓ AQUI que precisa mexer nesse arquivo — mas ainda assim replique a
 * mudança em server.js (ALL_CATEGORIES) e public/app.js (CATEGORY_LABELS),
 * que não importam este módulo (um roda no navegador, o outro evita puxar
 * o pipeline de conteúdo pra dentro do processo do servidor).
 */

const { normalize } = require('../chat-guard');

const CATEGORIES = [
  'historia', 'geografia', 'cinema', 'artes', 'musica', 'esportes',
  'religiao',
  'animes', 'desenhos', 'ciencia', 'tecnologia', 'literatura',
];
const DIFFICULTIES = ['facil', 'medio', 'dificil'];
const QUESTIONS_PER_CATEGORY = 100;

/**
 * @param {{question:string, category:string, difficulty:string, options:string[], correct_index:number}} q
 * @returns {string[]} lista de erros (vazia = válida)
 */
function validationErrors(q) {
  const errors = [];
  if (typeof q.question !== 'string' || q.question.trim().length < 10 || q.question.length > 240)
    errors.push(`question inválida (len=${q.question?.length})`);
  if (!CATEGORIES.includes(q.category)) errors.push(`category inválida: ${q.category}`);
  if (!DIFFICULTIES.includes(q.difficulty)) errors.push(`difficulty inválida: ${q.difficulty}`);
  if (!Array.isArray(q.options) || q.options.length !== 4)
    errors.push(`options deve ter exatamente 4 itens (tem ${q.options?.length})`);
  if (Array.isArray(q.options) && q.options.some((o) => typeof o !== 'string' || !o.trim()))
    errors.push('options não pode ter item vazio');
  if (Array.isArray(q.options) && new Set(q.options.map((o) => normalize(o))).size !== q.options.length)
    errors.push('options contém duplicatas (mesmo texto em duas alternativas)');
  if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index > 3)
    errors.push(`correct_index inválido: ${q.correct_index}`);
  return errors;
}

/** Lança um erro descritivo se a pergunta for inválida; não faz nada se for válida. */
function assertValid(q, label) {
  const errors = validationErrors(q);
  if (errors.length) throw new Error(`${label} rejeitada:\n  - ${errors.join('\n  - ')}`);
}

/**
 * Chave de deduplicação: só o texto da pergunta, normalizado (sem acento,
 * minúsculo, pontuação fora — reaproveita a mesma normalização do
 * chat-guard). Duas perguntas iguais mas com opções reordenadas ou
 * reescritas continuam contando como duplicata, que é o objetivo — o problema
 * do jogador é ver a MESMA PERGUNTA nas duas partidas, não exatamente o
 * mesmo array de opções.
 */
function duplicateKey(q) {
  return `${q.category}::${normalize(q.question)}`;
}

module.exports = { CATEGORIES, DIFFICULTIES, QUESTIONS_PER_CATEGORY, validationErrors, assertValid, duplicateKey };
