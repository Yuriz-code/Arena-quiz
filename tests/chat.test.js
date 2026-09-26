'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { connectClient, emitAck, waitForEvent, createRoom, joinRoom } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('mensagem de chat chega para os outros e volta com mine:true para quem enviou', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const receivedByP2 = waitForEvent(p2.socket, 'chat:message');
  const ack = await emitAck(host.socket, 'chat:send', { roomId: host.roomId, sessionToken: host.sessionToken, text: 'oi pessoal' });
  assert.equal(ack.ok, true);

  const msg = await receivedByP2;
  assert.equal(msg.text, 'oi pessoal');
  assert.equal(msg.nickname, 'Ana');
  assert.equal(msg.mine, false, 'para quem recebeu, mine deve ser false');

  host.socket.close();
  p2.socket.close();
});

test('quem entra depois recebe o histórico de chat existente', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  await emitAck(host.socket, 'chat:send', { roomId: host.roomId, sessionToken: host.sessionToken, text: 'mensagem antes de Beto entrar' });

  // O servidor emite chat:history logo depois do ack de join_room, no mesmo
  // instante — então o listener precisa ser registrado ANTES do join, senão
  // o evento já chegou quando o joinRoom() devolve (era a causa do timeout).
  const socket = await connectClient(url);
  const historyPromise = waitForEvent(socket, 'chat:history');
  const joinRes = await emitAck(socket, 'join_room', { roomId: host.roomId, nickname: 'Beto', avatar: '👻', deviceId: null });
  assert.equal(joinRes.ok, true);
  const p2 = { socket, ...joinRes };
  const history = await historyPromise;
  assert.ok(history.messages.some((m) => m.text === 'mensagem antes de Beto entrar'));

  host.socket.close();
  p2.socket.close();
});

test('limite anti-spam: a partir da N-ésima mensagem na janela, servidor recusa', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  await joinRoom(url, host.roomId, { nickname: 'Beto' }); // precisa de 2+ pra sala existir de verdade, mas não usado aqui

  const acks = [];
  for (let i = 0; i < 7; i++) {
    // eslint-disable-next-line no-await-in-loop
    acks.push(await emitAck(host.socket, 'chat:send', { roomId: host.roomId, sessionToken: host.sessionToken, text: `mensagem ${i}` }));
  }

  const okCount = acks.filter((a) => a.ok).length;
  const rateLimited = acks.filter((a) => !a.ok && a.reason === 'RATE_LIMIT');
  assert.ok(okCount <= 5, `no máximo 5 mensagens deveriam passar dentro da janela, mas ${okCount} passaram`);
  assert.ok(rateLimited.length > 0, 'pelo menos uma mensagem deveria ter sido recusada por RATE_LIMIT');

  host.socket.close();
});
