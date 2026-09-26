#!/usr/bin/env node
/**
 * import-csv.js
 *
 * Uso: node scripts/import-csv.js <arquivo.csv> [--bank scripts/raw-bank-full.json]
 *
 * Lê uma planilha CSV (exportada do Google Sheets, Excel etc.), valida cada
 * linha contra o schema do QuizArena (question-schema.js), descarta
 * duplicatas (contra o banco já existente E entre as linhas do próprio
 * arquivo) e ANEXA as perguntas novas e válidas em scripts/raw-bank-full.json
 * (ou no arquivo passado em --bank). Não mexe em data/questions/ diretamente
 * — depois de importar, rode `npm run generate-questions` pra reparticionar.
 *
 * Colunas esperadas no CSV (nessa ordem, com cabeçalho na 1ª linha):
 *   category, difficulty, question, option_a, option_b, option_c, option_d, correct
 *
 *   - category: um id de scripts/question-schema.js (historia, religiao,
 *     etc. — exatamente como está lá, com acento/hífen já removidos onde
 *     aplicável)
 *   - difficulty: facil | medio | dificil
 *   - correct: qual das 4 opções é a certa — aceita "a"/"b"/"c"/"d"
 *     (maiúsculo ou minúsculo) OU o índice numérico 0-3
 *
 * Ver scripts/import-template.csv para um modelo pronto pra copiar.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./csv-parser');
const { CATEGORIES, DIFFICULTIES, validationErrors, duplicateKey } = require('./question-schema');

const EXPECTED_HEADER = ['category', 'difficulty', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct'];

function parseArgs(argv) {
  const args = { csvPath: null, bankPath: path.join(__dirname, 'raw-bank-full.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bank') { args.bankPath = argv[++i]; continue; }
    if (!args.csvPath) args.csvPath = argv[i];
  }
  return args;
}

/** Converte "a"/"B"/"2" etc. em índice 0-3. Devolve null se não reconhecer. */
function parseCorrectIndex(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  const letterMap = { a: 0, b: 1, c: 2, d: 3 };
  if (v in letterMap) return letterMap[v];
  if (/^[0-3]$/.test(v)) return Number(v);
  return null;
}

function rowToQuestion(cols, header) {
  const get = (name) => {
    const idx = header.indexOf(name);
    return idx === -1 ? '' : (cols[idx] ?? '').trim();
  };
  const correctIndex = parseCorrectIndex(get('correct'));
  return {
    category: get('category').toLowerCase(),
    difficulty: get('difficulty').toLowerCase(),
    question: get('question'),
    options: [get('option_a'), get('option_b'), get('option_c'), get('option_d')],
    correct_index: correctIndex === null ? -1 : correctIndex, // -1 força erro de validação com mensagem clara
  };
}

function main() {
  const { csvPath, bankPath } = parseArgs(process.argv.slice(2));
  if (!csvPath) {
    console.error('Uso: node import-csv.js <arquivo.csv> [--bank scripts/raw-bank-full.json]');
    console.error(`Colunas esperadas: ${EXPECTED_HEADER.join(', ')}`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new Error('CSV vazio.');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missingCols = EXPECTED_HEADER.filter((c) => !header.includes(c));
  if (missingCols.length) {
    throw new Error(
      `Cabeçalho do CSV não tem as colunas: ${missingCols.join(', ')}.\n` +
      `Esperado: ${EXPECTED_HEADER.join(', ')}\n` +
      `Encontrado: ${header.join(', ')}`
    );
  }

  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));
  if (!Array.isArray(bank)) throw new Error(`${bankPath} não é um array JSON.`);

  const existingKeys = new Set(bank.map(duplicateKey));
  const report = { rowsRead: 0, added: 0, invalid: [], duplicates: [] };
  const toAppend = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (cols.length === 1 && cols[0].trim() === '') continue; // linha em branco
    report.rowsRead++;
    const lineNumber = i + 1; // +1 porque a linha 1 é o cabeçalho

    const q = rowToQuestion(cols, header);
    const errors = validationErrors(q);
    if (q.correct_index === -1) errors.push(`coluna "correct" não reconhecida: "${cols[header.indexOf('correct')]}" (use a/b/c/d ou 0-3)`);
    if (errors.length) {
      report.invalid.push({ line: lineNumber, question: q.question.slice(0, 60), errors });
      continue;
    }

    const key = duplicateKey(q);
    if (existingKeys.has(key)) {
      report.duplicates.push({ line: lineNumber, question: q.question.slice(0, 60) });
      continue;
    }
    existingKeys.add(key); // também pega duplicata DENTRO do próprio CSV

    toAppend.push({
      category: q.category,
      difficulty: q.difficulty,
      question: q.question.trim(),
      options: q.options,
      correct_index: q.correct_index,
    });
    report.added++;
  }

  if (toAppend.length > 0) {
    const updatedBank = [...bank, ...toAppend];
    fs.writeFileSync(bankPath, JSON.stringify(updatedBank, null, 2) + '\n', 'utf-8');
  }

  console.log('\n=== Relatório de Importação ===');
  console.log(`Linhas lidas: ${report.rowsRead}`);
  console.log(`Adicionadas ao banco: ${report.added}`);
  console.log(`Rejeitadas (schema inválido): ${report.invalid.length}`);
  console.log(`Duplicadas (já existiam): ${report.duplicates.length}`);

  if (report.invalid.length) {
    console.log('\n--- Linhas rejeitadas ---');
    for (const item of report.invalid) {
      console.log(`  linha ${item.line} ("${item.question}..."): ${item.errors.join('; ')}`);
    }
  }
  if (report.duplicates.length) {
    console.log('\n--- Linhas duplicadas (ignoradas) ---');
    for (const item of report.duplicates) {
      console.log(`  linha ${item.line}: "${item.question}..."`);
    }
  }

  if (report.added > 0) {
    console.log(`\n✅ ${bankPath} atualizado. Rode "npm run generate-questions" para reparticionar data/questions/.`);
  } else {
    console.log('\nNenhuma pergunta nova foi adicionada.');
  }

  console.log(`\nCategorias válidas: ${CATEGORIES.join(', ')}`);
  console.log(`Dificuldades válidas: ${DIFFICULTIES.join(', ')}`);
}

main();
