'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server, baseUrl } = require('./_env');
const {
  connectClient, emitAck, waitForEvent, createRoom, joinRoom, registerAccount, playQuickGame, getBoard,
} = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

const DEV = (n) => `device-${n}-00000000`; // formato aceito: [a-zA-Z0-9-]{8,64}

async function twoPlayerGame(a, b) {
  const host = await createRoom(baseUrl(), a);
  const p2 = await joinRoom(baseUrl(), host.roomId, b);
  const over = await playQuickGame([host, p2]);
  host.socket.close();
  p2.socket.close();
  return over;
}

test('ranking por período e critério, com a posição de quem consulta', async () => {
  await twoPlayerGame(
    { nickname: 'Ana-R', deviceId: DEV('ana') },
    { nickname: 'Beto-R', deviceId: DEV('beto') },
  );
  const asker = await connectClient(baseUrl());

  for (const period of ['all', 'month', 'week']) {
    const res = await getBoard(asker, { period, metric: 'points', deviceId: DEV('ana') });
    assert.equal(res.ok, true);
    assert.equal(res.period, period);
    const names = res.rows.map((r) => r.nickname).sort();
    assert.deepEqual(names, ['Ana-R', 'Beto-R'], `período ${period}`);
    assert.equal(res.rows.filter((r) => r.isMe).length, 1);
    assert.equal(res.rows.find((r) => r.isMe).nickname, 'Ana-R');
    assert.equal(res.me.nickname, 'Ana-R');
  }

  // vitórias: quem ganhou aparece primeiro com wins = 1
  const wins = await getBoard(asker, { period: 'all', metric: 'wins', deviceId: null });
  assert.equal(wins.rows[0].wins, 1);
  assert.equal(wins.me, null, 'consulta sem identidade não tem "me"');

  // média/precisão exigem mínimo de partidas (5 no geral): com 1 partida ninguém entra
  const avg = await getBoard(asker, { period: 'all', metric: 'average', deviceId: DEV('ana') });
  assert.deepEqual(avg.rows, []);
  assert.equal(avg.minGames, 5);
  assert.equal(avg.meNeeded, 4);

  // parâmetros inválidos caem no padrão em vez de quebrar
  const bad = await getBoard(asker, { period: 'ontem', metric: 'xyz' });
  assert.equal(bad.ok, true);
  assert.equal(bad.period, 'all');
  assert.equal(bad.metric, 'points');

  // a chave interna (d:/u:) nunca vai para o cliente
  assert.ok(!JSON.stringify(wins).includes('device-'));
  asker.close();
});

test('token inválido ao criar/entrar em sala é recusado (AUTH_EXPIRED)', async () => {
  const s = await connectClient(baseUrl());
  const create = await emitAck(s, 'create_room', { nickname: 'X', avatar: '💀', deviceId: null, authToken: 'token-que-nao-existe' });
  assert.equal(create.ok, false);
  assert.equal(create.reason, 'AUTH_EXPIRED');
  const join = await emitAck(s, 'join_room', { roomId: 'ZZZZ', nickname: 'X', avatar: '💀', deviceId: null, authToken: 'token-que-nao-existe' });
  assert.equal(join.ok, false);
  assert.equal(join.reason, 'AUTH_EXPIRED');
  s.close();
});

test('conta: o nome vem da conta e o placar acompanha a pessoa entre aparelhos', async () => {
  const acc = await registerAccount(baseUrl(), 'conta_multi');

  // Aparelho 1 — cliente tenta usar outro nome; vale o da conta.
  const h1 = await createRoom(baseUrl(), { nickname: 'NomeFalso', deviceId: DEV('m1'), authToken: acc.authToken });
  const lobbyState = waitForEvent(h1.socket, 'lobby_state', 5000, (s) => s.players.length === 2);
  const o1 = await joinRoom(baseUrl(), h1.roomId, { nickname: 'Rival-M1', deviceId: DEV('r1') });
  const st = await lobbyState;
  assert.equal(st.players.find((p) => p.playerId === h1.playerId).nickname, 'conta_multi');
  await playQuickGame([h1, o1]);
  h1.socket.close(); o1.socket.close();

  // Aparelho 2 — mesma conta, outro deviceId.
  const h2 = await createRoom(baseUrl(), { nickname: 'Outro', deviceId: DEV('m2'), authToken: acc.authToken });
  const o2 = await joinRoom(baseUrl(), h2.roomId, { nickname: 'Rival-M2', deviceId: DEV('r2') });
  await playQuickGame([h2, o2]);
  h2.socket.close(); o2.socket.close();

  const asker = await connectClient(baseUrl());
  const res = await getBoard(asker, { period: 'all', metric: 'points', authToken: acc.authToken, deviceId: null });
  const mine = res.rows.filter((r) => r.nickname === 'conta_multi');
  assert.equal(mine.length, 1, 'uma linha só, mesmo com dois aparelhos');
  assert.equal(mine[0].games, 2);
  assert.equal(mine[0].isMe, true);

  // Mesmo recorte pelo log de 7 dias
  const week = await getBoard(asker, { period: 'week', metric: 'points', authToken: acc.authToken });
  assert.equal(week.rows.find((r) => r.nickname === 'conta_multi').games, 2);
  asker.close();
});

test('primeira partida logado leva o histórico de convidado do aparelho para a conta', async () => {
  const device = DEV('claim');

  // 1) como convidado
  await twoPlayerGame({ nickname: 'Convidado-C', deviceId: device }, { nickname: 'Rival-C1', deviceId: DEV('rc1') });

  // 2) cria conta e joga no mesmo aparelho
  const acc = await registerAccount(baseUrl(), 'conta_claim');
  await twoPlayerGame({ nickname: 'x', deviceId: device, authToken: acc.authToken }, { nickname: 'Rival-C2', deviceId: DEV('rc2') });

  const asker = await connectClient(baseUrl());
  const all = await getBoard(asker, { period: 'all', metric: 'points', authToken: acc.authToken, deviceId: device });
  assert.equal(all.rows.filter((r) => r.nickname === 'Convidado-C').length, 0, 'a linha de convidado deixa de existir');
  const mine = all.rows.find((r) => r.nickname === 'conta_claim');
  assert.equal(mine.games, 2, 'as 2 partidas (convidado + logado) somadas na conta');

  const week = await getBoard(asker, { period: 'week', metric: 'points', authToken: acc.authToken });
  assert.equal(week.rows.find((r) => r.nickname === 'conta_claim').games, 2, 'o log de 7 dias também foi reapontado');
  asker.close();
});

test('admin: limpar placar zera o geral E os rankings de 7/30 dias', async () => {
  const asker = await connectClient(baseUrl());
  const before = await getBoard(asker, { period: 'week', metric: 'points' });
  assert.ok(before.rows.length > 0, 'pré-condição: há dados');

  const denied = await emitAck(asker, 'admin:clear_leaderboard', { code: 'errado' });
  assert.equal(denied.ok, false);
  const ok = await emitAck(asker, 'admin:clear_leaderboard', { code: 'codigo-de-teste' });
  assert.equal(ok.ok, true);

  for (const period of ['all', 'month', 'week']) {
    const res = await getBoard(asker, { period, metric: 'points' });
    assert.deepEqual(res.rows, [], `período ${period} vazio depois de limpar`);
  }
  asker.close();
});
