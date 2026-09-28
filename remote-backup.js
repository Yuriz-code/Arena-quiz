/**
 * Backup remoto num repositório PRIVADO do GitHub (API "Contents"), para hosts
 * de disco efêmero como o Render gratuito: o disco some a cada deploy/suspensão,
 * o repositório não. Usa só fetch (Node 22) e zlib — sem dependências.
 *
 * Variáveis de ambiente (tudo desligado se GITHUB_BACKUP_REPO/TOKEN faltarem):
 *   GITHUB_BACKUP_REPO    "dono/repositorio" (privado! guarda hashes de senha)
 *   GITHUB_BACKUP_TOKEN   token fine-grained com "Contents: Read and write" SÓ nesse repo
 *   GITHUB_BACKUP_BRANCH  padrão "main"
 *   GITHUB_BACKUP_PATH    padrão "quizarena.db.gz"
 *   GITHUB_API_URL        padrão "https://api.github.com" (usado nos testes)
 *
 * Cada envio é um commit que sobrescreve UM arquivo; o histórico do Git
 * guarda as versões anteriores (dá para voltar atrás se algo der errado).
 */

'use strict';

const zlib = require('zlib');

function getConfig(env = process.env) {
  const repo = (env.GITHUB_BACKUP_REPO || '').trim();
  const token = (env.GITHUB_BACKUP_TOKEN || '').trim();
  if (!repo || !token) return null;
  return {
    repo,
    token,
    branch: (env.GITHUB_BACKUP_BRANCH || 'main').trim(),
    path: (env.GITHUB_BACKUP_PATH || 'quizarena.db.gz').trim().replace(/^\/+/, ''),
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

function contentsUrl(cfg) {
  const p = cfg.path.split('/').map(encodeURIComponent).join('/');
  return `${cfg.apiUrl}/repos/${cfg.repo}/contents/${p}`;
}

function headers(cfg, accept) {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'quizarena-backup',
  };
}

async function fail(res, what) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch { /* sem corpo */ }
  const err = new Error(`GitHub (${what}): HTTP ${res.status} ${detail}`.trim());
  err.status = res.status;
  return err;
}

/** @returns {Promise<Buffer|null>} .db já descompactado, ou null se ainda não há backup remoto (404). */
async function download(cfg) {
  const res = await fetch(`${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg, 'application/vnd.github.raw+json'),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await fail(res, 'baixar backup');
  return zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
}

async function currentSha(cfg) {
  const res = await fetch(`${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: headers(cfg, 'application/vnd.github+json'),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw await fail(res, 'consultar backup');
  return (await res.json()).sha;
}

/** Envia (cria ou sobrescreve) o backup. `dbBuffer` é o .db cru; é gzipado aqui. */
async function upload(cfg, dbBuffer, message = 'backup automático') {
  const content = zlib.gzipSync(dbBuffer, { level: 9 }).toString('base64');
  for (let attempt = 1; ; attempt++) {
    const body = { message, content, branch: cfg.branch };
    const sha = await currentSha(cfg);
    if (sha) body.sha = sha;
    const res = await fetch(contentsUrl(cfg), {
      method: 'PUT',
      headers: { ...headers(cfg, 'application/vnd.github+json'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return true;
    // 409/422 = o arquivo mudou entre consultar o sha e gravar: tenta de novo uma vez.
    if ((res.status === 409 || res.status === 422) && attempt < 2) continue;
    throw await fail(res, 'enviar backup');
  }
}

module.exports = { getConfig, download, upload };
