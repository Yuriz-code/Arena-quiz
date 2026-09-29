'use strict';

// Antes do _env (que carrega o server): encurta a pausa de gabarito só neste arquivo.
process.env.REVEAL_PAUSE_MS = '100';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { waitForEvent, createRoom, joinRoom } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

// Regressão: "religiao" tem só ~6 perguntas difíceis. Uma partida de 30
// perguntas pede muito mais que isso (a curva reserva o último terço + todas
// as bônus para "dificil"). O servidor precisa relaxar a dificuldade em vez de
// travar, repetir pergunta ou encerrar a partida antes da hora.
test('partida de 30 perguntas em categoria com poucas difíceis: termina completa e sem repetir pergunta', async () => {
  const url = baseUrl();
  const host = await createRoom(url, { nickname: 'Ana' });
  const p2 = await joinRoom(url, host.roomId, { nickname: 'Beto' });
  const p3 = await joinRoom(url, host.roomId, { nickname: 'Cris' });

  const TOTAL = 30;
  host.socket.emit('host:set_categories', { roomId: host.roomId, sessionToken: host.sessionToken, categoryIds: ['religiao'] });
  host.socket.emit('host:set_total_questions', { roomId: host.roomId, sessionToken: host.sessionToken, total: TOTAL });

  const gameOverPromise = waitForEvent(host.socket, 'game_over', 60000);
  host.socket.emit('host:start_game', { roomId: host.roomId, sessionToken: host.sessionToken });

  const seen = new Set();
  const bonusNumbers = [];
  for (let i = 1; i <= TOTAL; i++) {
    const q = await waitForEvent(host.socket, 'question:start', 8000);
    assert.equal(q.questionNumber, i, 'numeração das perguntas deve ser sequencial');
    assert.equal(q.totalQuestions, TOTAL);
    assert.equal(q.category, 'religiao');
    assert.ok(!seen.has(q.id), `pergunta repetida na mesma partida: ${q.id}`);
    seen.add(q.id);
    assert.equal(q.isBonus, i % 5 === 0, `pergunta ${i}: flag de bônus incorreta`);
    if (q.isBonus) bonusNumbers.push(i);

    const revealPromise = waitForEvent(host.socket, 'question:reveal', 8000);
    for (const p of [host, p2, p3]) {
      p.socket.emit('submit_answer', { roomId: p.roomId, sessionToken: p.sessionToken, questionId: q.id, chosenIndex: 0 });
    }
    await revealPromise;
  }

  const gameOver = await gameOverPromise;
  assert.equal(seen.size, TOTAL, 'todas as 30 perguntas devem ter saído');
  assert.deepEqual(bonusNumbers, [5, 10, 15, 20, 25, 30]);
  assert.equal(gameOver.podium.length, 3);

  for (const p of [host, p2, p3]) p.socket.close();
});
