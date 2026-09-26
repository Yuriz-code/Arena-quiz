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

test('citar o texto de uma alternativa durante a pergunta é censurado', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const q = await startGameAndGetFirstQuestion(host);
  // Usa o texto exato de uma das opções que o próprio servidor mandou — não
  // importa qual pergunta caiu, o mecanismo de censura vale para QUALQUER
  // alternativa (não só a correta).
  const optionText = q.options[0];

  const noticePromise = waitForEvent(p2.socket, 'chat:notice');
  const ack = await emitAck(p2.socket, 'chat:send', { roomId: p2.roomId, sessionToken: p2.sessionToken, text: optionText });
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'CENSORED');
  const notice = await noticePromise;
  assert.match(notice.text, /censurada/i);

  host.socket.close();
  p2.socket.close();
});

test('referência por letra ("letra B") é censurada durante a pergunta', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  await startGameAndGetFirstQuestion(host);
  const ack = await emitAck(p2.socket, 'chat:send', { roomId: p2.roomId, sessionToken: p2.sessionToken, text: 'acho que é a letra B' });
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'CENSORED');

  host.socket.close();
  p2.socket.close();
});

test('mensagem normal (sem spoiler) passa normalmente durante a pergunta', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  await startGameAndGetFirstQuestion(host);
  const receivedByHost = waitForEvent(host.socket, 'chat:message');
  const ack = await emitAck(p2.socket, 'chat:send', { roomId: p2.roomId, sessionToken: p2.sessionToken, text: 'boa sorte, gente!' });
  assert.equal(ack.ok, true);
  const msg = await receivedByHost;
  assert.equal(msg.text, 'boa sorte, gente!');

  host.socket.close();
  p2.socket.close();
});

test('depois do reveal, o texto que antes era censurado passa a ser permitido', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const q = await startGameAndGetFirstQuestion(host);
  const optionText = q.options[0];

  const revealPromise = waitForEvent(host.socket, 'question:reveal');
  host.socket.emit('submit_answer', { roomId: host.roomId, sessionToken: host.sessionToken, questionId: q.id, chosenIndex: 0 });
  p2.socket.emit('submit_answer', { roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, chosenIndex: 0 });
  await revealPromise; // fase agora é 'reveal' (ou já indo para 'podium', com 1 pergunta só)

  const ack = await emitAck(p2.socket, 'chat:send', { roomId: p2.roomId, sessionToken: p2.sessionToken, text: optionText });
  assert.equal(ack.ok, true, 'fora da fase "question", a censura não deve mais se aplicar');

  host.socket.close();
  p2.socket.close();
});
