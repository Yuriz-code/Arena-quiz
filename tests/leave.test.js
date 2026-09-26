'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, createRoom, joinRoom, connectClient } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('jogador que sai do lobby some da lista e recebe ack ok', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  // Ignora lobby_states anteriores (do join do Beto) que ainda possam estar a caminho.
  const afterLeave = waitForEvent(host.socket, 'lobby_state', 5000, (s) => s.players.length === 1);
  const ack = await emitAck(p2.socket, 'leave_room', { roomId: p2.roomId, sessionToken: p2.sessionToken });
  assert.equal(ack.ok, true);
  const state = await afterLeave;
  assert.deepEqual(state.players.map((p) => p.nickname), ['Ana']);

  host.socket.close();
  p2.socket.close();
});

test('quem sai voluntariamente NÃO recebe session_expired', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  let gotExpired = false;
  p2.socket.on('session_expired', () => { gotExpired = true; });
  await emitAck(p2.socket, 'leave_room', { roomId: p2.roomId, sessionToken: p2.sessionToken });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(gotExpired, false);

  host.socket.close();
  p2.socket.close();
});

test('host que sai repassa a liderança para quem ficou', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const newLeader = waitForEvent(p2.socket, 'lobby_state', 5000, (s) => s.players.length === 1);
  const ack = await emitAck(host.socket, 'leave_room', { roomId: host.roomId, sessionToken: host.sessionToken });
  assert.equal(ack.ok, true);
  const state = await newLeader;
  assert.equal(state.hostPlayerId, p2.playerId);

  host.socket.close();
  p2.socket.close();
});

test('último jogador saindo apaga a sala', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const roomId = host.roomId;

  const ack = await emitAck(host.socket, 'leave_room', { roomId, sessionToken: host.sessionToken });
  assert.equal(ack.ok, true);

  const outsider = await connectClient(url);
  const join = await emitAck(outsider, 'join_room', { roomId, nickname: 'Cris', avatar: '👻', deviceId: null });
  assert.equal(join.ok, false);
  assert.equal(join.reason, 'ROOM_NOT_FOUND');

  host.socket.close();
  outsider.close();
});

test('não dá pra sair pelo leave_room depois que a partida começou', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const started = waitForEvent(host.socket, 'question:start');
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });
  await started;

  const ack = await emitAck(p2.socket, 'leave_room', { roomId: p2.roomId, sessionToken: p2.sessionToken });
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'GAME_ALREADY_STARTED');

  host.socket.close();
  p2.socket.close();
});

test('leave_room com token de outro socket é ignorado (não expulsa ninguém)', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  // p2 tenta "sair" usando o token do host: não pode derrubar o host.
  await emitAck(p2.socket, 'leave_room', { roomId: host.roomId, sessionToken: host.sessionToken });

  const rejoin = await connectClient(url);
  const res = await emitAck(rejoin, 'rejoin_room', { roomId: host.roomId, sessionToken: host.sessionToken });
  assert.equal(res.ok, true, 'o host continua na sala');

  host.socket.close();
  p2.socket.close();
  rejoin.close();
});
