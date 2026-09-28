'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, createRoom, joinRoom } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

/** Joga uma partida de 1 pergunta até o pódio. */
async function playToPodium(host, p2) {
  host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: 1 });
  const gameOver = waitForEvent(host.socket, 'game_over', 20000);
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });
  const q = await waitForEvent(host.socket, 'question:start');
  const reveal = waitForEvent(host.socket, 'question:reveal');
  host.socket.emit('submit_answer', { roomId: host.roomId, sessionToken: host.sessionToken, questionId: q.id, chosenIndex: 0 });
  p2.socket.emit('submit_answer', { roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, chosenIndex: 0 });
  await reveal;
  return gameOver;
}

test('revanche: host devolve a mesma sala ao lobby com os mesmos jogadores e placar zerado', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });
  await playToPodium(host, p2);

  const lobbyForGuest = waitForEvent(p2.socket, 'lobby_state', 5000, (s) => s.phase === 'lobby');
  const res = await emitAck(host.socket, 'host:rematch', { roomId: host.roomId, sessionToken: host.sessionToken });
  assert.equal(res.ok, true);

  const lobby = await lobbyForGuest;
  assert.equal(lobby.roomId, host.roomId, 'mesmo código de sala');
  assert.equal(lobby.players.length, 2, 'mesmos jogadores');
  assert.deepEqual(lobby.players.map((p) => p.score), [0, 0], 'placar zerado');
  assert.equal(lobby.settings.totalQuestions, 1, 'configurações preservadas');

  // Uma nova partida começa normalmente a partir do lobby recriado.
  const q = waitForEvent(host.socket, 'question:start');
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });
  assert.equal((await q).questionNumber, 1);

  host.socket.close();
  p2.socket.close();
});

test('revanche: só o host pode, e só depois do fim da partida', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  // Ainda no lobby: não é fim de jogo.
  const early = await emitAck(host.socket, 'host:rematch', { roomId: host.roomId, sessionToken: host.sessionToken });
  assert.deepEqual([early.ok, early.reason], [false, 'GAME_NOT_OVER']);

  await playToPodium(host, p2);

  const guest = await emitAck(p2.socket, 'host:rematch', { roomId: p2.roomId, sessionToken: p2.sessionToken });
  assert.deepEqual([guest.ok, guest.reason], [false, 'NOT_HOST']);

  host.socket.close();
  p2.socket.close();
});
