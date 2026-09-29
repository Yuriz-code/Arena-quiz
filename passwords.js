'use strict';

/**
 * Senhas de conta e códigos de recuperação (extraído de server.js).
 *
 * Hash com scrypt (nativo do Node — nenhuma dependência nova). Formato salvo:
 * "<salt-hex>:<hash-hex>". Comparação sempre via timingSafeEqual.
 */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored || '').split(':');
  if (!salt || !hashHex) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false; // timingSafeEqual exige mesmo tamanho
  return crypto.timingSafeEqual(candidate, expected);
}

// Código de recuperação: 12 hex em 3 blocos de 4 (ex.: "A1B2-C3D4-E5F6").
// Mostrado uma única vez e guardado só como hash (mesmo esquema da senha).
function generateRecoveryCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 chars
  return raw.match(/.{1,4}/g).join('-');
}

// O hash é sempre sobre a forma NORMALIZADA (só os 12 hexadecimais): os
// hífens são só apresentação. Sem isso, digitar sem hífen seria recusado.
function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

/** Comparação de segredos em tempo constante (independe do tamanho das strings). */
function safeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { hashPassword, verifyPassword, generateRecoveryCode, normalizeRecoveryCode, safeEqualStrings };
