/**
 * QuizArena — servidor autoritativo
 * Implementa a especificação: WebSocket centralizado, sessionToken persistente,
 * reconexão com grace period, pontuação anti-empate calculada 100% no servidor,
 * e controles de host (tempo por rodada, categorias, kick/ban, transferir liderança).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { revealsAnswer } = require('./chat-guard');
const db = require('./db'); // placar geral, histórico anti-repetição e log de partidas (SQLite)
const { buildBoard, METRICS, PERIODS } = require('./leaderboard'); // ordenação/posição dos rankings

// ----------------------------------------------------------------------------
// Configuração
// ----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const QUESTIONS_DIR = path.join(__dirname, 'data', 'questions'); // banco de perguntas: parte do código, não dado de usuário

// ----------------------------------------------------------------------------
// Limites anti-abuso. Todos configuráveis por variável de ambiente para dar
// margem sem precisar editar código, mas com um padrão seguro para hospedagem
// pública gratuita (onde um único processo atende todo mundo).
// ----------------------------------------------------------------------------

// Tamanho máximo de qualquer pacote recebido por um socket. O maior payload
// legítimo é uma mensagem de chat (200 caracteres) ou a lista de categorias
// do host — nada disso chega perto de 1 KB. O padrão do Socket.IO é 1 MB;
// aqui cai para 8 KB, o suficiente para qualquer evento real com folga, mas
// não para uma tentativa de encher a memória do processo com poucos pacotes.
const MAX_HTTP_BUFFER_SIZE = Number(process.env.MAX_PACKET_BYTES) || 8 * 1024;

// Teto global de salas simultâneas em memória. Sem isso, um script que só
// chama create_room em loop consegue esgotar a memória do processo.
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;

// Teto de salas que um mesmo IP pode manter abertas (como host) ao mesmo
// tempo. Uma casa/escritório atrás do mesmo IP pode legitimamente ter mais
// de uma sala ao mesmo tempo, por isso o valor é mais folgado que "1".
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP) || 5;

// Limite de criação de salas por IP numa janela de tempo — pega o caso de um
// script que cria e abandona salas rapidamente (o que passaria pelos dois
// limites acima, já que cada sala some da conta antes da próxima ser criada).
const ROOM_CREATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const ROOM_CREATE_MAX_PER_WINDOW = Number(process.env.ROOM_CREATE_MAX_PER_WINDOW) || 20;

// Limite de conexões (sockets) simultâneas por IP. Um jogo real usa 1 conexão
// por jogador; o valor é generoso o bastante para várias pessoas atrás do
// mesmo NAT/Wi-Fi jogando em salas diferentes ao mesmo tempo.
const CONNECTIONS_PER_IP_LIMIT = Number(process.env.CONNECTIONS_PER_IP_LIMIT) || 40;

// Sala "ociosa" (sem nenhuma atividade — entrar, sair, responder, conversar,
// avançar de pergunta etc.) por mais tempo que isso é removida da memória
// numa varredura periódica. É uma rede de segurança: casos normais (grace
// period de reconexão, jogador pensando numa resposta) ficam muito abaixo
// deste valor; isto pega salas esquecidas/abandonadas e falhas inesperadas.
const ROOM_IDLE_TIMEOUT_MS = Number(process.env.ROOM_IDLE_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min
const ROOM_SWEEP_INTERVAL_MS = 60 * 1000; // varre a cada 1 min

// Origens permitidas para conectar no Socket.IO. Por padrão o próprio
// servidor já serve o frontend estático (mesma origem, não precisa de CORS
// nenhum) — mas se um dia o frontend for hospedado num domínio separado do
// backend, '*' vira uma porta aberta pra qualquer site abrir conexões contra
// a sua instância. CORS_ORIGIN aceita uma ou mais origens (separadas por
// vírgula, ex.: "https://meuapp.com,https://www.meuapp.com"). Sem a
// variável definida, mantém o padrão aberto (mesmo comportamento de antes)
// para não quebrar quem já estava rodando frontend e backend separados sem
// configurar nada — mas avisa no boot, porque isso deveria ser explícito.
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : '*';
if (CORS_ORIGIN === '*') {
  console.warn(
    '⚠️  CORS_ORIGIN não definido — o Socket.IO está aceitando conexões de QUALQUER origem. ' +
    'Se o frontend for servido por este mesmo processo (padrão local/Docker), pode ignorar. ' +
    'Se o frontend rodar num domínio separado, defina CORS_ORIGIN com a(s) origem(ns) permitida(s).'
  );
}

// Motivos fechados pro botão "reportar pergunta" — evita texto livre (que
// exigiria moderação própria) mantendo o relato útil pra quem revisar depois.
const QUESTION_REPORT_REASONS = ['resposta_errada', 'pergunta_ambigua', 'erro_digitacao', 'desatualizada', 'outro'];

// Código secreto exigido para limpar o placar geral. Defina a variável de
// ambiente ADMIN_CLEAR_CODE antes de rodar o servidor (ex: no terminal:
// ADMIN_CLEAR_CODE=minhaSenhaForte node server.js). SEM essa variável, o
// recurso fica DESATIVADO — nunca caímos para um valor padrão, porque
// qualquer padrão embutido no código-fonte é, na prática, uma senha pública.
const ADMIN_CLEAR_CODE = process.env.ADMIN_CLEAR_CODE || null;
if (!ADMIN_CLEAR_CODE) {
  console.warn(
    '⚠️  ADMIN_CLEAR_CODE não definido — o recurso de limpar o placar geral está DESATIVADO. ' +
    'Defina a variável de ambiente ADMIN_CLEAR_CODE para habilitá-lo.'
  );
}
const ALL_CATEGORIES = [
  'historia', 'geografia', 'cinema', 'artes', 'musica', 'esportes',
  // "religiao" voltou a ser uma categoria única (era 4 subtemas —
  // Cristianismo/Judaísmo/Islamismo/Outras Religiões — consolidados de
  // volta a pedido; ver scripts/question-schema.js para a fonte única
  // desta lista, compartilhada com generate-questions.js).
  'religiao',
  'animes', 'desenhos', 'ciencia', 'tecnologia', 'literatura',
];
// Conta de login (username+senha) — separada da sala. Regras simples de
// propósito: é um quiz casual, não precisa de política de senha complexa.
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72; // scrypt não tem limite prático; isso só barra payloads absurdos
// Apelido de sala tinha limite de 16 (ver sanitizeNickname) enquanto o
// cadastro aceitava até 20 (USERNAME_REGEX): quem escolhia um nome de 17-20
// aparecia truncado dentro da sala. Alinhado num único limite.
const MAX_NICKNAME_LENGTH = 20;
// Código de recuperação de senha: 12 caracteres hex (base16) em 3 blocos de
// 4 (ex.: "A1B2-C3D4-E5F6"), fácil de anotar à mão. Mostrado uma única vez
// (cadastro, ou de novo a cada "esqueci a senha" bem-sucedido) e guardado só
// como hash (mesmo esquema scrypt da senha, ver hashPassword/verifyPassword).
function generateRecoveryCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 chars
  return raw.match(/.{1,4}/g).join('-');
}

// O hash é sempre sobre a forma NORMALIZADA (só os 12 hexadecimais, sem
// hífen/espaço/caixa) — os hífens em "A1B2-C3D4-E5F6" são só apresentação
// pra facilitar anotar à mão. Sem isso, alguém que digitasse o código sem os
// hífens (ou com espaço no lugar) seria recusado mesmo acertando o código,
// porque o hash foi calculado sobre bytes diferentes.
function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}
// Sessões de login inativas há mais que isso são apagadas por uma limpeza
// periódica (ver setInterval mais abaixo) — não afeta quem usa a conta com
// regularidade; só reduz tokens esquecidos em aparelhos já não usados.
const AUTH_TOKEN_MAX_AGE_MS = Number(process.env.AUTH_TOKEN_MAX_AGE_DAYS || 90) * 24 * 60 * 60 * 1000;

const VALID_ROUND_TIMES_SECONDS = [10, 15, 20, 30];
const DEFAULT_ROUND_TIME_SECONDS = 15;
const DEFAULT_TOTAL_QUESTIONS = 10;
// Mínimo aceito em host:set_total_questions. Em produção fica 3; os testes
// automatizados baixam para 1 (ver tests/_env.js) para partidas rápidas.
const MIN_TOTAL_QUESTIONS = Number(process.env.MIN_TOTAL_QUESTIONS) || 3;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 45_000;
const MIN_PLAYERS_TO_START = 2;
// Partidas que começam com menos jogadores que isso continuam valendo para o
// placar PESSOAL, mas não contam para o ranking (evita "farmar" pontos e
// vitórias jogando sozinho contra uma segunda aba). Os testes usam 2.
const MIN_RANKED_PLAYERS = Number(process.env.MIN_RANKED_PLAYERS) || 3;
// Mínimo de partidas para aparecer nos rankings de média e de precisão
// (senão uma única partida boa já lideraria). Por período; LEADERBOARD_MIN_GAMES
// força um valor único (útil em testes).
const MIN_GAMES_FOR_RATES = { all: 5, month: 3, week: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_WINDOW_MS = { month: 30 * DAY_MS, week: 7 * DAY_MS }; // janelas móveis: "últimos 30/7 dias"
const LEADERBOARD_TOP_N = 10;
const MAX_PLAYERS_PER_ROOM = 8;

// Chat da sala
const CHAT_MAX_LENGTH = 200;        // caracteres por mensagem
const CHAT_HISTORY_LIMIT = 50;      // mensagens guardadas por sala (enviadas a quem entra/reconecta)
const CHAT_RATE_WINDOW_MS = 10_000; // janela do limite de envio
const CHAT_RATE_MAX = 5;            // máximo de mensagens por jogador dentro da janela
const REVEAL_PAUSE_MS = 4_000; // tempo mostrando o gabarito antes da próxima pergunta

const BASE_POINTS = { facil: 100, medio: 200, dificil: 300 };
// A sala espera esse tanto A MAIS que roundTimeMs antes de revelar (dá tempo
// de pacotes que já saíram do jogador, mas ainda estão na rede, chegarem) —
// ver o setTimeout do questionTimer em nextQuestion(). calculateScore usa
// EXATAMENTE o mesmo valor pra decidir se aceita a resposta; do contrário,
// uma resposta que o servidor deliberadamente esperou (e recebeu) seria
// pontuada como errada só por ter chegado nesses últimos milissegundos —
// penalizando sobretudo quem tem conexão mais lenta, de forma arbitrária.
const ANSWER_NETWORK_GRACE_MS = 300;

// ----------------------------------------------------------------------------
// Sequência de acertos e power-ups. A cada STREAK_MILESTONE acertos SEGUIDOS,
// o jogador ganha 1 carga de um power-up (alternando o tipo a cada marco).
// Tudo calculado e validado no servidor (igual à pontuação) — o cliente só
// pede pra usar um power-up que já tem; nunca decide o efeito sozinho.
// ----------------------------------------------------------------------------
const STREAK_MILESTONE = 3;
const POWERUP_TYPES = ['fiftyFifty', 'doublePoints'];

function freshPowerups() {
  return { fiftyFifty: 0, doublePoints: 0 };
}

/**
 * Marco de sequência atingido? Alterna o tipo concedido a cada marco (3 =
 * 50/50, 6 = pontos em dobro, 9 = 50/50, ...) pra dar variedade sem sortear
 * (sorteio tornaria os testes automatizados não-determinísticos à toa).
 * @returns {string|null} o tipo concedido, ou null se não bateu marco agora
 */
