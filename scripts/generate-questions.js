#!/usr/bin/env node
/**
 * generate-questions.js
 *
 * Uso: node scripts/generate-questions.js <banco-bruto.json> <diretorio-saida>
 * Ex.: node scripts/generate-questions.js ./scripts/raw-bank-full.json ./data/questions
 *
 * Lê um banco de perguntas "cru" (não necessariamente particionado nem
 * embaralhado), valida cada item contra o schema do QuizArena (ver
 * question-schema.js), descarta duplicatas (mesma pergunta normalizada, já
 * na mesma categoria), embaralha as alternativas preservando o rastreio do
 * índice correto, particiona por categoria e trava em 100 perguntas por
 * categoria. Reexecutável: sempre reprocessa do zero a partir do banco
 * bruto (não duplica, e uma categoria removida do schema não deixa lixo
 * para trás — arquivos de categorias que não existem mais são apagados).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CATEGORIES, QUESTIONS_PER_CATEGORY, validationErrors, duplicateKey } = require('./question-schema');

function shuffleOptionsPreservingCorrectIndex(options, correctIndex) {
  const indexed = options.map((text, i) => ({ text, wasCorrect: i === correctIndex }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  return {
    options: indexed.map((o) => o.text),
    correct_index: indexed.findIndex((o) => o.wasCorrect),
  };
}

function generateId(category, sequence) {
  const prefix = category.replace(/[^a-z]/g, '').slice(0, 3) || 'cat';
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}

function main() {
  const [, , inputPath, outputDir] = process.argv;
  if (!inputPath || !outputDir) {
    console.error('Uso: node generate-questions.js <banco-bruto.json> <diretorio-saida>');
    process.exit(1);
  }

  const rawBank = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  if (!Array.isArray(rawBank)) throw new Error('Arquivo de entrada deve ser um array JSON.');

  fs.mkdirSync(outputDir, { recursive: true });

  const buckets = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const seenKeys = new Set(); // deduplicação global (ver duplicateKey)
  const report = { total: 0, rejected: 0, duplicates: 0, byCategory: {} };

  rawBank.forEach((q, idx) => {
    const errors = validationErrors(q);
    if (errors.length) {
      console.warn(`⚠️  Pergunta bruta #${idx} rejeitada:\n  - ${errors.join('\n  - ')}`);
      report.rejected++;
      return;
    }

    const key = duplicateKey(q);
    if (seenKeys.has(key)) {
      console.warn(`⚠️  Pergunta bruta #${idx} é duplicata (mesmo texto já visto nesta categoria): "${q.question.slice(0, 60)}..."`);
      report.duplicates++;
      return;
    }
    seenKeys.add(key);

    const bucket = buckets[q.category];
    if (bucket.length >= QUESTIONS_PER_CATEGORY) return;

    const { options, correct_index } = shuffleOptionsPreservingCorrectIndex(q.options, q.correct_index);
    const sequence = bucket.length + 1;

    bucket.push({
      id: generateId(q.category, sequence),
      category: q.category,
      difficulty: q.difficulty,
      question: q.question.trim(),
      options,
      correct_index,
    });
    report.total++;
  });

  CATEGORIES.forEach((category) => {
    const bucket = buckets[category];
    const filePath = path.join(outputDir, `${category}.json`);
    fs.writeFileSync(filePath, JSON.stringify(bucket, null, 2), 'utf-8');
    report.byCategory[category] = `${bucket.length}/${QUESTIONS_PER_CATEGORY}`;
  });

  // Remove arquivos de categorias que existiam antes mas saíram do schema
  // (ex.: ao dividir "religiao" em subtemas, religiao.json vira lixo órfão).
  try {
    for (const file of fs.readdirSync(outputDir)) {
      if (!file.endsWith('.json')) continue;
      const category = file.slice(0, -'.json'.length);
      if (!CATEGORIES.includes(category)) {
        fs.unlinkSync(path.join(outputDir, file));
        console.warn(`🗑️  Removido ${file} (categoria não existe mais no schema).`);
      }
    }
  } catch { /* diretório pode não existir ainda em alguns ambientes de teste */ }

  console.log('\n=== Relatório de Geração ===');
  console.table(report.byCategory);
  console.log(`Total válidas processadas: ${report.total}`);
  console.log(`Total rejeitadas (schema inválido): ${report.rejected}`);
  console.log(`Total descartadas por duplicidade: ${report.duplicates}`);

  const incomplete = CATEGORIES.filter((c) => buckets[c].length < QUESTIONS_PER_CATEGORY);
  if (incomplete.length) {
    console.warn(`\n⚠️  Categorias incompletas (abaixo de ${QUESTIONS_PER_CATEGORY}): ${incomplete.join(', ')}`);
    console.warn('    Adicione mais perguntas ao banco bruto (ver import-csv.js) e execute novamente.');
    process.exitCode = 2;
  } else {
    console.log(`\n✅ Todas as ${CATEGORIES.length} categorias atingiram ${QUESTIONS_PER_CATEGORY} perguntas.`);
  }
}

main();

