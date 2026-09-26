'use strict';

/**
 * Preparação de ambiente para os testes automatizados. Precisa ser
 * "require"ado ANTES de qualquer coisa que carregue server.js, porque as
 * variáveis de ambiente abaixo têm que estar definidas quando server.js
 * (e, por baixo dele, db.js) rodam pela primeira vez.
 *
 * Cada arquivo de teste roda em processo próprio (comportamento padrão do
 * `node --test`), então cada um pega sua própria porta livre (PORT=0, o SO
 * escolhe) e sua própria pasta de dados temporária (DATA_DIR) — os arquivos
 * de teste nunca se pisam nem tocam no data/quizarena.db de verdade.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quizarena-test-'));
process.env.PORT = '0';
if (!process.env.ADMIN_CLEAR_CODE) process.env.ADMIN_CLEAR_CODE = 'codigo-de-teste';
// Grace period de reconexão bem menor que o padrão (45s) — os testes que
// precisam ver o que acontece QUANDO ele expira não podem esperar 45s a
// cada rodada de CI. Testes que não mexem com isso não são afetados.
// Partidas de 1 pergunta nos testes (em produção o mínimo é 3).
if (!process.env.MIN_TOTAL_QUESTIONS) process.env.MIN_TOTAL_QUESTIONS = '1';
// Nos testes, partidas de 2 jogadores já valem para o ranking (em produção o mínimo é 3).
if (!process.env.MIN_RANKED_PLAYERS) process.env.MIN_RANKED_PLAYERS = '2';
if (!process.env.RECONNECT_GRACE_MS) process.env.RECONNECT_GRACE_MS = '1200';

const server = require('../server');

function baseUrl() {
  const address = server.httpServer.address();
  return `http://127.0.0.1:${address.port}`;
}

module.exports = { server, baseUrl };
