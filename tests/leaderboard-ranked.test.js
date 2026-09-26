'use strict';

// Regra anti-farm: partida que começa com menos de 3 jogadores vale para o
// placar PESSOAL, mas não para o ranking. Precisa definir a variável ANTES de
// carregar _env/server (cada arquivo de teste roda em processo próprio).
process.env.MIN_RANKED_PLAYERS = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const { connectClient, createRoom, joinRoom, playQuickGame, getBoard } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('partida de 2 jogadores não entra no ranking, mas conta no placar pessoal', async () => {
  const host = await createRoom(baseUrl(), { nickname: 'Dupla-A', deviceId: 'device-dupla-a-0000' });
  const p2 = await joinRoom(baseUrl(), host.roomId, { nickname: 'Dupla-B', deviceId: 'device-dupla-b-0000' });
  const over = await playQuickGame([host, p2]);

  assert.equal(over.rankedGame, false);
  assert.equal(over.minRankedPlayers, 3);
  const mine = over.podium.find((p) => p.playerId === host.playerId);
  assert.equal(mine.allTimeStats.gamesPlayed, 1, 'placar pessoal contou');
  host.socket.close(); p2.socket.close();

  const asker = await connectClient(baseUrl());
  for (const period of ['all', 'month', 'week']) {
    const res = await getBoard(asker, { period, metric: 'points', deviceId: 'device-dupla-a-0000' });
    assert.deepEqual(res.rows, [], `período ${period}: partida de 2 não vale para o ranking`);
  }
  asker.close();
});

test('partida com 3 jogadores vale para o ranking', async () => {
  const host = await createRoom(baseUrl(), { nickname: 'Trio-A', deviceId: 'device-trio-a-00000' });
  const p2 = await joinRoom(baseUrl(), host.roomId, { nickname: 'Trio-B', deviceId: 'device-trio-b-00000' });
  const p3 = await joinRoom(baseUrl(), host.roomId, { nickname: 'Trio-C', deviceId: 'device-trio-c-00000' });
  const over = await playQuickGame([host, p2, p3]);
  assert.equal(over.rankedGame, true);
  host.socket.close(); p2.socket.close(); p3.socket.close();

  const asker = await connectClient(baseUrl());
  const all = await getBoard(asker, { period: 'all', metric: 'points', deviceId: 'device-trio-a-00000' });
  assert.deepEqual(all.rows.map((r) => r.nickname).sort(), ['Trio-A', 'Trio-B', 'Trio-C']);
  const week = await getBoard(asker, { period: 'week', metric: 'wins' });
  assert.equal(week.rows.length, 3);
  assert.equal(week.rows[0].wins, 1);
  asker.close();
});