function grantStreakPowerupIfMilestone(player) {
  if (player.currentStreak <= 0 || player.currentStreak % STREAK_MILESTONE !== 0) return null;
  const milestoneIndex = player.currentStreak / STREAK_MILESTONE;
  const type = milestoneIndex % 2 === 1 ? 'fiftyFifty' : 'doublePoints';
  player.powerups[type] += 1;
  return type;
}

// ----------------------------------------------------------------------------
// Carregamento (lazy) do banco de perguntas por categoria
// ----------------------------------------------------------------------------

const questionCache = new Map();

function loadCategory(category) {
  if (questionCache.has(category)) return questionCache.get(category);
  const filePath = path.join(QUESTIONS_DIR, `${category}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  questionCache.set(category, parsed);
  return parsed;
}

// ----------------------------------------------------------------------------
// Histórico persistente de perguntas usadas (sobrevive a novas partidas e a
// reinícios do servidor), e placar pessoal/geral — ambos guardados em SQLite
// via db.js (ver esse arquivo para detalhes de esquema e da migração
// automática dos antigos data/*.json). O histórico evita repetir uma
// pergunta que já caiu recentemente mesmo quando o host inicia um jogo novo
// na mesma sala, ou quando o servidor é reiniciado. O jogador do placar é
// identificado preferencialmente pelo deviceId persistido no navegador (ver
// statsKeyFor), com fallback para o nickname normalizado quando o cliente
// não envia deviceId.
// ----------------------------------------------------------------------------

/**
 * Gravador "debounced": marca os dados como sujos e grava no máximo 1x a
 * cada `intervalMs`, fora do caminho crítico de qualquer request. Mesmo o
 * SQLite sendo rápido, isso evita uma transação de escrita a cada
 * pergunta/resposta quando várias salas estão ativas ao mesmo tempo.
 */
function createDebouncedFlusher(flushFn, label, intervalMs = 5000) {
  let dirty = false;
  const timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      flushFn();
    } catch (err) {
      console.error(`Falha ao salvar ${label}:`, err.message);
    }
  }, intervalMs);
  timer.unref(); // não impede o processo de encerrar (ex: em testes)

  return {
    markDirty: () => { dirty = true; },
    flushSync: () => {
      try { flushFn(); }
      catch (err) { console.error(`Falha ao salvar ${label} no encerramento:`, err.message); }
    },
  };
}

/** @type {Record<string, string[]>} category -> lista de ids usados recentemente */
const persistentHistory = db.loadQuestionHistory();
const historyWriter = createDebouncedFlusher(
  () => db.saveQuestionHistoryBatch(persistentHistory),
  'histórico de perguntas'
);

/** @type {Record<string, {nickname:string, avatar:string, gamesPlayed:number, wins:number, correctAnswers:number, wrongAnswers:number, totalScore:number}>} */
const playerStats = db.loadAllPlayerStats();
const playerStatsWriter = createDebouncedFlusher(
  () => db.upsertPlayerStatsBatch(playerStats),
  'placar geral'
);

const DEVICE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Chave do placar. Ordem de preferência:
 *  - `u:<id>`: conta logada — o placar acompanha a PESSOA em qualquer aparelho;
 *  - `d:<deviceId>`: UUID persistido no localStorage do navegador (convidado);
 *  - `n:<nickname>`: último recurso (localStorage bloqueado).
 * Devolve null se não há nenhuma pista de identidade (consulta anônima).
 */
function statsKeyFor({ userId, deviceId, nickname }) {
  if (userId) return `u:${userId}`;
  if (deviceId && typeof deviceId === 'string') return `d:${deviceId}`;
  if (nickname) return `n:${String(nickname).trim().toLowerCase()}`;
  return null;
}

/** Chave do placar de um jogador que está (ou esteve) numa sala. */
function statsKeyForPlayer(player) {
  return statsKeyFor({ userId: player.userId, deviceId: player.deviceId, nickname: player.nickname });
}

/**
 * Chave de quem CONSULTA um placar (sem estar numa sala): conta se o token for
 * válido, senão o aparelho. Nunca vai para o cliente — só serve para marcar
 * "esta linha é você" e calcular a sua posição.
 */
function statsKeyForRequester({ authToken, deviceId }) {
  const user = authToken ? db.peekUserByToken(String(authToken)) : null;
  const dev = typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId) ? deviceId : null;
  return statsKeyFor({ userId: user ? user.id : null, deviceId: dev, nickname: null });
}

/**
 * Primeira partida de uma conta: se este aparelho já tinha placar como
 * convidado e a conta ainda não tem nenhum, o histórico do aparelho passa
 * para a conta (uma vez só) — quem cria conta não começa do zero. Limitação
 * conhecida: num aparelho compartilhado, a primeira conta a jogar leva o
 * histórico do aparelho.
 */
function claimDeviceStatsForAccount(player, accountKey) {
  if (!player.userId || !player.deviceId || playerStats[accountKey]) return;
  const deviceKey = `d:${player.deviceId}`;
  const legacy = playerStats[deviceKey];
  if (!legacy) return;
  playerStats[accountKey] = legacy;
  delete playerStats[deviceKey];
  try {
    db.movePlayerStats(deviceKey, accountKey, legacy); // grava na hora (não espera o debounce) para não haver janela sem o dado
  } catch (err) {
    console.error('Falha ao vincular placar do aparelho à conta:', err.message);
  }
}

/**
 * Atualiza o histórico persistente de um jogador ao fim de uma partida.
 * `isWinner` marca quem terminou em 1º lugar naquela partida (ver endGame).
 * `isRankedGame` diz se a partida vale para o ranking (jogadores suficientes);
 * o placar pessoal (campos sem prefixo "ranked") conta sempre.
 * @returns {object} o registro acumulado de todos os tempos
 */
function recordGameStatsForPlayer(player, isWinner, isRankedGame = true) {
  const key = statsKeyForPlayer(player);
  claimDeviceStatsForAccount(player, key);
  const entry = playerStats[key] || (playerStats[key] = {
    nickname: player.nickname,
    avatar: player.avatar,
    gamesPlayed: 0,
    wins: 0,
    correctAnswers: 0,
    wrongAnswers: 0,
    totalScore: 0,
    rankedGames: 0,
    rankedWins: 0,
    rankedCorrect: 0,
    rankedWrong: 0,
    rankedScore: 0,
  });
  if (typeof entry.wins !== 'number') entry.wins = 0;
  // Entrada carregada de um placar antigo (sem os campos de ranking): tudo o
  // que já havia conta para o ranking.
  if (typeof entry.rankedGames !== 'number') {
    entry.rankedGames = entry.gamesPlayed;
    entry.rankedWins = entry.wins;
    entry.rankedCorrect = entry.correctAnswers;
    entry.rankedWrong = entry.wrongAnswers;
    entry.rankedScore = entry.totalScore;
  }

  entry.nickname = player.nickname; // mantém o nome/avatar mais recentes usados por esse jogador
  entry.avatar = player.avatar;
  entry.gamesPlayed += 1;
  if (isWinner) entry.wins += 1;
  entry.correctAnswers += player.correctCount;
  entry.wrongAnswers += player.wrongCount;
  entry.totalScore += player.score;

  if (isRankedGame) {
    entry.rankedGames += 1;
    if (isWinner) entry.rankedWins += 1;
    entry.rankedCorrect += player.correctCount;
    entry.rankedWrong += player.wrongCount;
    entry.rankedScore += player.score;
  }

  return entry;
}

/** Linhas do ranking "de todos os tempos" (só partidas que valem para o ranking). */
function allTimeRows() {
  return Object.entries(playerStats)
    .filter(([, e]) => (e.rankedGames ?? e.gamesPlayed) > 0)
    .map(([key, e]) => ({
      key,
      nickname: e.nickname,
      avatar: e.avatar,
      games: e.rankedGames ?? e.gamesPlayed,
      wins: e.rankedWins ?? e.wins ?? 0,
      correct: e.rankedCorrect ?? e.correctAnswers,
      wrong: e.rankedWrong ?? e.wrongAnswers,
      score: e.rankedScore ?? e.totalScore,
    }));
}

// Agregação de 7/30 dias: leve, mas roda numa consulta que qualquer cliente
// pode disparar — guarda o resultado por alguns segundos.
const PERIOD_CACHE_TTL_MS = 5000;
const periodRowsCache = new Map(); // period -> { at, rows }

function periodRows(period) {
  const hit = periodRowsCache.get(period);
  if (hit && Date.now() - hit.at < PERIOD_CACHE_TTL_MS) return hit.rows;
  const rows = db.listPeriodAggregates(Date.now() - PERIOD_WINDOW_MS[period]);
  periodRowsCache.set(period, { at: Date.now(), rows });
  return rows;
}

function minGamesForRates(period) {
  const forced = Number(process.env.LEADERBOARD_MIN_GAMES);
  return forced > 0 ? forced : MIN_GAMES_FOR_RATES[period];
}

/** Monta um ranking (período + critério) e a posição de quem consulta. */
function getLeaderboard({ period, metric, myKey }) {
  const p = PERIODS.includes(period) ? period : 'all';
  const m = METRICS.includes(metric) ? metric : 'points';
  const rows = p === 'all' ? allTimeRows() : periodRows(p);
  const board = buildBoard(rows, { metric: m, minGamesForRates: minGamesForRates(p), limit: LEADERBOARD_TOP_N, myKey });
  return { period: p, metric: m, ...board };
}

/** Top N de todos os tempos por pontos (formato legado, enviado junto de game_over). */
function getOverallLeaderboard(limit = LEADERBOARD_TOP_N) {
  return buildBoard(allTimeRows(), { metric: 'points', limit }).rows.map((r) => ({
    nickname: r.nickname,
    avatar: r.avatar,
    gamesPlayed: r.games,
    wins: r.wins,
    correctAnswers: r.correct,
    wrongAnswers: r.wrong,
    totalScore: r.score,
  }));
}

/** Reenvia o placar geral pra todo mundo conectado (tela inicial e pódio). */
function broadcastOverallLeaderboard() {
  io.emit('overall_leaderboard', { overallLeaderboard: getOverallLeaderboard() });
}

/**
 * Registra que uma pergunta foi usada e "esquece" as mais antigas dessa
 * categoria assim que o histórico fica do tamanho do próprio banco (menos 1),
 * garantindo que o ciclo nunca trave por falta de perguntas novas.
 */
function recordQuestionInHistory(category, id) {
  const list = persistentHistory[category] || (persistentHistory[category] = []);
  list.push(id);
  const totalInCategory = loadCategory(category).length;
  // Limitado a 40 mesmo em categorias grandes: com bancos pequenos (~20-60
  // perguntas), reservar quase tudo (totalInCategory-1) como "recente"
  // esgota o pool rápido e força fallback constante — o anti-repetição na
  // prática deixa de valer. 40 já é uma janela generosa pra evitar repetição
  // perceptível numa sessão de jogo normal.
  const maxWindow = Math.max(0, Math.min(totalInCategory - 1, 40));
  while (list.length > maxWindow) list.shift();
  historyWriter.markDirty();
}

// ----------------------------------------------------------------------------
// Estado em memória: Map<roomId, Room>
// ----------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, {roomId:string, sessionToken:string}>} sessionToken -> localização */
const sessionIndex = new Map();

class Room {
  constructor(roomId, hostSessionToken, hostIp) {
    this.roomId = roomId;
    this.hostSessionToken = hostSessionToken;
    this.hostIp = hostIp; // usado só para os limites anti-abuso (MAX_ROOMS_PER_IP)
    this.lastActivityAt = Date.now(); // ver ROOM_IDLE_TIMEOUT_MS / sweepIdleRooms
    this.phase = 'lobby'; // 'lobby' | 'question' | 'reveal' | 'podium'
    this.settings = {
      roundTimeMs: DEFAULT_ROUND_TIME_SECONDS * 1000,
      categories: [...ALL_CATEGORIES],
      totalQuestions: DEFAULT_TOTAL_QUESTIONS,
    };
    /** @type {Map<string, PlayerSession>} */
    this.players = new Map();
    this.bannedTokens = new Set();
    this.bannedIps = new Set();
    this.usedQuestionIds = new Set();
    this.currentQuestion = null;   // objeto interno, inclui correct_index (nunca enviado ao cliente antes do reveal)
    this.currentQuestionNumber = 0;
    this.answers = new Map();      // sessionToken -> { chosenIndex, deltaMs, points, correct }
    this.questionTimer = null;
    this.nextQuestionTimer = null;
    this.startedWithPlayers = 0; // quantos jogavam quando a partida começou (decide se vale para o ranking)
    this.createdAt = Date.now();
    /** @type {{id:string, senderToken:string, nickname:string, avatar:string, text:string, ts:number}[]} */
    this.chatLog = []; // guarda senderToken só internamente; nunca sai do servidor
  }

  getPublicPlayerList() {
    return [...this.players.values()].map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      avatar: p.avatar,
      isHost: p.sessionToken === this.hostSessionToken,
      score: round2(p.score),
      connectionStatus: p.connectionStatus,
    }));
  }

  /** playerId público do host atual (o token do host nunca é enviado a ninguém). */
  hostPlayerId() {
    return this.players.get(this.hostSessionToken)?.playerId ?? null;
  }

  findPlayerById(playerId) {
    if (typeof playerId !== 'string') return null;
    for (const p of this.players.values()) if (p.playerId === playerId) return p;
    return null;
  }

  getScoreboard() {
    return this.getPublicPlayerList().sort((a, b) => b.score - a.score);
  }

  connectedCount() {
    return [...this.players.values()].filter((p) => p.connectionStatus === 'connected').length;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Marca a sala como "ativa agora" — chamado em toda interação real (ver usos abaixo). */
function touch(room) {
  if (room) room.lastActivityAt = Date.now();
}

/**
 * Varredura periódica anti-abuso: remove salas sem nenhuma atividade há mais
 * de ROOM_IDLE_TIMEOUT_MS. É uma rede de segurança, não o caminho normal de
 * limpeza (esse continua sendo removePlayer esvaziando a sala) — pega casos
 * como uma sala de lobby esquecida com aba aberta, ou qualquer estado que por
 * algum motivo nunca chegou a zerar sozinho.
 */
function sweepIdleRooms() {
  const now = Date.now();

  // Poda entradas velhas do limitador de criação de salas por IP — sem isso,
  // o Map cresceria para sempre (um IP visitante por dia, nunca removido).
  for (const [ip, timestamps] of roomCreateTimestampsByIp) {
    const recent = timestamps.filter((t) => now - t < ROOM_CREATE_WINDOW_MS);
    if (recent.length === 0) roomCreateTimestampsByIp.delete(ip);
    else if (recent.length !== timestamps.length) roomCreateTimestampsByIp.set(ip, recent);
  }

  // Mesma poda para o limitador de cadastro de contas por IP.
  for (const [ip, timestamps] of registerAttemptsByIp) {
    const recent = timestamps.filter((t) => now - t < REGISTER_WINDOW_MS);
    if (recent.length === 0) registerAttemptsByIp.delete(ip);
    else if (recent.length !== timestamps.length) registerAttemptsByIp.set(ip, recent);
  }

  for (const room of rooms.values()) {
    if (now - room.lastActivityAt <= ROOM_IDLE_TIMEOUT_MS) continue;
    console.log(`Removendo sala ociosa ${room.roomId} (sem atividade há mais de ${Math.round(ROOM_IDLE_TIMEOUT_MS / 60000)} min).`);
    clearTimeout(room.questionTimer);
    clearTimeout(room.nextQuestionTimer);
    for (const player of room.players.values()) {
      if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
      sessionIndex.delete(player.sessionToken);
    }
    io.to(room.roomId).emit('session_expired'); // avisa quem ainda estiver conectado (ex: aba esquecida aberta)
    io.socketsLeave(room.roomId);
    rooms.delete(room.roomId);
  }
}
const idleSweepTimer = setInterval(sweepIdleRooms, ROOM_SWEEP_INTERVAL_MS);
idleSweepTimer.unref();

// Limpeza periódica de sessões de LOGIN inativas há mais de AUTH_TOKEN_MAX_AGE_MS
// (ver comentário na constante). Intervalo de 6h é suficiente — não é algo
// que precisa reagir na hora, só evitar acúmulo indefinido na tabela.
const AUTH_TOKEN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const authTokenSweepTimer = setInterval(() => {
  try {
    const removed = db.pruneOldAuthTokens(AUTH_TOKEN_MAX_AGE_MS);
    if (removed > 0) console.log(`Removidas ${removed} sessão(ões) de login inativas há mais de ${Math.round(AUTH_TOKEN_MAX_AGE_MS / DAY_MS)} dias.`);
  } catch (err) {
    console.error('Erro ao limpar sessões de login antigas:', err.message);
  }
}, AUTH_TOKEN_SWEEP_INTERVAL_MS);
authTokenSweepTimer.unref();

// ----------------------------------------------------------------------------
// App / servidor HTTP + Socket.IO
// ----------------------------------------------------------------------------

const app = express();

// ----------------------------------------------------------------------------
// Cache-busting automático dos assets estáticos (app.js / style.css)
// ----------------------------------------------------------------------------
// Em vez de incrementar manualmente "?v=2", "?v=3" etc. no HTML sempre que
// esses arquivos mudam (fácil de esquecer, e o navegador/CDN podem continuar
// servindo a versão antiga em cache), calculamos aqui um hash do CONTEÚDO de
// cada arquivo. A URL do asset muda sozinha sempre que o arquivo muda — e
// fica igual sempre que não muda. Isso permite cachear os assets de forma
// agressiva (immutable) sem nunca correr o risco de servir uma versão velha.
const PUBLIC_DIR = path.join(__dirname, 'public');

function fileContentHash(filePath) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);
  } catch (err) {
    console.error(`Não foi possível calcular hash de ${filePath}:`, err.message);
    return String(Date.now()); // fallback: pelo menos muda a cada reinício do processo
  }
}

const assetVersions = {
  'app.js': fileContentHash(path.join(PUBLIC_DIR, 'app.js')),
  'style.css': fileContentHash(path.join(PUBLIC_DIR, 'style.css')),
};

// Injeta a versão calculada nas tags <script>/<link> do index.html uma única
// vez, na subida do servidor (o HTML final fica em memória, pronto pra
// servir em cada requisição — não lê o arquivo do disco a cada request).
const indexHtml = fs
  .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('src="/app.js"', `src="/app.js?v=${assetVersions['app.js']}"`)
  .replace('href="/style.css"', `href="/style.css?v=${assetVersions['style.css']}"`);

// Endpoint de saúde para hospedagens/orquestradores (Docker HEALTHCHECK,
// Render, Kubernetes etc.). Sem autenticação de propósito — não expõe nada
// sensível, só contadores agregados; é isso que esses checadores esperam
// poder chamar sem cabeçalhos especiais.
app.get('/health', (req, res) => {
  let playersConnected = 0;
  for (const room of rooms.values()) playersConnected += room.connectedCount();
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    rooms: rooms.size,
    playersConnected,
  });
});

app.get('/', (req, res) => {
  // O HTML em si NUNCA deve ficar em cache — é ele quem diz qual versão dos
  // assets usar, então o navegador precisa sempre buscar o mais recente.
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(indexHtml);
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false, // já cuidamos de servir "/" acima, com o HTML "carimbado"
    setHeaders: (res, filePath) => {
      // app.js e style.css têm hash no nome da query string: podem ficar em
      // cache pelo tempo que for, porque qualquer mudança de conteúdo já
      // gera uma URL diferente automaticamente.
      if (filePath.endsWith('app.js') || filePath.endsWith('style.css')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  pingInterval: 5000,
  pingTimeout: 8000,
  cors: { origin: CORS_ORIGIN },
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE, // ver comentário no topo do arquivo
});

function clientIpOf(socket) {
  return (
    socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
    socket.handshake.address
  );
}

// ----------------------------------------------------------------------------
// Proteção contra força bruta no código de admin (limpar placar geral).
// Após MAX_ADMIN_ATTEMPTS tentativas erradas de um mesmo IP, bloqueia por
// ADMIN_LOCKOUT_MS. Guardado só em memória (reinicia se o servidor reiniciar).
// ----------------------------------------------------------------------------

const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutos

/** @type {Map<string, {failCount:number, lockedUntil:number}>} */
const adminAttemptsByIp = new Map();

function checkAdminCode(ip, code) {
  if (!ADMIN_CLEAR_CODE) {
    return { ok: false, error: 'Recurso desativado neste servidor (ADMIN_CLEAR_CODE não configurado).' };
  }

  const entry = adminAttemptsByIp.get(ip) || { failCount: 0, lockedUntil: 0 };

  if (Date.now() < entry.lockedUntil) {
    const secondsLeft = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return { ok: false, error: `Muitas tentativas erradas. Tente novamente em ${secondsLeft}s.` };
  }

  if (code !== ADMIN_CLEAR_CODE) {
    entry.failCount += 1;
    if (entry.failCount >= MAX_ADMIN_ATTEMPTS) {
      entry.lockedUntil = Date.now() + ADMIN_LOCKOUT_MS;
      entry.failCount = 0;
      adminAttemptsByIp.set(ip, entry);
      return { ok: false, error: `Muitas tentativas erradas. Bloqueado por ${Math.round(ADMIN_LOCKOUT_MS / 60000)} minutos.` };
    }
    adminAttemptsByIp.set(ip, entry);
    return { ok: false, error: 'Código inválido.' };
  }

  adminAttemptsByIp.delete(ip); // código certo: zera o histórico de tentativas
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Limite de conexões simultâneas por IP (ver CONNECTIONS_PER_IP_LIMIT).
// ----------------------------------------------------------------------------

/** @type {Map<string, Set<string>>} ip -> conjunto de socket.id conectados agora */
const socketsByIp = new Map();

/** @type {Map<string, number[]>} ip -> timestamps (ms) das criações de sala recentes */
const roomCreateTimestampsByIp = new Map();

function countRoomsHostedByIp(ip) {
  let count = 0;
  for (const room of rooms.values()) if (room.hostIp === ip) count += 1;
  return count;
}

function canCreateRoom(ip) {
  if (rooms.size >= MAX_ROOMS) return { ok: false, reason: 'SERVER_FULL' };
  if (countRoomsHostedByIp(ip) >= MAX_ROOMS_PER_IP) return { ok: false, reason: 'TOO_MANY_ROOMS_FOR_IP' };

  const now = Date.now();
  const recent = (roomCreateTimestampsByIp.get(ip) || []).filter((t) => now - t < ROOM_CREATE_WINDOW_MS);
  if (recent.length >= ROOM_CREATE_MAX_PER_WINDOW) return { ok: false, reason: 'RATE_LIMIT' };
  recent.push(now);
  roomCreateTimestampsByIp.set(ip, recent);
  return { ok: true };
}

function generateRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 para evitar ambiguidade
  let id;
  do {
    id = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}

/**
 * Resolve o authToken enviado ao criar/entrar em sala:
 *  - sem token  -> null (convidado);
 *  - token válido -> a conta (o nome e o avatar passam a vir DELA, não do que o
 *    cliente mandou — quem está logado não pode aparecer com outro nome);
 *  - token inválido/expirado -> false (o cliente volta para o login).
 */
function accountFromAuthToken(authToken) {
  if (!authToken) return null;
  const user = db.getUserByToken(String(authToken));
  return user || false;
}

function sanitizeNickname(nickname) {
  return String(nickname || 'Jogador')
    .trim()
    .slice(0, MAX_NICKNAME_LENGTH)
    .replace(/[<>]/g, '');
}

/**
 * Um convidado (sem conta) não pode escolher um apelido igual ao username de
 * uma conta cadastrada — senão dá pra passar por ela na sala. `username` é
 * UNIQUE COLLATE NOCASE no banco, então essa checagem já é case-insensitive.
 * Só se aplica a convidados: quem está logado sempre entra com o nome da
 * própria conta (accountFromAuthToken), então nunca colide consigo mesmo.
 */
function nicknameReservedByAccount(nickname) {
  const clean = String(nickname || '').trim();
  if (!clean) return false;
  return !!db.getUserByUsername(clean);
}

function sanitizeAvatar(avatar) {
  const allowed = ['💀', '👽', '👻', '🦇', '🕷️', '😈', '🧟', '🧛', '☠️', '🐺', '🦂', '🐈\u200d⬛'];
  return allowed.includes(avatar) ? avatar : allowed[0];
}

// ----------------------------------------------------------------------------
// Senha de conta: hash com scrypt (nativo do Node — nenhuma dependência nova
// precisa entrar no package.json). Formato salvo: "<salt-hex>:<hash-hex>".
// Comparação sempre via timingSafeEqual (=== vazaria a senha por timing).
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Proteção contra força bruta no login de contas — mesmo princípio do
// bloqueio do código de admin (ver checkAdminCode), mas por IP em vez de por
// usuário: evita que alguém tente adivinhar a senha de várias contas
// diferentes a partir do mesmo IP.
// ----------------------------------------------------------------------------
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutos

/** @type {Map<string, {failCount:number, lockedUntil:number}>} */
const loginAttemptsByIp = new Map();

function checkLoginAllowed(ip) {
  const entry = loginAttemptsByIp.get(ip);
  if (entry && Date.now() < entry.lockedUntil) {
    const secondsLeft = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return { ok: false, error: `Muitas tentativas erradas. Tente novamente em ${secondsLeft}s.` };
  }
  return { ok: true };
}

function registerLoginFailure(ip) {
  const entry = loginAttemptsByIp.get(ip) || { failCount: 0, lockedUntil: 0 };
  entry.failCount += 1;
  if (entry.failCount >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.failCount = 0;
  }
  loginAttemptsByIp.set(ip, entry);
}

function registerLoginSuccess(ip) {
  loginAttemptsByIp.delete(ip);
}

// ----------------------------------------------------------------------------
// Limite de criação de CONTAS por IP — sem isso, um script consegue chamar
// auth:register em loop e forçar o servidor a calcular scrypt (caro de
// propósito) repetidas vezes: um vetor de negação de serviço de baixo custo
// pra quem ataca. Não precisa ser tão apertado quanto login (criar conta é
// uma ação legítima rara por pessoa), mas precisa de algum teto.
// ----------------------------------------------------------------------------
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const REGISTER_MAX_PER_WINDOW = Number(process.env.REGISTER_MAX_PER_WINDOW) || 10;

/** @type {Map<string, number[]>} ip -> timestamps (ms) de cadastros recentes */
const registerAttemptsByIp = new Map();

function checkRegisterAllowed(ip) {
  const now = Date.now();
  const recent = (registerAttemptsByIp.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (recent.length >= REGISTER_MAX_PER_WINDOW) return false;
  recent.push(now);
  registerAttemptsByIp.set(ip, recent);
  return true;
}

// ----------------------------------------------------------------------------
// Sockets
// ----------------------------------------------------------------------------

io.on('connection', (socket) => {
  const ip = clientIpOf(socket);

  // Limite de conexões simultâneas por IP — antes de qualquer outra coisa,
  // pra nem gastar handshake/memória com quem já estourou a cota.
  const ipSockets = socketsByIp.get(ip) || new Set();
  if (ipSockets.size >= CONNECTIONS_PER_IP_LIMIT) {
    socket.emit('connection_rejected', { reason: 'TOO_MANY_CONNECTIONS' });
    socket.disconnect(true);
    return;
  }
  ipSockets.add(socket.id);
  socketsByIp.set(ip, ipSockets);

  // Assim que conecta, já manda o placar geral atual — assim a tela inicial
  // pode exibi-lo sem precisar esperar o fim de uma partida.
  socket.emit('overall_leaderboard', { overallLeaderboard: getOverallLeaderboard() });

  // ---- Login de CONTA (usuário+senha) ---------------------------------------
  // Propositalmente independente de sala: nenhum handler abaixo lê ou grava
  // em `rooms`/`sessionIndex`. O authToken só prova "quem é essa pessoa" —
  // criar ou entrar numa sala continua funcionando do mesmo jeito de sempre
  // (create_room/join_room, mais abaixo), sem exigir esse token.
  socket.on('auth:register', ({ username, password, avatar } = {}, ack) => {
    try {
      if (!checkRegisterAllowed(ip)) return ack?.({ ok: false, reason: 'RATE_LIMIT' });

      const clean = String(username || '').trim();
      if (!USERNAME_REGEX.test(clean)) return ack?.({ ok: false, reason: 'INVALID_USERNAME' });
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return ack?.({ ok: false, reason: 'INVALID_PASSWORD' });
      }
      if (db.getUserByUsername(clean)) return ack?.({ ok: false, reason: 'USERNAME_TAKEN' });

      const id = crypto.randomUUID();
      const cleanAvatar = sanitizeAvatar(avatar);
      const recoveryCode = generateRecoveryCode();
      db.createUser({
        id, username: clean, passwordHash: hashPassword(password),
        recoveryCodeHash: hashPassword(normalizeRecoveryCode(recoveryCode)), avatar: cleanAvatar,
      });

      const authToken = db.createAuthToken(id);
      // recoveryCode em texto puro só existe aqui e no ack — nunca é
      // guardado (só o hash acima); é responsabilidade do cliente mostrar
      // "anote este código" uma única vez.
      ack?.({ ok: true, authToken, userId: id, username: clean, avatar: cleanAvatar, recoveryCode });
    } catch (err) {
      // corrida rara: dois cadastros com o mesmo usuário quase ao mesmo tempo
      if (err && /UNIQUE/i.test(err.message || '')) return ack?.({ ok: false, reason: 'USERNAME_TAKEN' });
      console.error('Erro ao criar conta:', err.message);
      ack?.({ ok: false, reason: 'INTERNAL_ERROR' });
    }
  });

  // Verificação de usuário disponível ENQUANTO a pessoa digita (cadastro e
  // edição de perfil). Não é validação de verdade — o servidor sempre
  // recusa no auth:register/auth:update_profile se já estiver em uso (corrida
  // entre a checagem e o envio é possível e tratada lá); isso aqui é só feedback
  // visual imediato. `excludeUserId` deixa a própria conta "ver" o username
  // dela mesma como disponível ao editar o perfil sem trocar de nome.
  socket.on('auth:check_username', ({ username, excludeUserId } = {}, ack) => {
    const clean = String(username || '').trim();
    if (!USERNAME_REGEX.test(clean)) return ack?.({ ok: true, available: false, reason: 'INVALID_USERNAME' });
    const existing = db.getUserByUsername(clean);
    const available = !existing || existing.id === excludeUserId;
    ack?.({ ok: true, available });
  });

  socket.on('auth:login', ({ username, password } = {}, ack) => {
    const gate = checkLoginAllowed(ip);
    if (!gate.ok) return ack?.({ ok: false, reason: 'RATE_LIMIT', error: gate.error });

    const clean = String(username || '').trim();
    const user = clean && typeof password === 'string' ? db.getUserByUsername(clean) : null;

    if (!user || !verifyPassword(password, user.password_hash)) {
      registerLoginFailure(ip);
      return ack?.({ ok: false, reason: 'INVALID_CREDENTIALS' });
    }

    registerLoginSuccess(ip);
    const authToken = db.createAuthToken(user.id);
    ack?.({ ok: true, authToken, userId: user.id, username: user.username, avatar: user.avatar });
  });

  // Retoma o login sozinho ao reconectar/recarregar a página, a partir do
  // authToken salvo no navegador (localStorage) — é o que faz a conta
  // "lembrar" a pessoa em qualquer dispositivo sem pedir senha de novo.
  socket.on('auth:resume', ({ authToken } = {}, ack) => {
    if (!authToken) return ack?.({ ok: false, reason: 'NO_TOKEN' });
    const user = db.getUserByToken(authToken);
    if (!user) return ack?.({ ok: false, reason: 'INVALID_TOKEN' });
    ack?.({ ok: true, userId: user.id, username: user.username, avatar: user.avatar });
  });

  socket.on('auth:logout', ({ authToken } = {}, ack) => {
    if (authToken) db.deleteAuthToken(authToken);
    ack?.({ ok: true });
  });

  // "Sair de todos os aparelhos": apaga TODOS os authTokens da conta,
  // incluindo o desta própria aba — o cliente trata a resposta como um
  // logout normal (ver app.js). Não pede senha de novo: quem já está
  // logado com um token válido já provou quem é.
  socket.on('auth:logout_all', ({ authToken } = {}, ack) => {
    if (!authToken) return ack?.({ ok: false, reason: 'NO_TOKEN' });
    const user = db.getUserByToken(String(authToken));
    if (!user) return ack?.({ ok: false, reason: 'INVALID_TOKEN' });
    db.deleteAuthTokensForUser(user.id, null);
    ack?.({ ok: true });
  });

  // "Trocar senha" — só para quem já está logado; exige a senha atual (não
  // basta ter o authToken) para não deixar alguém que rouba um token de
  // sessão trocar a senha e travar o dono de fora.
  socket.on('auth:change_password', ({ authToken, currentPassword, newPassword } = {}, ack) => {
    if (!authToken) return ack?.({ ok: false, reason: 'NO_TOKEN' });
    const user = db.getUserByToken(String(authToken));
    if (!user) return ack?.({ ok: false, reason: 'INVALID_TOKEN' });
    if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, user.password_hash)) {
      return ack?.({ ok: false, reason: 'INVALID_CURRENT_PASSWORD' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
      return ack?.({ ok: false, reason: 'INVALID_PASSWORD' });
    }
    db.updateUserPassword(user.id, hashPassword(newPassword));
    // Senha trocada = todo outro aparelho logado nessa conta é deslogado por
    // segurança (mantém só a sessão de quem acabou de provar a senha atual).
    db.deleteAuthTokensForUser(user.id, String(authToken));
    ack?.({ ok: true });
  });

  // "Esqueci minha senha" — prova de identidade é o código de recuperação
  // mostrado uma única vez no cadastro (ou na última recuperação bem-sucedida),
  // não a senha atual. Mesmo limite de tentativas por IP que auth:login,
  // porque adivinhar o código é tão sensível quanto adivinhar a senha.
  socket.on('auth:forgot_password', ({ username, recoveryCode, newPassword } = {}, ack) => {
    const gate = checkLoginAllowed(ip);
    if (!gate.ok) return ack?.({ ok: false, reason: 'RATE_LIMIT', error: gate.error });

    const clean = String(username || '').trim();
    const code = normalizeRecoveryCode(recoveryCode);
    const user = clean ? db.getUserByUsername(clean) : null;
    // Mesma mensagem genérica para "conta não existe", "conta sem código
    // (migrada de antes desse recurso)" e "código errado" — não dá pra
    // descobrir por tentativa qual dos três é o caso.
    if (!user || !user.recovery_code_hash || !code || !verifyPassword(code, user.recovery_code_hash)) {
      registerLoginFailure(ip);
      return ack?.({ ok: false, reason: 'INVALID_CODE' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
      return ack?.({ ok: false, reason: 'INVALID_PASSWORD' });
    }

    registerLoginSuccess(ip);
    const newRecoveryCode = generateRecoveryCode(); // código é de uso único: um novo substitui o antigo
    db.updateUserPassword(user.id, hashPassword(newPassword));
    db.updateRecoveryCodeHash(user.id, hashPassword(normalizeRecoveryCode(newRecoveryCode)));
    // Redefinir a senha também desloga qualquer aparelho com sessão aberta —
    // alguém redefinindo por aqui pode ser porque a conta foi comprometida.
    db.deleteAuthTokensForUser(user.id, null);
    const authToken = db.createAuthToken(user.id);
    ack?.({ ok: true, authToken, userId: user.id, username: user.username, avatar: user.avatar, recoveryCode: newRecoveryCode });
  });

  // Editar perfil (nome de usuário e/ou avatar) de quem já está logado. É o
  // único jeito de mudar o nome depois do cadastro — a conta continua sendo
  // a mesma linha em `users` (mesmo id), só username/avatar mudam. Salas já
  // abertas não recebem o novo nome retroativamente (o nome fica gravado no
  // Player daquela sala); vale a partir da próxima sala criada/entrada.
  socket.on('auth:update_profile', ({ authToken, username, avatar } = {}, ack) => {
    try {
      if (!authToken) return ack?.({ ok: false, reason: 'NO_TOKEN' });
      const user = db.getUserByToken(String(authToken));
      if (!user) return ack?.({ ok: false, reason: 'INVALID_TOKEN' });

      const clean = String(username || '').trim();
      if (!USERNAME_REGEX.test(clean)) return ack?.({ ok: false, reason: 'INVALID_USERNAME' });
      const existing = db.getUserByUsername(clean);
      if (existing && existing.id !== user.id) return ack?.({ ok: false, reason: 'USERNAME_TAKEN' });

      const cleanAvatar = sanitizeAvatar(avatar);
      db.updateUserProfile(user.id, { username: clean, avatar: cleanAvatar });
      ack?.({ ok: true, username: clean, avatar: cleanAvatar });
    } catch (err) {
      if (err && /UNIQUE/i.test(err.message || '')) return ack?.({ ok: false, reason: 'USERNAME_TAKEN' });
      console.error('Erro ao editar perfil:', err.message);
      ack?.({ ok: false, reason: 'INTERNAL_ERROR' });
    }
  });

  // ---- Criar sala ----------------------------------------------------------
  socket.on('create_room', ({ nickname, avatar, deviceId, authToken }, ack) => {
    try {
      const gate = canCreateRoom(ip);
      if (!gate.ok) return ack?.({ ok: false, reason: gate.reason });

      const account = accountFromAuthToken(authToken);
      if (account === false) return ack?.({ ok: false, reason: 'AUTH_EXPIRED' });
      if (!account && nicknameReservedByAccount(sanitizeNickname(nickname))) {
        return ack?.({ ok: false, reason: 'NICKNAME_RESERVED' });
      }

      const sessionToken = crypto.randomUUID();
      const roomId = generateRoomId();
      const room = new Room(roomId, sessionToken, ip);

      const player = account
        ? makePlayer(sessionToken, account.username, account.avatar, socket.id, ip, true, deviceId, account.id)
        : makePlayer(sessionToken, nickname, avatar, socket.id, ip, true, deviceId);
      room.players.set(sessionToken, player);
      rooms.set(roomId, room);
      sessionIndex.set(sessionToken, { roomId, sessionToken });

      socket.join(roomId);
      ack?.({ ok: true, roomId, sessionToken, playerId: player.playerId });
      broadcastLobbyState(room);
    } catch (err) {
      ack?.({ ok: false, reason: 'INTERNAL_ERROR' });
    }
  });

  // ---- Entrar em sala existente --------------------------------------------
  socket.on('join_room', ({ roomId, nickname, avatar, deviceId, authToken }, ack) => {
    const account = accountFromAuthToken(authToken);
    if (account === false) return ack?.({ ok: false, reason: 'AUTH_EXPIRED' });
    if (!account && nicknameReservedByAccount(sanitizeNickname(nickname))) {
      return ack?.({ ok: false, reason: 'NICKNAME_RESERVED' });
    }
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return ack?.({ ok: false, reason: 'ROOM_NOT_FOUND' });
    if (room.bannedIps.has(ip)) return ack?.({ ok: false, reason: 'BANNED' });
    if (room.phase !== 'lobby') return ack?.({ ok: false, reason: 'GAME_ALREADY_STARTED' });
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return ack?.({ ok: false, reason: 'ROOM_FULL' });

    const sessionToken = crypto.randomUUID();
    const player = account
      ? makePlayer(sessionToken, account.username, account.avatar, socket.id, ip, false, deviceId, account.id)
      : makePlayer(sessionToken, nickname, avatar, socket.id, ip, false, deviceId);
    room.players.set(sessionToken, player);
    sessionIndex.set(sessionToken, { roomId: room.roomId, sessionToken });
    touch(room);

    socket.join(room.roomId);
    ack?.({ ok: true, roomId: room.roomId, sessionToken, playerId: player.playerId });
    io.to(room.roomId).emit('player_joined', { nickname: player.nickname });
    socket.emit('chat:history', { messages: chatHistoryFor(room, player) });
    broadcastLobbyState(room);
  });

  // ---- Sair da sala (voltar ao menu inicial) --------------------------------
  // Permitido no lobby E no pódio (partida já terminada) — nesses dois casos
  // "sair" é uma decisão limpa e sem efeito colateral em placar. NÃO permitido
  // durante question/reveal: quem cai no meio de uma partida em andamento
  // continua sendo tratado pelo grace period de reconexão, não por isso aqui.
  // Se o host sai, removePlayer já repassa a liderança; se era o último
  // jogador, a sala é apagada.
  socket.on('leave_room', ({ roomId, sessionToken } = {}, ack) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    const player = room?.players.get(sessionToken);
    // Idempotente: sala/jogador que já não existem contam como "já saiu".
    if (!room || !player || player.socketId !== socket.id) return ack?.({ ok: true });
    if (room.phase !== 'lobby' && room.phase !== 'podium') return ack?.({ ok: false, reason: 'GAME_ALREADY_STARTED' });
    removePlayer(room, player, 'left');
    ack?.({ ok: true });
  });

  // ---- Reconexão -------------------------------------------------------------
  socket.on('rejoin_room', ({ sessionToken, roomId }, ack) => {
    const room = rooms.get(roomId);
    const player = room?.players.get(sessionToken);
    if (!room || !player) return ack?.({ ok: false, reason: 'SESSION_NOT_FOUND' });
    touch(room);

    player.socketId = socket.id;
    player.connectionStatus = 'connected';
    player.disconnectedAt = null;
    if (player.reconnectTimer) {
      clearTimeout(player.reconnectTimer);
      player.reconnectTimer = null;
    }

    socket.join(room.roomId);
    ack?.({
      ok: true,
      snapshot: buildSnapshotFor(room, player),
    });
    io.to(room.roomId).emit('player_reconnected', { nickname: player.nickname });
    broadcastLobbyState(room);
  });

  // ---- Ações do host ---------------------------------------------------------
  socket.on('host:set_round_time', ({ roomId, sessionToken, seconds }) => {
    const room = requireHost(roomId, sessionToken);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'podium')) return;
    if (!VALID_ROUND_TIMES_SECONDS.includes(seconds)) return; // nunca confia em valor arbitrário do cliente
    room.settings.roundTimeMs = seconds * 1000;
    broadcastLobbyState(room);
  });

  socket.on('host:set_categories', ({ roomId, sessionToken, categoryIds }) => {
    const room = requireHost(roomId, sessionToken);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'podium')) return;
    const valid = Array.isArray(categoryIds)
      ? categoryIds.filter((c) => ALL_CATEGORIES.includes(c))
      : [];
    if (valid.length === 0) return;
    room.settings.categories = [...new Set(valid)];
    broadcastLobbyState(room);
  });

  socket.on('host:set_total_questions', ({ roomId, sessionToken, total }) => {
    const room = requireHost(roomId, sessionToken);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'podium')) return;
    const n = Number(total);
    if (!Number.isInteger(n) || n < MIN_TOTAL_QUESTIONS || n > 30) return;
    room.settings.totalQuestions = n;
    broadcastLobbyState(room);
  });

  socket.on('host:transfer_leadership', ({ roomId, sessionToken, targetPlayerId }) => {
    const room = requireHost(roomId, sessionToken);
    const target = room?.findPlayerById(targetPlayerId);
    if (!room || !target) return;
    room.hostSessionToken = target.sessionToken;
    broadcastLobbyState(room);
  });

  socket.on('host:kick_player', ({ roomId, sessionToken, targetPlayerId }) => {
    const room = requireHost(roomId, sessionToken);
    const target = room?.findPlayerById(targetPlayerId);
    if (!room || !target || target.sessionToken === room.hostSessionToken) return;
    removePlayer(room, target, 'kicked');
  });

  socket.on('host:ban_player', ({ roomId, sessionToken, targetPlayerId }) => {
    const room = requireHost(roomId, sessionToken);
    const target = room?.findPlayerById(targetPlayerId);
    if (!room || !target || target.sessionToken === room.hostSessionToken) return;
    room.bannedTokens.add(target.sessionToken);
    room.bannedIps.add(target.ip);
    removePlayer(room, target, 'banned');
  });

  socket.on('host:start_game', ({ roomId, sessionToken }) => {
    const room = requireHost(roomId, sessionToken);
    if (!room || room.phase !== 'lobby') return;
    if (room.connectedCount() < MIN_PLAYERS_TO_START) return;
    startGame(room);
  });

  // ---- Jogar de novo (revanche na mesma sala) -------------------------------
  // Só faz sentido a partir do pódio (partida terminada). Reaproveita a MESMA
  // sala/código e as configurações já escolhidas (tempo por rodada, nº de
  // perguntas, categorias) — quem quiser mudar algo ajusta antes no painel do
  // host, que continua disponível (a sala não passa pelo lobby de novo, mas
  // os controles de host:set_* funcionam em qualquer fase que não seja
  // question/reveal). startGame() já cuida de zerar placar, sequência de
  // acertos, power-ups e histórico de perguntas usadas NESTA partida.
  socket.on('host:rematch', ({ roomId, sessionToken } = {}, ack) => {
    const room = requireHost(roomId, sessionToken);
    if (!room) return ack?.({ ok: false, reason: 'NOT_HOST' });
    if (room.phase !== 'podium') return ack?.({ ok: false, reason: 'GAME_NOT_OVER' });
    if (room.connectedCount() < MIN_PLAYERS_TO_START) return ack?.({ ok: false, reason: 'NOT_ENOUGH_PLAYERS' });
    startGame(room);
    ack?.({ ok: true });
  });

  // ---- Resposta do jogador ----------------------------------------------------
  // ---- Chat da sala ----------------------------------------------------------
  // Funciona em qualquer fase. Durante a pergunta aberta, mensagens que entregam
  // a resposta são censuradas (ver chat-guard.js). Quem envia é
  // validado pelo sessionToken E pelo socket atual do jogador, e cada jogador
  // tem limite de mensagens por janela de tempo (anti-spam).
  socket.on('chat:send', ({ roomId, sessionToken, text } = {}, ack) => {
    const room = rooms.get(roomId);
    const player = room?.players.get(sessionToken);
    if (!room || !player || player.socketId !== socket.id) return ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
    touch(room);

    const clean = sanitizeChatText(text);
    if (!clean) return ack?.({ ok: false, reason: 'EMPTY' });

    const now = Date.now();
    player.chatSentAt = (player.chatSentAt || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    if (player.chatSentAt.length >= CHAT_RATE_MAX) return ack?.({ ok: false, reason: 'RATE_LIMIT' });
    player.chatSentAt.push(now); // tentativas censuradas também contam no limite (evita ficar testando)

    // Censura: durante a pergunta, nada de citar alternativas ("letra B", "a segunda",
    // o texto da opção...). Censura QUALQUER alternativa, não só a correta — senão o
    // bloqueio viraria um oráculo pra descobrir a resposta. Não entra no histórico.
    if (room.phase === 'question' && room.currentQuestion && revealsAnswer(clean, room.currentQuestion)) {
      io.to(room.roomId).emit('chat:notice', {
        id: crypto.randomUUID(),
        text: `🚫 Mensagem de ${player.nickname} censurada: não vale dar a resposta!`,
        ts: now,
      });
      return ack?.({ ok: false, reason: 'CENSORED' });
    }

    const msg = {
      id: crypto.randomUUID(),
      senderToken: player.sessionToken,
      nickname: player.nickname,
      avatar: player.avatar,
      text: clean,
      ts: now,
    };
    room.chatLog.push(msg);
    while (room.chatLog.length > CHAT_HISTORY_LIMIT) room.chatLog.shift();

    // Quem enviou recebe com mine:true; os demais na sala recebem com mine:false.
    socket.emit('chat:message', publicChatMessage(msg, player.sessionToken));
    socket.to(room.roomId).emit('chat:message', publicChatMessage(msg, null));
    ack?.({ ok: true });
  });

  socket.on('submit_answer', ({ roomId, sessionToken, questionId, chosenIndex }) => {
    const room = rooms.get(roomId);
    const player = room?.players.get(sessionToken);
    if (!room || !player || player.socketId !== socket.id) return;
    if (room.phase !== 'question' || !room.currentQuestion) return;
    if (room.currentQuestion.id !== questionId) return; // resposta de rodada antiga, ignora
    if (room.answers.has(sessionToken)) return; // idempotência: só a primeira resposta vale
    touch(room);

    // *** Fonte única da verdade temporal: Date.now() do servidor. ***
    const answerReceivedAtServerTs = Date.now();
    let result = calculateScore(room.currentQuestion, chosenIndex, answerReceivedAtServerTs);

    // Power-up "pontos em dobro": consumido AGORA (acertando ou errando —
    // usar e errar desperdiça a carga, é o risco de ativar antes de saber a
    // resposta). Não altera a pontuação-base, só dobra o resultado já
    // calculado — continua vindo inteiramente do servidor.
    const doubled = result.correct && player.pendingDoublePoints;
    if (doubled) result = { ...result, points: round2(result.points * 2) };
    player.pendingDoublePoints = false;

    let powerupGranted = null;
    if (result.correct) {
      player.correctCount += 1;
      player.currentStreak += 1;
      player.bestStreak = Math.max(player.bestStreak, player.currentStreak);
      powerupGranted = grantStreakPowerupIfMilestone(player);
    } else {
      player.wrongCount += 1;
      player.currentStreak = 0;
    }
    player.totalDeltaMs += result.deltaMs;
    player.score += result.points;
    // Guarda pra incluir no question:reveal (ver revealQuestion) — NÃO pode
    // ir pro cliente agora: só ganha power-up acertando, então avisar na
    // hora entregaria de bandeja que esta resposta foi certa, antes da
    // revelação da sala. currentStreak entra no mesmo payload, pelo mesmo motivo.
    room.answers.set(sessionToken, { ...result, doubled, powerupGranted, streakAfter: player.currentStreak });

    socket.emit('answer_ack', { received: true });
    io.to(room.roomId).emit('answers_progress', {
      answered: room.answers.size,
      total: room.connectedCount(),
    });

    // Revela antecipadamente se todo mundo já respondeu (não precisa esperar o timer)
    if (room.answers.size >= room.connectedCount()) {
      clearTimeout(room.questionTimer);
      revealQuestion(room);
    }
  });

  // ---- Heartbeat de latência (usado pelo indicador de conexão do cliente) -------
  // Também devolve o horário do servidor: é o que o cliente usa pra estimar
  // a diferença entre o próprio relógio e o do servidor (ver clockOffsetMs em
  // app.js) — sem isso, o timer visual da pergunta corre adiantado ou
  // atrasado em qualquer aparelho cujo relógio não esteja bem sincronizado,
  // podendo fazer a pessoa perder tempo de resposta sem culpa da rede.
  socket.on('ping_check', (ack) => {
    ack?.({ serverTs: Date.now() });
  });

  // ---- Usar um power-up (50/50 ou pontos em dobro) --------------------------
  // Só durante a pergunta aberta, antes de responder, e só com carga
  // disponível — tudo validado e aplicado no servidor. "50/50" devolve 2
  // índices ERRADOS pra esconder (nunca o correto, óbvio) só pra quem pediu,
  // via socket individual — nunca broadcast, senão viraria cola pra sala
  // inteira. Idempotente: pedir de novo pra mesma pergunta devolve o mesmo
  // par já sorteado, sem gastar uma segunda carga.
  socket.on('powerup:use', ({ roomId, sessionToken, questionId, type } = {}, ack) => {
    const room = rooms.get(roomId);
    const player = room?.players.get(sessionToken);
    if (!room || !player || player.socketId !== socket.id) return ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
    if (room.phase !== 'question' || !room.currentQuestion || room.currentQuestion.id !== questionId) {
      return ack?.({ ok: false, reason: 'QUESTION_CHANGED' });
    }
    if (room.answers.has(sessionToken)) return ack?.({ ok: false, reason: 'ALREADY_ANSWERED' });
    if (!POWERUP_TYPES.includes(type)) return ack?.({ ok: false, reason: 'INVALID_POWERUP' });
    touch(room);

    if (type === 'fiftyFifty') {
      if (player.fiftyFiftyActive?.questionId === questionId) {
        return ack?.({ ok: true, hiddenIndices: player.fiftyFiftyActive.hiddenIndices }); // já usado nesta pergunta
      }
      if (player.powerups.fiftyFifty <= 0) return ack?.({ ok: false, reason: 'NO_CHARGES' });

      const wrongIndices = [0, 1, 2, 3].filter((i) => i !== room.currentQuestion.correct_index);
      for (let i = wrongIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [wrongIndices[i], wrongIndices[j]] = [wrongIndices[j], wrongIndices[i]];
      }
      const hiddenIndices = wrongIndices.slice(0, 2);

      player.powerups.fiftyFifty -= 1;
      player.fiftyFiftyActive = { questionId, hiddenIndices };
      return ack?.({ ok: true, hiddenIndices, powerups: player.powerups });
    }

    // type === 'doublePoints'
    if (player.pendingDoublePoints) return ack?.({ ok: false, reason: 'ALREADY_ACTIVE' });
    if (player.powerups.doublePoints <= 0) return ack?.({ ok: false, reason: 'NO_CHARGES' });
    player.powerups.doublePoints -= 1;
    player.pendingDoublePoints = true;
    return ack?.({ ok: true, powerups: player.powerups });
  });

  // ---- Reportar pergunta com problema -------------------------------------
  // Não corrige nada sozinho: só registra o relato pra revisão manual do
  // banco de perguntas depois (ver scripts/list-reports.js). Propositalmente
  // não valida se o motivo "faz sentido" além de vir da lista fechada — é um
  // sinal de baixo risco, não uma ação que precise de mais fricção.
  socket.on('report_question', ({ roomId, sessionToken, questionId, reason } = {}, ack) => {
    const room = rooms.get(roomId);
    const player = room?.players.get(sessionToken);
    if (!room || !player || player.socketId !== socket.id) return ack?.({ ok: false, reason: 'NOT_IN_ROOM' });
    if (!room.currentQuestion || room.currentQuestion.id !== questionId) {
      return ack?.({ ok: false, reason: 'QUESTION_CHANGED' }); // já foi pra próxima pergunta
    }
    if (!QUESTION_REPORT_REASONS.includes(reason)) return ack?.({ ok: false, reason: 'INVALID_REASON' });
    touch(room);

    try {
      db.insertQuestionReport({
        questionId: room.currentQuestion.id,
        category: room.currentQuestion.category,
        questionText: room.currentQuestion.question,
        reason,
        roomId: room.roomId,
        nickname: player.nickname,
      });
      ack?.({ ok: true });
    } catch (err) {
      console.error('Falha ao salvar report de pergunta:', err.message);
      ack?.({ ok: false, reason: 'INTERNAL_ERROR' });
    }
  });

  // ---- Rankings (período + critério) ------------------------------------------
  // Sob demanda, em vez de empurrar um placar único para todos: cada cliente
  // pede o recorte que está vendo e recebe também a SUA posição (a chave de
  // quem consulta nunca sai do servidor — só volta como `isMe`).
  socket.on('leaderboard:get', ({ period, metric, authToken, deviceId } = {}, ack) => {
    try {
      const myKey = statsKeyForRequester({ authToken, deviceId });
      ack?.({ ok: true, ...getLeaderboard({ period, metric, myKey }) });
    } catch (err) {
      console.error('Falha ao montar ranking:', err.message);
      ack?.({ ok: false, reason: 'INTERNAL_ERROR' });
    }
  });

  // ---- Admin: limpar o placar geral (protegido por código secreto) -------------
  socket.on('admin:clear_leaderboard', ({ code }, ack) => {
    const check = checkAdminCode(ip, code);
    if (!check.ok) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    for (const key of Object.keys(playerStats)) delete playerStats[key];
    db.clearAllPlayerStats(); // ação rara e explícita: grava na hora, não espera o debounce (limpa também o log dos rankings de 7/30 dias)
    periodRowsCache.clear();
    broadcastOverallLeaderboard();
    ack?.({ ok: true });
  });

  // ---- Desconexão --------------------------------------------------------------
  socket.on('disconnect', () => {
    const ipSocketsNow = socketsByIp.get(ip);
    if (ipSocketsNow) {
      ipSocketsNow.delete(socket.id);
      if (ipSocketsNow.size === 0) socketsByIp.delete(ip);
    }

    for (const room of rooms.values()) {
      const player = [...room.players.values()].find((p) => p.socketId === socket.id);
      if (!player) continue;

      player.connectionStatus = 'disconnected';
      player.disconnectedAt = Date.now();
      io.to(room.roomId).emit('player_disconnected', { nickname: player.nickname });
      broadcastLobbyState(room);

      player.reconnectTimer = setTimeout(() => {
        // Grace period expirou sem reconexão: remove definitivamente
        if (player.connectionStatus === 'disconnected') {
          removePlayer(room, player, 'timeout');
        }
      }, RECONNECT_GRACE_MS);
    }
  });

  // ---- Helpers internos que dependem do socket atual ----------------------------
  function requireHost(roomId, sessionToken) {
    const room = rooms.get(roomId);
    if (!room) return null;
    if (room.hostSessionToken !== sessionToken) return null;
    // Defesa em profundidade: além do token, a chamada precisa vir do socket
    // atual do host (rejoin_room atualiza socketId ao reconectar).
    if (room.players.get(sessionToken)?.socketId !== socket.id) return null;
    touch(room);
    return room;
  }
});

// ----------------------------------------------------------------------------
// Funções de domínio
// ----------------------------------------------------------------------------

function makePlayer(sessionToken, nickname, avatar, socketId, ip, isHostFlag, deviceId, userId = null) {
  return {
    // sessionToken = SEGREDO de quem joga (credencial). Nunca sai do servidor
    // para outros jogadores. playerId = identificador PÚBLICO e aleatório,
    // usado na tela pra apontar jogadores (host, moderação, "eu") sem expor
    // credenciais.
    sessionToken,
    playerId: crypto.randomBytes(8).toString('hex'),
    nickname: sanitizeNickname(nickname),
    avatar: sanitizeAvatar(avatar),
    // id da CONTA (só se entrou logado, validado no servidor pelo authToken).
    // Serve só para o placar acompanhar a pessoa entre aparelhos — nunca para autorização de sala.
    userId,
    // UUID persistido no localStorage do cliente; usado só para o placar geral
    // de todos os tempos, nunca para autorização (isso continua sendo o
    // sessionToken). String livre não confiável — validamos o formato básico
    // para evitar poluir o placar com lixo.
    deviceId: typeof deviceId === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(deviceId) ? deviceId : null,
    socketId,
    ip,
    score: 0,
    correctCount: 0,
    wrongCount: 0,
    totalDeltaMs: 0,
    // Sequência de acertos e power-ups (ver STREAK_MILESTONE/grantStreakPowerupIfMilestone).
    currentStreak: 0,
    bestStreak: 0,
    powerups: freshPowerups(),
    pendingDoublePoints: false, // ativado por powerup:use, consumido no próximo submit_answer
    fiftyFiftyActive: null,     // { questionId, hiddenIndices } — só durante a pergunta em que foi usado
    connectionStatus: 'connected',
    disconnectedAt: null,
    reconnectTimer: null,
    joinedAtServerTs: Date.now(),
  };
}

function removePlayer(room, player, reasonEventName) {
  room.players.delete(player.sessionToken);
  sessionIndex.delete(player.sessionToken);
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);

  // Saída voluntária ('left'): quem saiu já sabe (o cliente volta ao menu sozinho
  // pelo ack de leave_room), então não recebe evento nenhum.
  if (reasonEventName !== 'left') {
    io.to(player.socketId).emit(reasonEventName === 'kicked' ? 'you_were_kicked' : reasonEventName === 'banned' ? 'you_were_banned' : 'session_expired');
  }
  io.sockets.sockets.get(player.socketId)?.leave(room.roomId);

  if (room.hostSessionToken === player.sessionToken) {
    const next = [...room.players.values()][0];
    if (next) room.hostSessionToken = next.sessionToken;
  }

  broadcastLobbyState(room);

  if (room.players.size === 0) {
    clearTimeout(room.questionTimer);
    clearTimeout(room.nextQuestionTimer);
    rooms.delete(room.roomId);
  }
}

function broadcastLobbyState(room) {
  io.to(room.roomId).emit('lobby_state', {
    roomId: room.roomId,
    hostPlayerId: room.hostPlayerId(),
    settings: room.settings,
    players: room.getPublicPlayerList(),
    phase: room.phase,
    availableCategories: ALL_CATEGORIES,
  });
}

/**
 * Limpa o texto de uma mensagem de chat: só string, sem caracteres de controle
 * nem marcadores invisíveis de direção (usados pra bagunçar a leitura),
 * espaços colapsados e limite de tamanho. O cliente ainda mostra tudo via
 * textContent (nunca innerHTML), então HTML digitado aparece como texto puro.
 */
function sanitizeChatText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH)
    .trim();
}

/** Versão pública de uma mensagem — sem token; `mine` é calculado por destinatário. */
function publicChatMessage(m, viewerToken) {
  return { id: m.id, nickname: m.nickname, avatar: m.avatar, text: m.text, ts: m.ts, mine: m.senderToken === viewerToken };
}

function chatHistoryFor(room, player) {
  return room.chatLog.map((m) => publicChatMessage(m, player.sessionToken));
}

function buildSnapshotFor(room, player) {
  return {
    phase: room.phase,
    settings: room.settings,
    players: room.getPublicPlayerList(),
    hostPlayerId: room.hostPlayerId(),
    playerId: player.playerId,
    currentQuestion: room.currentQuestion
      ? {
          id: room.currentQuestion.id,
          category: room.currentQuestion.category,
          difficulty: room.currentQuestion.difficulty,
          questionText: room.currentQuestion.question,
          options: room.currentQuestion.options,
          timeLimitMs: room.settings.roundTimeMs,
          serverStartTs: room.currentQuestion.startedAtServerTs,
          questionNumber: room.currentQuestionNumber,
          totalQuestions: room.settings.totalQuestions,
          isBonus: !!room.currentQuestion.__isBonus,
        }
      : null,
    hasAnsweredCurrent: room.currentQuestion ? room.answers.has(player.sessionToken) : false,
    scoreboard: room.getScoreboard(),
    chat: chatHistoryFor(room, player),
    powerups: player.powerups,
    currentStreak: player.currentStreak,
    bestStreak: player.bestStreak,
    // Se a pessoa recarregou a página no meio de uma pergunta em que já
    // tinha usado 50/50, restaura as mesmas opções escondidas (não sorteia
    // de novo — senão recarregar a página seria um jeito de "reduzir" as
    // opções de novo de graça, ou pior, sortear um par diferente por acaso).
    hiddenIndices: (room.currentQuestion && player.fiftyFiftyActive?.questionId === room.currentQuestion.id)
      ? player.fiftyFiftyActive.hiddenIndices
      : null,
    // Reconexão durante a fase 'reveal': sem isso, quem recarregava a
    // página bem no intervalo entre perguntas caía de volta no lobby (não
    // existia um ramo pra essa fase no cliente) até a próxima pergunta
    // começar. Reaproveita o mesmo formato do broadcast 'question:reveal'
    // (ver buildPerPlayerResults) pra a tela ficar idêntica pra quem nunca
    // saiu.
    reveal: (room.phase === 'reveal' && room.currentQuestion)
      ? { correctIndex: room.currentQuestion.correct_index, perPlayerResults: buildPerPlayerResults(room) }
      : null,
  };
}

function startGame(room) {
  room.startedWithPlayers = room.connectedCount();
  room.usedQuestionIds.clear();
  room.currentQuestionNumber = 0;
  for (const p of room.players.values()) {
    p.score = 0;
    p.correctCount = 0;
    p.wrongCount = 0;
    p.totalDeltaMs = 0;
    p.currentStreak = 0;
    p.bestStreak = 0;
    p.powerups = freshPowerups();
    p.pendingDoublePoints = false;
    p.fiftyFiftyActive = null;
  }
  nextQuestion(room);
}

/**
 * Curva de dificuldade da partida: começa fácil, esquenta no meio, fica
 * difícil no final. A cada 5ª pergunta (5, 10, 15…) é uma "pergunta bônus":
 * sempre difícil e vale pontuação em dobro (ver calculateScore).
 */
function isBonusQuestionNumber(questionNumber) {
  return questionNumber % 5 === 0;
}

function desiredDifficultyFor(questionNumber, totalQuestions) {
  if (isBonusQuestionNumber(questionNumber)) return 'dificil';
  const progress = questionNumber / totalQuestions;
  if (progress <= 0.34) return 'facil';
  if (progress <= 0.67) return 'medio';
  return 'dificil';
}

function pickNextQuestion(room, desiredDifficulty) {
  const buildPool = (respectHistory, respectDifficulty) => {
    const pool = [];
    for (const category of room.settings.categories) {
      const history = respectHistory ? persistentHistory[category] || [] : [];
      for (const q of loadCategory(category)) {
        if (room.usedQuestionIds.has(q.id)) continue; // já saiu nesta partida
        if (respectHistory && history.includes(q.id)) continue; // já saiu recentemente
        if (respectDifficulty && q.difficulty !== desiredDifficulty) continue; // fora da dificuldade desejada
        pool.push(q);
      }
    }
    return pool;
  };

  // Tenta na ordem: (histórico + dificuldade certa) -> (só dificuldade certa) ->
  // (só histórico, qualquer dificuldade) -> (livre). Cada passo relaxa uma
  // restrição para o jogo nunca travar por falta de perguntas naquele nível.
  let pool = buildPool(true, true);
  if (pool.length === 0) pool = buildPool(false, true);
  if (pool.length === 0) pool = buildPool(true, false);
  if (pool.length === 0) pool = buildPool(false, false);
  if (pool.length === 0) return null;
  return pool[crypto.randomInt(pool.length)];
}

function nextQuestion(room) {
  touch(room); // o jogo avançar sozinho também conta como atividade da sala
  if (room.currentQuestionNumber >= room.settings.totalQuestions) {
    return endGame(room);
  }
  const upcomingNumber = room.currentQuestionNumber + 1;
  const desiredDifficulty = desiredDifficultyFor(upcomingNumber, room.settings.totalQuestions);
  const isBonus = isBonusQuestionNumber(upcomingNumber);

  const q = pickNextQuestion(room, desiredDifficulty);
  if (!q) return endGame(room); // banco esgotado antes do total configurado

  room.usedQuestionIds.add(q.id);
  recordQuestionInHistory(q.category, q.id);
  room.currentQuestionNumber += 1;
  room.answers = new Map();
  room.phase = 'question';
  room.currentQuestion = {
    ...q,
    startedAtServerTs: Date.now(),              // *** timestamp de referência, gerado só no servidor ***
    __roomTimeLimitMs: room.settings.roundTimeMs, // congela o limite desta rodada específica
    __isBonus: isBonus,                          // pergunta bônus: pontuação em dobro (ver calculateScore)
  };

  io.to(room.roomId).emit('question:start', {
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    questionText: q.question,
    options: q.options, // NUNCA inclui correct_index
    timeLimitMs: room.settings.roundTimeMs,
    serverStartTs: room.currentQuestion.startedAtServerTs,
    questionNumber: room.currentQuestionNumber,
    totalQuestions: room.settings.totalQuestions,
    isBonus,
  });

  // Estado pessoal de power-ups (contagem de cargas + sequência atual) — só
  // para o próprio jogador, por isso vai por socket individual e não no
  // broadcast acima. Sincroniza no início de toda pergunta (cobre inclusive
  // reconexão: o snapshot de rejoin manda o mesmo formato, ver buildSnapshotFor).
  for (const p of room.players.values()) {
    if (p.connectionStatus === 'connected') {
      io.to(p.socketId).emit('you:state', { powerups: p.powerups, currentStreak: p.currentStreak, bestStreak: p.bestStreak });
    }
  }

  room.questionTimer = setTimeout(() => revealQuestion(room), room.settings.roundTimeMs + ANSWER_NETWORK_GRACE_MS);
}

/**
 * Fonte única da verdade: deltaMs é calculado exclusivamente a partir de
 * timestamps gerados pelo próprio processo Node.js (Date.now()), nunca a
 * partir de qualquer valor vindo do cliente.
 */
function calculateScore(question, chosenIndex, answerReceivedAtServerTs) {
  const timeLimitMs = question.__roomTimeLimitMs || 15000;
  const deltaMs = answerReceivedAtServerTs - question.startedAtServerTs;

  // Aceita até timeLimitMs + a mesma folga de rede que o agendamento do
  // reveal já concede (ver ANSWER_NETWORK_GRACE_MS) — sem isso, uma resposta
  // que chegou dentro do prazo que o servidor realmente esperava era
  // rejeitada só pela latência de quem respondeu, não por ter demorado de
  // verdade pra decidir.
  if (deltaMs < 0 || deltaMs > timeLimitMs + ANSWER_NETWORK_GRACE_MS) {
    return { chosenIndex, deltaMs, correct: false, points: 0 };
  }

  const correct = chosenIndex === question.correct_index;
  if (!correct) return { chosenIndex, deltaMs, correct: false, points: 0 };

  // O bônus de velocidade nunca deve refletir a folga de rede — só ela
  // decide se a resposta ENTRA, não finge que chegou mais rápido do que
  // chegou. Por isso o cálculo do fator usa o delta limitado a timeLimitMs.
  const clampedDeltaMs = Math.min(deltaMs, timeLimitMs);
  const speedFactor = 0.5 + 0.5 * (1 - clampedDeltaMs / timeLimitMs);
  let rawPoints = BASE_POINTS[question.difficulty] * speedFactor;
  if (question.__isBonus) rawPoints *= 2; // pergunta bônus: pontuação em dobro
  return { chosenIndex, deltaMs, correct: true, points: round2(rawPoints) };
}

/**
 * Monta a lista pública de resultados por jogador para a rodada que acabou
 * de ser revelada. Extraído para ser reaproveitado tanto no broadcast do
 * 'question:reveal' quanto no snapshot de reconexão de quem recarrega a
 * página durante a fase 'reveal' (ver buildSnapshotFor) — os dois precisam
 * mostrar exatamente a mesma coisa.
 */
function buildPerPlayerResults(room) {
  return [...room.answers.entries()]
    .filter(([token]) => room.players.has(token))
    .map(([token, r]) => ({
      playerId: room.players.get(token).playerId,
      correct: r.correct,
      points: r.points,
      deltaMs: r.deltaMs,
      doubled: !!r.doubled,
      powerupGranted: r.powerupGranted || null,
      streak: r.streakAfter || 0,
    }));
}

function revealQuestion(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.questionTimer);
  room.phase = 'reveal';

  // Qualquer jogador que não respondeu recebe 0 pontos explicitamente e
  // também conta como "errada" no placar pessoal.
  for (const [token, player] of room.players) {
    if (!room.answers.has(token)) {
      room.answers.set(token, { chosenIndex: null, deltaMs: room.settings.roundTimeMs, correct: false, points: 0, doubled: false, powerupGranted: null, streakAfter: 0 });
      player.wrongCount += 1;
      player.currentStreak = 0;
      player.pendingDoublePoints = false; // não respondeu: qualquer ativação pendente é desperdiçada
    }
    player.fiftyFiftyActive = null; // encerra o efeito visual desta pergunta (respondeu ou não)
  }

  io.to(room.roomId).emit('question:reveal', {
    correctIndex: room.currentQuestion.correct_index,
    perPlayerResults: buildPerPlayerResults(room),
    updatedScoreboard: room.getScoreboard(),
  });

  // Rastreado em room.nextQuestionTimer para poder ser cancelado se a sala
  // esvaziar/for removida durante a pausa do reveal. Sem isso, a partida
  // continuava rodando "fantasma" numa sala já apagada até a última pergunta.
  room.nextQuestionTimer = setTimeout(() => {
    if (rooms.get(room.roomId) !== room) return; // sala removida no meio da pausa
    nextQuestion(room);
  }, REVEAL_PAUSE_MS);
}

function endGame(room) {
  room.phase = 'podium';
  room.currentQuestion = null;
  const isRankedGame = room.startedWithPlayers >= MIN_RANKED_PLAYERS;

  const ranked = [...room.players.values()].sort(compareForRanking);
  const podium = ranked.map((p, i) => {
    const isWinner = i === 0; // 1º lugar, já desempatado deterministicamente por compareForRanking
    // Atualiza o histórico persistente (placar pessoal) deste jogador com o
    // resultado desta partida, e devolve o total acumulado de todos os tempos.
    const allTime = recordGameStatsForPlayer(p, isWinner, isRankedGame);
    return {
      position: i + 1,
      playerId: p.playerId,
      nickname: p.nickname,
      avatar: p.avatar,
      totalScore: round2(p.score),
      correctCount: p.correctCount,
      wrongCount: p.wrongCount,
      avgDeltaMs: p.correctCount > 0 ? Math.round(p.totalDeltaMs / p.correctCount) : null,
      allTimeStats: {
        gamesPlayed: allTime.gamesPlayed,
        wins: allTime.wins,
        losses: allTime.gamesPlayed - allTime.wins,
        correctAnswers: allTime.correctAnswers,
        wrongAnswers: allTime.wrongAnswers,
        totalScore: round2(allTime.totalScore),
      },
    };
  });

  playerStatsWriter.markDirty();

  // Log append-only por jogador/partida: é dele que saem os rankings de
  // 7 e 30 dias (ver leaderboard:get). O de todos os tempos vem de player_stats.
  db.appendGameLog(
    ranked.map((p) => ({
      playerKey: statsKeyForPlayer(p),
      nickname: p.nickname,
      avatar: p.avatar,
      score: round2(p.score),
      correctCount: p.correctCount,
      wrongCount: p.wrongCount,
      isWinner: p === ranked[0],
      ranked: isRankedGame,
    }))
  );
  periodRowsCache.clear(); // o log mudou: rankings de 7/30 dias precisam ser recalculados já (o cliente recarrega ao fim da partida)

  io.to(room.roomId).emit('game_over', {
    podium,
    overallLeaderboard: getOverallLeaderboard(),
    rankedGame: isRankedGame,
    minRankedPlayers: MIN_RANKED_PLAYERS,
  });
  broadcastOverallLeaderboard();
}

function compareForRanking(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.correctCount !== b.correctCount) return b.correctCount - a.correctCount;
  if (a.totalDeltaMs !== b.totalDeltaMs) return a.totalDeltaMs - b.totalDeltaMs;
  return a.joinedAtServerTs - b.joinedAtServerTs; // critério absoluto e determinístico
}

// `ready` resolve quando o servidor já está escutando — útil sobretudo para
// os testes automatizados (tests/), que sobem o servidor com PORT=0 (a porta
// livre é escolhida pelo SO) e precisam saber a porta real antes de conectar
// um client. Em produção, não muda nada: PORT continua vindo do ambiente.
let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });

httpServer.listen(PORT, () => {
  const actualPort = httpServer.address().port;
  console.log(`QuizArena server ouvindo na porta ${actualPort}`);
  resolveReady();
});

/**
 * Encerramento ordenado: grava dados pendentes, fecha as conexões
 * Socket.IO/HTTP e o banco. Usado tanto pelos handlers de SIGTERM/SIGINT
 * (produção/deploy) quanto pelos testes automatizados (tests/), que sobem e
 * derrubam um servidor por arquivo de teste e precisam de um jeito limpo de
 * fazer isso sem `process.exit` (que mataria o test runner).
 */
function shutdown() {
  // Cancela timers de jogo pendentes (pergunta, pausa do reveal, grace de
  // reconexão) antes de fechar o banco — senão um deles pode disparar depois
  // do db.close() e tentar gravar num banco fechado ("database is not open").
  for (const room of rooms.values()) {
    clearTimeout(room.questionTimer);
    clearTimeout(room.nextQuestionTimer);
    for (const player of room.players.values()) {
      if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    }
  }
  rooms.clear();
  historyWriter.flushSync();
  playerStatsWriter.flushSync();
  return new Promise((resolve) => {
    io.close(() => {
      db.close();
      resolve();
    });
  });
}

// Garante que gravações "debounced" pendentes (histórico de perguntas e
// placar geral) não se percam num deploy/restart normal (SIGTERM/SIGINT).
async function gracefulShutdown() {
  console.log('Encerrando: gravando dados pendentes em disco...');
  await shutdown();
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = { app, httpServer, io, ready, shutdown };
