'use strict';

const { io: ioClient } = require('socket.io-client');

/** Conecta um client novo e espera o handshake completar. */
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Emite um evento com ack e devolve uma Promise com a resposta do servidor. */
function emitAck(socket, event, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout esperando ack de "${event}"`)),
      timeoutMs
    );
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/**
 * Espera o próximo disparo de um evento (não-ack) nesse socket. Se passar um
 * `predicate`, ignora disparos que não satisfaçam a condição (útil quando o
 * servidor manda vários broadcasts seguidos, ex: lobby_state).
 */
function waitForEvent(socket, event, timeoutMs = 5000, predicate = null) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout esperando evento "${event}"`));
    }, timeoutMs);
    socket.on(event, handler);
  });
}

/** Pequena espera "de verdade" (ms), para casos onde é preciso deixar o tempo passar. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cria uma sala e devolve tudo que os outros testes normalmente precisam. */
async function createRoom(url, { nickname = 'Host', avatar = '💀', deviceId = null, authToken = null } = {}) {
  const socket = await connectClient(url);
  const res = await emitAck(socket, 'create_room', { nickname, avatar, deviceId, authToken });
  if (!res.ok) throw new Error(`create_room falhou: ${res.reason}`);
  return { socket, ...res };
}

/** Conecta e entra numa sala existente. */
async function joinRoom(url, roomId, { nickname = 'Jogador', avatar = '👻', deviceId = null, authToken = null } = {}) {
  const socket = await connectClient(url);
  const res = await emitAck(socket, 'join_room', { roomId, nickname, avatar, deviceId, authToken });
  if (!res.ok) throw new Error(`join_room falhou: ${res.reason}`);
  return { socket, ...res };
}

/** Cria uma conta de verdade (auth:register) e devolve { authToken, userId, username, avatar }. */
async function registerAccount(url, username, password = 'senha-de-teste') {
  const socket = await connectClient(url);
  const res = await emitAck(socket, 'auth:register', { username, password, avatar: '🦇' });
  socket.close();
  if (!res.ok) throw new Error(`auth:register falhou: ${res.reason}`);
  return res;
}

/**
 * Joga uma partida de 1 pergunta entre os jogadores dados (o 1º é o host) e
 * devolve o payload de game_over. Todos respondem a opção 0.
 * Requer MIN_TOTAL_QUESTIONS=1 (definido em _env.js).
 */
async function playQuickGame(players) {
  const [host, ...others] = players;
  host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: 1 });
  const gameOverPromise = waitForEvent(host.socket, 'game_over', 20000);
  const questionPromise = waitForEvent(host.socket, 'question:start');
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });
  const q = await questionPromise;
  for (const p of [host, ...others]) {
    p.socket.emit('submit_answer', { roomId: p.roomId, sessionToken: p.sessionToken, questionId: q.id, chosenIndex: 0 });
  }
  return gameOverPromise;
}

/** Pede um ranking ao servidor (evento leaderboard:get). */
function getBoard(socket, params) {
  return emitAck(socket, 'leaderboard:get', params);
}

module.exports = { connectClient, emitAck, waitForEvent, sleep, createRoom, joinRoom, registerAccount, playQuickGame, getBoard };
