'use strict';

// Precisa vir ANTES do require de _env/server (lido no boot).
process.env.CONNECTIONS_PER_IP_LIMIT = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { server, baseUrl } = require('./_env');
const { connectClient, emitAck } = require('./_client');

before(async () => { await server.ready; });
after(async () => { await server.shutdown(); });

test('cabeçalhos de segurança e CSP presentes; X-Powered-By ausente', async () => {
  const res = await fetch(`${baseUrl()}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});

test('X-Forwarded-For forjado NÃO contorna o limite de conexões por IP', async () => {
  const open = [];
  let rejected = 0;
  for (let i = 0; i < 6; i++) {
    const s = ioClient(baseUrl(), {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { 'x-forwarded-for': `203.0.113.${i + 1}` }, // "IP" diferente a cada conexão
    });
    s.on('connection_rejected', () => { rejected += 1; });
    await new Promise((r) => s.once('connect', r));
    await new Promise((r) => setTimeout(r, 60));
    open.push(s);
  }
  // Se o cabeçalho fosse confiado, nenhuma seria rejeitada. Limite = 3 → 3 rejeitadas.
  assert.equal(rejected, 3);
  open.forEach((s) => s.close());
});

test('payload malformado (null, string, número, array) não derruba o servidor', async () => {
  await new Promise((r) => setTimeout(r, 200)); // deixa os sockets do teste anterior liberarem o IP
  const s = await connectClient(baseUrl());
  for (const bad of [null, 'x', 42, [1, 2]]) {
    s.emit('submit_answer', bad);
    s.emit('create_room', bad, () => {});
    s.emit('host:start_game', bad);
  }
  s.emit('submit_answer'); // sem argumento: depende do `= {}` nos handlers
  const res = await emitAck(s, 'create_room', {});
  assert.equal(typeof res, 'object'); // servidor continua vivo e respondendo
  s.close();
});

test('manifest PWA e ícones são servidos com o tipo correto', async () => {
  const m = await fetch(`${baseUrl()}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type') || '', /manifest\+json|application\/json/);
  const json = await m.json();
  assert.equal(json.short_name, 'QuizArena');
  const icon = await fetch(`${baseUrl()}/icon-192.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
});
