'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { emitAck, waitForEvent, createRoom, joinRoom, connectClient } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('partida completa: lobby -> perguntas -> pódio, com placar coerente', async () => {
  const url = baseUrl();

  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });

  // Host configura uma partida curta para o teste ser rápido.
  const TOTAL_QUESTIONS = 3;
  host.socket.emit('host:set_total_questions', {
    roomId: host.roomId, sessionToken: host.sessionToken, total: TOTAL_QUESTIONS,
  });

  const gameOverPromise = waitForEvent(host.socket, 'game_over', 20000);
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });

  for (let i = 0; i < TOTAL_QUESTIONS; i++) {
    const q = await waitForEvent(host.socket, 'question:start');
    assert.equal(typeof q.id, 'string');
    assert.ok(Array.isArray(q.options) && q.options.length >= 2);
    assert.equal(q.correct_index, undefined, 'o índice correto NUNCA pode ir para o cliente antes do reveal');

    const revealPromise = waitForEvent(host.socket, 'question:reveal');
    // Ambos respondem imediatamente — dispara o reveal antecipado (não
    // precisa esperar o timer da rodada), o que também mantém o teste rápido.
    host.socket.emit('submit_answer', { roomId: host.roomId, sessionToken: host.sessionToken, questionId: q.id, chosenIndex: 0 });
    p2.socket.emit('submit_answer', { roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, chosenIndex: 0 });

    const reveal = await revealPromise;
    assert.equal(reveal.perPlayerResults.length, 2);
    assert.ok([0, 1, 2, 3].includes(reveal.correctIndex));
  }

  const gameOver = await gameOverPromise;
  assert.equal(gameOver.podium.length, 2, 'pódio deve ter os 2 jogadores');
  assert.equal(gameOver.podium[0].position, 1);
  assert.equal(gameOver.podium[1].position, 2);
  // Critério de desempate garante 1º >= 2º em pontuação (nunca empatam).
  assert.ok(gameOver.podium[0].totalScore >= gameOver.podium[1].totalScore);
  for (const entry of gameOver.podium) {
    assert.equal(entry.allTimeStats.gamesPlayed, 1, 'primeira partida de cada jogador: 1 jogo no histórico');
  }
  assert.ok(Array.isArray(gameOver.overallLeaderboard));

  host.socket.close();
  p2.socket.close();
});

test('placar geral persiste no SQLite entre partidas (mesmo deviceId)', async () => {
  const url = baseUrl();
  const deviceId = 'device-teste-persistencia-0001';

  // Primeira partida
  const host1 = await joinAsHostWithDevice(url, deviceId);
  await playQuickSoloGameAlone(host1);

  // Segunda partida, mesmo deviceId — o placar geral deve acumular, não resetar.
  const host2 = await joinAsHostWithDevice(url, deviceId);
  const gameOver = await playQuickSoloGameAlone(host2);

  const me = gameOver.overallLeaderboard.find((p) => p.nickname === 'Solo');
  assert.ok(me, 'jogador deveria aparecer no placar geral');
  assert.equal(me.gamesPlayed, 2, 'gamesPlayed deveria acumular entre partidas, não resetar');
});

async function joinAsHostWithDevice(url, deviceId) {
  const socket = await connectClient(url);
  const res = await emitAck(socket, 'create_room', { nickname: 'Solo', avatar: '👻', deviceId });
  if (!res.ok) throw new Error(`create_room falhou: ${res.reason}`);
  return { socket, ...res };
}

// Uma "sala solo" não bate MIN_PLAYERS_TO_START (2) via host:start_game
// normal, então aqui simplesmente reaproveita-se o mesmo host duas vezes com
// um segundo jogador avulso só para poder iniciar e terminar rápido.
async function playQuickSoloGameAlone(host) {
  const url = baseUrl();
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Comparsa' });

  host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: 1 });
  const gameOverPromise = waitForEvent(host.socket, 'game_over', 20000);
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });

  const q = await waitForEvent(host.socket, 'question:start');
  const revealPromise = waitForEvent(host.socket, 'question:reveal');
  host.socket.emit('submit_answer', { roomId: host.roomId, sessionToken: host.sessionToken, questionId: q.id, chosenIndex: 0 });
  p2.socket.emit('submit_answer', { roomId: p2.roomId, sessionToken: p2.sessionToken, questionId: q.id, chosenIndex: 0 });
  await revealPromise;

  const gameOver = await gameOverPromise;
  host.socket.close();
  p2.socket.close();
  return gameOver;
}
