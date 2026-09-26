'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, sleep, createRoom, joinRoom } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('host consegue expulsar um jogador', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Host' });
  const target = await joinRoom(url, host.roomId, { nickname: 'Alvo' });

  const kickedPromise = waitForEvent(target.socket, 'you_were_kicked');
  host.socket.emit('host:kick_player', { roomId: host.roomId, sessionToken: host.sessionToken, targetPlayerId: target.playerId });
  await kickedPromise; // não precisa de assert.: se não chegasse, o waitForEvent estouraria o timeout

  // A sessão do expulso não vale mais.
  const newSocket = await require('./_client').connectClient(url);
  const res = await emitAck(newSocket, 'rejoin_room', { sessionToken: target.sessionToken, roomId: target.roomId });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'SESSION_NOT_FOUND');

  host.socket.close();
  newSocket.close();
});

test('host consegue banir um jogador, e o IP dele fica bloqueado de reentrar', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Host' });
  const target = await joinRoom(url, host.roomId, { nickname: 'Alvo' });

  const bannedPromise = waitForEvent(target.socket, 'you_were_banned');
  host.socket.emit('host:ban_player', { roomId: host.roomId, sessionToken: host.sessionToken, targetPlayerId: target.playerId });
  await bannedPromise;

  // Testes rodam todos a partir do mesmo IP (127.0.0.1), então uma nova
  // tentativa de entrar na mesma sala — mesmo com um jogador "diferente" —
  // deve ser barrada pelo banimento por IP.
  const { connectClient } = require('./_client');
  const retrySocket = await connectClient(url);
  const res = await emitAck(retrySocket, 'join_room', { roomId: host.roomId, nickname: 'Outro Nome', avatar: '💀', deviceId: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'BANNED');

  host.socket.close();
  retrySocket.close();
});

test('jogador comum não consegue expulsar ninguém (só o host pode)', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Host' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });
  const p3 = await joinRoom(url, host.roomId, { nickname: 'Carla' });

  // p2 (não-host) tenta expulsar p3 usando o PRÓPRIO sessionToken —
  // requireHost deve recusar porque esse token não é o do host da sala.
  p2.socket.emit('host:kick_player', { roomId: host.roomId, sessionToken: p2.sessionToken, targetPlayerId: p3.playerId });

  await sleep(300); // dá tempo do servidor processar (ou ignorar) o evento
  const state = await new Promise((resolve) => {
    host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: 5 });
    host.socket.once('lobby_state', resolve);
  });
  assert.ok(state.players.some((p) => p.nickname === 'Carla'), 'Carla não deveria ter sido removida por um não-host');

  host.socket.close();
  p2.socket.close();
  p3.socket.close();
});

test('host consegue transferir a liderança', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Host' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  // Ignora lobby_states antigos (do join do Beto) que ainda podem estar a caminho.
  const lobbyStatePromise = waitForEvent(host.socket, 'lobby_state', 5000, (s) => s.hostPlayerId === p2.playerId);
  host.socket.emit('host:transfer_leadership', { roomId: host.roomId, sessionToken: host.sessionToken, targetPlayerId: p2.playerId });
  const state = await lobbyStatePromise;
  assert.equal(state.hostPlayerId, p2.playerId);

  host.socket.close();
  p2.socket.close();
});
