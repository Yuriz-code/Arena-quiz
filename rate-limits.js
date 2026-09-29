'use strict';

/**
 * Limitadores em memória por chave (normalmente o IP), extraídos de
 * server.js. Ambos têm sweep() para não crescer indefinidamente.
 */

/**
 * Bloqueio por tentativas erradas: após `maxFailures` falhas, bloqueia a chave
 * por `lockoutMs`. Uma ação bem-sucedida zera o histórico.
 */
function createAttemptLimiter({ maxFailures, lockoutMs, entryTtlMs = 60 * 60 * 1000 }) {
  /** @type {Map<string, {failCount:number, lockedUntil:number, updatedAt:number}>} */
  const entries = new Map();

  return {
    /** Segundos restantes de bloqueio (0 = liberado). */
    secondsLocked(key, now = Date.now()) {
      const e = entries.get(key);
      return e && now < e.lockedUntil ? Math.ceil((e.lockedUntil - now) / 1000) : 0;
    },
    /** Registra uma falha; devolve { locked } se ESTA falha disparou o bloqueio. */
    fail(key, now = Date.now()) {
      const e = entries.get(key) || { failCount: 0, lockedUntil: 0, updatedAt: now };
      e.failCount += 1;
      e.updatedAt = now;
      let locked = false;
      if (e.failCount >= maxFailures) {
        e.lockedUntil = now + lockoutMs;
        e.failCount = 0;
        locked = true;
      }
      entries.set(key, e);
      return { locked };
    },
    success(key) {
      entries.delete(key);
    },
    sweep(now = Date.now()) {
      for (const [key, e] of entries) {
        if (now >= e.lockedUntil && now - e.updatedAt > entryTtlMs) entries.delete(key);
      }
    },
    get size() { return entries.size; },
  };
}

/** Janela deslizante: no máximo `max` ações por chave dentro de `windowMs`. */
function createWindowLimiter({ windowMs, max }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  return {
    /** Tenta consumir uma ação; false se a chave estourou o limite. */
    consume(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    sweep(now = Date.now()) {
      for (const [key, ts] of hits) {
        const recent = ts.filter((t) => now - t < windowMs);
        if (recent.length === 0) hits.delete(key);
        else if (recent.length !== ts.length) hits.set(key, recent);
      }
    },
    get size() { return hits.size; },
  };
}

module.exports = { createAttemptLimiter, createWindowLimiter };
