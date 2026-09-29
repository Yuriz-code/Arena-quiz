'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTrustProxy, resolveClientIp } = require('../client-ip');

test('sem proxy confiável, X-Forwarded-For é ignorado (não forjável)', () => {
  assert.strictEqual(resolveClientIp('9.9.9.9', '1.2.3.4', 0), '9.9.9.9');
});

test('com 1 proxy, usa o último valor (o que o proxy anexou), não o primeiro', () => {
  // atacante manda "1.1.1.1"; o proxy acrescenta o IP real "8.8.8.8"
  assert.strictEqual(resolveClientIp('10.0.0.1', '1.1.1.1, 8.8.8.8', 1), '8.8.8.8');
});

test('com 2 proxies, usa o penúltimo', () => {
  assert.strictEqual(resolveClientIp('10.0.0.1', '6.6.6.6, 8.8.8.8, 10.0.0.2', 2), '8.8.8.8');
});

test('cabeçalho com menos entradas que proxies esperados → cai no endereço TCP', () => {
  assert.strictEqual(resolveClientIp('10.0.0.1', '8.8.8.8', 2), '10.0.0.1');
});

test('sem cabeçalho → endereço TCP', () => {
  assert.strictEqual(resolveClientIp('10.0.0.1', undefined, 1), '10.0.0.1');
});

test('parseTrustProxy: explícito, inválido e detecção do Render', () => {
  assert.strictEqual(parseTrustProxy('2', {}), 2);
  assert.strictEqual(parseTrustProxy('abc', {}), 0);
  assert.strictEqual(parseTrustProxy(undefined, {}), 0);
  assert.strictEqual(parseTrustProxy(undefined, { RENDER: 'true' }), 1);
  assert.strictEqual(parseTrustProxy('0', { RENDER: 'true' }), 0);
});
