'use strict';

/**
 * Resolução do IP real do cliente atrás de proxies reversos.
 *
 * Problema anterior: o servidor lia o PRIMEIRO valor de `X-Forwarded-For`
 * incondicionalmente. Esse valor é controlado pelo cliente (basta enviar o
 * cabeçalho), então dava para trocar de "IP" a cada conexão e burlar bloqueio
 * de login/admin, limites por IP e banimento por IP.
 *
 * Regra correta: confiar somente nos N proxies que VOCÊ opera. Cada proxy
 * acrescenta ao FIM da lista o IP de quem conectou nele; logo o IP do cliente
 * é o N-ésimo a partir do fim. Tudo à esquerda disso é forjável e ignorado.
 *
 *   TRUST_PROXY=0  → ignora X-Forwarded-For (padrão; servidor exposto direto)
 *   TRUST_PROXY=1  → um proxy na frente (Render, Railway, Fly, Nginx simples)
 */

function parseTrustProxy(value, env = process.env) {
  if (value !== undefined && value !== '') {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
    console.warn(`⚠️  TRUST_PROXY inválido ("${value}") — usando 0 (X-Forwarded-For ignorado).`);
    return 0;
  }
  // Render sempre coloca exatamente um proxy na frente e define RENDER=true.
  if (env.RENDER) return 1;
  return 0;
}

/**
 * @param {string|undefined} remoteAddress endereço TCP da conexão (não forjável)
 * @param {string|string[]|undefined} xffHeader cabeçalho X-Forwarded-For bruto
 * @param {number} hops quantos proxies confiáveis existem na frente
 */
function resolveClientIp(remoteAddress, xffHeader, hops) {
  if (!hops || hops < 1 || !xffHeader) return remoteAddress;
  const raw = Array.isArray(xffHeader) ? xffHeader.join(',') : String(xffHeader);
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const idx = parts.length - hops;
  // Menos entradas que proxies esperados: cabeçalho inconsistente → não confia.
  if (idx < 0) return remoteAddress;
  return parts[idx] || remoteAddress;
}

module.exports = { parseTrustProxy, resolveClientIp };
