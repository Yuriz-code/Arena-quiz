'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, createRoom, joinRoom } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

async function startGameAndGetFirstQuestion(host) {
  host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: 1 });
  const questionPromise = waitForEvent(host.socket, 'question:start');
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });
  return questionPromise;
}

test('reportar uma pergunta com motivo válido é aceito', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const q = await startGameAndGetFirstQuestion(host);
  const ack = await emitAck(p2.socket, 'report_question', {
    roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, reason: 'pergunta_ambigua',
  });
  assert.equal(ack.ok, true);

  host.socket.close();
  p2.socket.close();
});

test('motivo fora da lista fechada é recusado', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const q = await startGameAndGetFirstQuestion(host);
  const ack = await emitAck(p2.socket, 'report_question', {
    roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, reason: 'texto livre qualquer',
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'INVALID_REASON');

  host.socket.close();
  p2.socket.close();
});

test('reportar um questionId que não é mais o atual é recusado', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  await startGameAndGetFirstQuestion(host);
  const ack = await emitAck(p2.socket, 'report_question', {
    roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: 'id-que-nao-existe', reason: 'outro',
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'QUESTION_CHANGED');

  host.socket.close();
  p2.socket.close();
});
