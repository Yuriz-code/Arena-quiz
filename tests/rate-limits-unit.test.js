'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAttemptLimiter, createWindowLimiter } = require('../rate-limits');
const { hashPassword, verifyPassword, normalizeRecoveryCode, generateRecoveryCode, safeEqualStrings } = require('../passwords');

test('attempt limiter: bloqueia na N-ésima falha, libera depois do lockout, success zera', () => {
  const l = createAttemptLimiter({ maxFailures: 3, lockoutMs: 1000 });
  assert.equal(l.fail('ip', 0).locked, false);
  assert.equal(l.fail('ip', 1).locked, false);
  assert.equal(l.fail('ip', 2).locked, true);
  assert.ok(l.secondsLocked('ip', 500) > 0);
  assert.equal(l.secondsLocked('ip', 1002), 0);
  l.fail('outro', 0);
  l.success('outro');
  assert.equal(l.size, 1);
});

test('attempt limiter: sweep remove só entradas expiradas e antigas', () => {
  const l = createAttemptLimiter({ maxFailures: 2, lockoutMs: 1000, entryTtlMs: 5000 });
  l.fail('velho', 0);
  l.fail('novo', 9000);
  l.sweep(10_000);
  assert.equal(l.size, 1);
});

test('window limiter: respeita o teto na janela e volta a liberar', () => {
  const l = createWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(l.consume('ip', 0), true);
  assert.equal(l.consume('ip', 10), true);
  assert.equal(l.consume('ip', 20), false);
  assert.equal(l.consume('ip', 1100), true);
  l.sweep(5000);
  assert.equal(l.size, 0);
});

test('senha: hash verifica, senha errada e hash inválido falham', () => {
  const h = hashPassword('segredo123');
  assert.equal(verifyPassword('segredo123', h), true);
  assert.equal(verifyPassword('errada', h), false);
  assert.equal(verifyPassword('x', 'lixo'), false);
  assert.equal(verifyPassword('x', undefined), false);
});

test('código de recuperação: formato e normalização', () => {
  const c = generateRecoveryCode();
  assert.match(c, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(normalizeRecoveryCode(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
});

test('safeEqualStrings: iguais/diferentes, inclusive de tamanhos distintos', () => {
  assert.equal(safeEqualStrings('abc', 'abc'), true);
  assert.equal(safeEqualStrings('abc', 'abcd'), false);
  assert.equal(safeEqualStrings('', 'x'), false);
});
