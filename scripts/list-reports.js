#!/usr/bin/env node
/**
 * list-reports.js
 *
 * Uso: node scripts/list-reports.js
 *      DATA_DIR=/caminho/do/disco node scripts/list-reports.js   (produção)
 *
 * Lê a tabela question_reports (ver db.js e o evento report_question em
 * server.js) e imprime um resumo agrupado por pergunta, mais reportada
 * primeiro — é o ponto de partida pra decidir o que corrigir no banco bruto
 * (scripts/raw-bank-full.json) e reprocessar com `npm run generate-questions`.
 *
 * Não apaga nada sozinho: é só leitura. Depois de corrigir uma pergunta,
 * os reports antigos dela continuam no banco (histórico), então não se
 * assuste se o mesmo questionId aparecer nas duas execuções — o texto da
 * pergunta em si é o que importa conferir.
 */

'use strict';

const db = require('../db');

function formatDate(ts) {
  return new Date(ts).toLocaleString('pt-BR');
}

function main() {
  const summary = db.listQuestionReportsSummary();
  db.close();

  if (summary.length === 0) {
    console.log('Nenhum report de pergunta registrado ainda. 🎉');
    return;
  }

  console.log(`\n=== ${summary.length} pergunta(s) com pelo menos 1 report ===\n`);
  for (const row of summary) {
    console.log(`[${row.reportCount}x] ${row.questionId} (${row.category})`);
    console.log(`  "${row.questionText}"`);
    console.log(`  motivos: ${row.reasons}`);
    console.log(`  primeiro report: ${formatDate(row.firstReportedAt)}  |  último: ${formatDate(row.lastReportedAt)}`);
    console.log('');
  }

  console.log('Dica: o questionId (ex.: "rel-014") é gerado por scripts/generate-questions.js');
  console.log('a partir da posição no banco bruto — procure o texto da pergunta em');
  console.log('scripts/raw-bank-full.json pra corrigir, depois rode "npm run generate-questions".');
}

main();
