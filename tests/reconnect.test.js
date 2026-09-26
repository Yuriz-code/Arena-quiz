'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, createRoom, joinRoom, connectClient } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('reconexão dentro do grace period: sessão retoma de onde parou', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  const disconnectedNoticePromise = waitForEvent(host.socket, 'player_disconnected');
  p2.socket.close();
  const notice = await disconnectedNoticePromise;
  assert.equal(notice.nickname, 'Beto');

  // Reconecta com um socket NOVO (como acontece de verdade ao recarregar a
  // página), usando o sessionToken guardado — é isso que sessionStorage faz
  // no cliente.
  const newSocket = await connectClient(url);
  const reconnectedNoticePromise = waitForEvent(host.socket, 'player_reconnected');
  const res = await emitAck(newSocket, 'rejoin_room', { sessionToken: p2.sessionToken, roomId: p2.roomId });

  assert.equal(res.ok, true);
  assert.equal(res.snapshot.phase, 'lobby');
  assert.equal(res.snapshot.playerId, p2.playerId);
  const notice2 = await reconnectedNoticePromise;
  assert.equal(notice2.nickname, 'Beto');

  host.socket.close();
  newSocket.close();
});

test('expiração do grace period: jogador some da sala permanentemente', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Carla' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Davi' });

  // A partir daqui ninguém reconecta — RECONNECT_GRACE_MS está reduzido
  // (ver tests/_env.js) só para este arquivo, então isso não demora ~45s.
  const removalLobbyState = waitForEvent(host.socket, 'lobby_state');
  p2.socket.close();
  await removalLobbyState; // primeiro broadcast: ainda mostra "disconnected"

  // Espera passar do grace period e chegar o próximo lobby_state (removido).
  let finalState = await waitForEvent(host.socket, 'lobby_state', 5000);
  // Pode levar mais de um broadcast dependendo do timing; garante que
  // eventualmente o jogador some da lista.
  let attempts = 0;
  while (finalState.players.some((p) => p.nickname === 'Davi') && attempts < 5) {
    finalState = await waitForEvent(host.socket, 'lobby_state', 5000);
    attempts += 1;
  }
  assert.ok(
    !finalState.players.some((p) => p.nickname === 'Davi'),
    'jogador deveria ter sido removido definitivamente após o grace period expirar'
  );

  // Sessão antiga não existe mais: reconectar com o token velho deve falhar.
  const staleSocket = await connectClient(url);
  const res = await emitAck(staleSocket, 'rejoin_room', { sessionToken: p2.sessionToken, roomId: p2.roomId });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'SESSION_NOT_FOUND');

  host.socket.close();
  staleSocket.close();
});
