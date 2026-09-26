/* global io */
(() => {
  'use strict';

  // Atalho para getElementById — precisa ficar ANTES de qualquer código que
  // rode no carregamento do script (listeners de login etc.), senão dá
  // "Cannot access '$' before initialization" e o app inteiro trava.
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------
  // Estado local
  // ------------------------------------------------------------------
  const AVATARS = ['💀', '👽', '👻', '🦇', '🕷️', '😈', '🧟', '🧛', '☠️', '🐺', '🦂', '🐈\u200d⬛'];
  const MAX_NICKNAME_LENGTH = 20; // igual ao limite de username do servidor (USERNAME_REGEX / MAX_NICKNAME_LENGTH em server.js)
  const CATEGORY_LABELS = {
    historia: 'História', geografia: 'Geografia', cinema: 'Cinema', artes: 'Artes',
    musica: 'Música', esportes: 'Esportes',
    religiao: 'Religião',
    animes: 'Animes', desenhos: 'Desenhos', ciencia: 'Ciência', tecnologia: 'Tecnologia', literatura: 'Literatura',
  };
  const OPTION_KEYS = ['a', 'b', 'c', 'd'];
  const OPTION_SHAPES = { a: '▲', b: '◆', c: '●', d: '■' };
  // Rótulos exibidos no aviso de power-up ganho na revelação (mesmos ícones
  // usados nos botões de power-up, ver #btn-powerup-fifty/#btn-powerup-double).
  const POWERUP_EARNED_LABELS = { fiftyFifty: '🎯 50/50', doublePoints: '⚡ Pontos em Dobro' };

  // Identificador de dispositivo: persiste em localStorage (sobrevive a
  // recarregar a página E a entrar em novas salas, diferente do sessionToken,
  // que é regenerado a cada sala). Usado só para o placar geral de todos os
  // tempos, nunca para autenticação/autorização — isso continua sendo
  // exclusivamente o sessionToken.
  function getOrCreateDeviceId() {
    try {
      let id = localStorage.getItem('qa_deviceId');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        localStorage.setItem('qa_deviceId', id);
      }
      return id;
    } catch {
      return null; // localStorage indisponível (modo privado restrito etc.) — servidor cai para o nickname
    }
  }

  // authToken de CONTA (login) — separado do sessionToken de sala.
  // "Manter conectado neste aparelho" (checkbox marcada por padrão) decide
  // ONDE o token fica: localStorage sobrevive a fechar o navegador (é o que
  // "lembra" o login); sessionStorage some ao fechar a aba — melhor em
  // computador compartilhado. Sempre lê os dois: só um deles vai ter valor
  // por vez (login sempre limpa o outro), mas cobre a troca de escolha entre
  // sessões.
  function getStoredAuthToken() {
    try { return localStorage.getItem('qa_authToken') || sessionStorage.getItem('qa_authToken') || null; } catch { return null; }
  }
  /** Onde o token atual já está guardado — usado pra não promover um token "só desta aba" pra permanente a cada auth:resume. */
  function isAuthTokenRemembered() {
    try { return !!localStorage.getItem('qa_authToken'); } catch { return true; }
  }
  function persistAuthToken(token, remember) {
    try {
      localStorage.removeItem('qa_authToken');
      sessionStorage.removeItem('qa_authToken');
      if (token) {
        if (remember) localStorage.setItem('qa_authToken', token);
        else sessionStorage.setItem('qa_authToken', token);
      }
    } catch { /* localStorage/sessionStorage indisponível — login ainda funciona nesta aba, só não persiste */ }
  }

  const state = {
    socket: null,
    deviceId: getOrCreateDeviceId(),
    sessionToken: sessionStorage.getItem('qa_sessionToken') || null,
    roomId: sessionStorage.getItem('qa_roomId') || null,

    // Conta (login): nickname/avatar da sala vêm dela, não são mais digitados
    // na tela de criar/entrar em sala.
    authToken: getStoredAuthToken(),
    userId: null, // id da conta logada (não persiste — só usado em memória para "checar usuário disponível" ignorando a própria conta)
    // Convidado: joga sem conta (só apelido + avatar, válidos nesta aba). Fica
    // em sessionStorage de propósito — fechar a aba encerra o modo convidado.
    isGuest: sessionStorage.getItem('qa_guest') === '1',
    username: sessionStorage.getItem('qa_username') || '',
    nickname: sessionStorage.getItem('qa_username') || '',
    avatar: sessionStorage.getItem('qa_avatar') || AVATARS[0],

    isHost: false,
    playerId: null,      // identificador PÚBLICO deste jogador (não é credencial)
    hostPlayerId: null,
    settings: null,
    selectedCategories: new Set(),
    currentQuestion: null,
    countdownRAF: null,
    hasAnswered: false,
    clockOffsetMs: null, // relógio local menos relógio do servidor, estimado via ping_check (ver startCountdown)
    powerups: { fiftyFifty: 0, doublePoints: 0 }, // cargas disponíveis agora (ver 'you:state')
    currentStreak: 0,
    bestStreak: 0,
    fiftyFiftyHiddenIndices: null, // não-nulo enquanto o 50/50 estiver ativo NESTA pergunta
    doublePointsArmed: false,      // pontos em dobro ativado, aguardando a resposta desta pergunta
  };

  // ------------------------------------------------------------------
  // Status de conexão: os botões que dependem do servidor (criar/entrar em sala) ficam desabilitados até o socket conectar
  // de verdade — em vez de deixar clicar e travar em silêncio (ex.: no
  // Render free tier, o servidor "dorme" após inatividade e pode levar até
  // ~1 minuto pra responder na primeira requisição).
  // ------------------------------------------------------------------
  let wakingUpHintTimer = null;
  let wakeupHintShown = false;

  function setServerActionsEnabled(enabled) {
    ['btn-create-room', 'btn-join-room', 'btn-login', 'btn-register', 'btn-forgot-submit', 'btn-profile-save', 'btn-password-save'].forEach((id) => {
      $(id).disabled = !enabled;
    });
  }

  function showConnHint(text, state_) {
    [$('conn-status-entry'), $('auth-conn-status')].filter(Boolean).forEach((el) => {
      el.hidden = false;
      el.dataset.state = state_;
      el.textContent = text;
    });
  }

  function hideConnHints() {
    [$('conn-status-entry'), $('auth-conn-status')].filter(Boolean).forEach((el) => {
      el.hidden = true;
      el.textContent = '';
    });
  }

  function updateConnStatus(kind) {
    if (kind === 'connecting') {
      setServerActionsEnabled(false);
      // Só troca pro texto "básico" se ainda não escalamos pro aviso de
      // "pode demorar" — assim tentativas de reconexão repetidas (comum
      // durante o wake-up do servidor) não ficam resetando a mensagem.
      if (!wakeupHintShown) showConnHint('Conectando ao servidor…', 'info');
      if (!wakingUpHintTimer) {
        wakingUpHintTimer = setTimeout(() => {
          wakeupHintShown = true;
          showConnHint('Ainda conectando… se o servidor ficou inativo por um tempo, ele pode levar até 1 minuto pra "acordar". Aguarde, não precisa recarregar a página.', 'info');
        }, 5000);
      }
    } else if (kind === 'connected') {
      clearTimeout(wakingUpHintTimer);
      wakingUpHintTimer = null;
      wakeupHintShown = false;
      setServerActionsEnabled(true);
      hideConnHints();
    } else if (kind === 'reconnecting') {
      setServerActionsEnabled(false);
      showConnHint('Conexão perdida. Tentando reconectar…', 'error');
    }
  }

  /**
   * Emite um evento e garante que o callback SEMPRE roda, mesmo se o
   * servidor nunca responder (conexão caiu no meio do caminho, etc.) — sem
   * isso, um clique em "Criar conta"/"Entrar"/"Criar sala" podia ficar
   * preso pra sempre sem nenhum aviso pra quem está usando.
   */
  function emitWithTimeout(event, payload, timeoutMs, cb) {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cb({ ok: false, error: 'O servidor não respondeu a tempo. Verifique sua conexão e tente novamente.' });
    }, timeoutMs);
    state.socket.emit(event, payload, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cb(res);
    });
  }

  // ------------------------------------------------------------------
  // Elementos
  // ------------------------------------------------------------------
  const screens = {
    login: $('screen-login'),
    entry: $('screen-entry'),
    profile: $('screen-profile'),
    password: $('screen-password'),
    lobby: $('screen-lobby'),
    question: $('screen-question'),
    reveal: $('screen-reveal'),
    podium: $('screen-podium'),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => el.setAttribute('data-active', key === name ? 'true' : 'false'));
    updateChatVisibility(name);
    if (name === 'entry' || name === 'podium') refreshLeaderboards(); // função hoisted; sem socket conectado, não faz nada
  }

  // ------------------------------------------------------------------
  // Chat da sala (disponível no lobby, durante as perguntas, na revelação e no pódio)
  // ------------------------------------------------------------------
  const CHAT_SCREENS = new Set(['lobby', 'question', 'reveal', 'podium']);
  const CHAT_DOM_LIMIT = 100;
  const chat = { open: false, unread: 0 };

  function updateChatVisibility(screenName) {
    const inRoom = CHAT_SCREENS.has(screenName);
    $('chat-toggle').hidden = !inRoom || chat.open;
    if (!inRoom) setChatOpen(false);
  }

  function setChatOpen(open) {
    chat.open = open;
    document.body.classList.toggle('chat-open', open); // em telas largas o conteúdo abre espaço pro painel
    $('chat-panel').hidden = !open;
    $('chat-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      $('chat-toggle').hidden = true;
      chat.unread = 0;
      renderChatBadge();
      scrollChatToBottom(true);
      $('chat-input').focus();
    } else {
      // volta a mostrar o botão se ainda estamos numa tela com chat
      const active = Object.entries(screens).find(([, el]) => el.getAttribute('data-active') === 'true');
      $('chat-toggle').hidden = !(active && CHAT_SCREENS.has(active[0]));
    }
  }

  function renderChatBadge() {
    const badge = $('chat-badge');
    badge.hidden = chat.unread === 0;
    badge.textContent = chat.unread > 9 ? '9+' : String(chat.unread);
    $('chat-toggle').setAttribute('aria-label', chat.unread > 0 ? `Abrir chat da sala (${chat.unread} novas)` : 'Abrir chat da sala');
  }

  function scrollChatToBottom(force) {
    const list = $('chat-messages');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (force || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function appendChatMessage(msg, { countUnread }) {
    const list = $('chat-messages');
    const li = document.createElement('li');
    li.className = 'chat-msg' + (msg.mine ? ' chat-msg--mine' : '');

    const meta = document.createElement('div');
    meta.className = 'chat-msg-meta';
    const name = document.createElement('span');
    name.className = 'chat-msg-name';
    name.textContent = `${msg.avatar || ''} ${msg.nickname || ''}`.trim();
    const time = document.createElement('span');
    time.textContent = new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    meta.append(name, time);

    const text = document.createElement('p');
    text.className = 'chat-msg-text';
    text.textContent = msg.text; // textContent: HTML digitado por outros jogadores nunca é interpretado

    li.append(meta, text);
    const stick = msg.mine; // minhas mensagens sempre rolam até o fim
    const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(li);
    while (list.children.length > CHAT_DOM_LIMIT) list.removeChild(list.firstChild);
    $('chat-empty').hidden = true;

    if (chat.open) scrollChatToBottom(stick || wasNearBottom);
    else if (countUnread && !msg.mine) { chat.unread += 1; renderChatBadge(); }
  }

  /** Linha de aviso do sistema (ex.: mensagem censurada) — centralizada, sem autor. */
  function appendChatNotice(notice) {
    const list = $('chat-messages');
    const li = document.createElement('li');
    li.className = 'chat-notice';
    li.textContent = notice.text; // textContent: o apelido vem de outro jogador
    const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(li);
    while (list.children.length > CHAT_DOM_LIMIT) list.removeChild(list.firstChild);
    $('chat-empty').hidden = true;
    if (chat.open) scrollChatToBottom(wasNearBottom);
    else { chat.unread += 1; renderChatBadge(); }
  }

  function renderChatHistory(messages) {
    $('chat-messages').innerHTML = '';
    $('chat-empty').hidden = false;
    (Array.isArray(messages) ? messages : []).forEach((m) => appendChatMessage(m, { countUnread: false }));
    scrollChatToBottom(true);
  }

  function clearChat() {
    $('chat-messages').innerHTML = '';
    $('chat-empty').hidden = false;
    $('chat-error').textContent = '';
    $('chat-input').value = '';
    chat.unread = 0;
    renderChatBadge();
    setChatOpen(false);
    $('chat-toggle').hidden = true;
  }

  function sendChatMessage() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    $('chat-error').textContent = '';
    if (!state.socket || !state.socket.connected || !state.roomId || !state.sessionToken) {
      $('chat-error').textContent = 'Sem conexão no momento. Tente de novo em instantes.';
      return;
    }
    $('chat-send').disabled = true;
    emitWithTimeout('chat:send', { roomId: state.roomId, sessionToken: state.sessionToken, text }, 6000, (res) => {
      $('chat-send').disabled = false;
      if (res && res.ok) {
        input.value = '';
        input.focus();
        return;
      }
      if (res && res.reason === 'CENSORED') { input.value = ''; input.focus(); } // foi "enviada" e barrada
      const messages = {
        RATE_LIMIT: 'Calma! Você está enviando mensagens rápido demais.',
        NOT_IN_ROOM: 'Você não está mais nesta sala.',
        EMPTY: 'Escreva alguma coisa antes de enviar.',
        CENSORED: 'Mensagem censurada: não vale dar a resposta da pergunta!',
      };
      $('chat-error').textContent = messages[res && res.reason] || (res && res.error) || 'Não foi possível enviar a mensagem.';
    });
  }

  $('chat-toggle').addEventListener('click', () => setChatOpen(true));
  $('chat-close').addEventListener('click', () => setChatOpen(false));
  $('chat-send').addEventListener('click', sendChatMessage);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendChatMessage(); }
    else if (e.key === 'Escape') setChatOpen(false);
  });

  // ------------------------------------------------------------------
  // Login de conta — tela própria, separada da tela de criar/entrar em sala.
  // ------------------------------------------------------------------
  let registerAvatar = AVATARS[0];
  let guestAvatar = AVATARS[0];
  let profileAvatar = AVATARS[0];
  let pendingJoinCode = null; // código de convite (?join=XXXX) visto antes de logar
  let pendingRecoveryContinue = null; // o que fazer quando a pessoa confirma que anotou o código

  // Mostra/oculta o texto de todo <input> com um .password-toggle do lado —
  // um único listener delegado cobre login, cadastro, esqueci-senha e trocar
  // senha, sem precisar repetir o código em cada formulário.
  document.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.getAttribute('data-target'));
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
      btn.textContent = showing ? '👁️' : '🙈';
    });
  });

  /** Escreve a mensagem de erro embaixo do campo `fieldId` e leva o foco pra ele. */
  function setFieldError(fieldId, message) {
    const errEl = $(`${fieldId}-error`);
    if (errEl) errEl.textContent = message || '';
    if (message) $(fieldId)?.focus();
  }
  /** Limpa os erros de uma lista de campos de uma vez (início de cada submit). */
  function clearFieldErrors(fieldIds) {
    fieldIds.forEach((id) => { const el = $(`${id}-error`); if (el) el.textContent = ''; });
  }

  /** Desenha uma grade de avatares em `gridId`; `onPick` recebe o emoji escolhido. */
  function renderAvatarGrid(gridId, selected, onPick) {
    const grid = $(gridId);
    grid.innerHTML = '';
    AVATARS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-option';
      btn.textContent = emoji;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(emoji === selected));
      btn.setAttribute('aria-label', `Avatar ${emoji}`);
      btn.addEventListener('click', () => {
        onPick(emoji);
        [...grid.children].forEach((c) => c.setAttribute('aria-checked', String(c === btn)));
      });
      grid.appendChild(btn);
    });
  }

  function setAuthTab(tab) {
    const isLogin = tab === 'login';
    const isRegister = tab === 'register';
    const isGuestPane = tab === 'guest';
    const isForgotPane = tab === 'forgot';
    $('tab-login').setAttribute('data-active', String(isLogin));
    $('tab-login').setAttribute('aria-selected', String(isLogin));
    $('tab-register').setAttribute('data-active', String(isRegister));
    $('tab-register').setAttribute('aria-selected', String(isRegister));
    $('form-login').setAttribute('data-active', String(isLogin));
    $('form-login').hidden = !isLogin;
    $('form-register').setAttribute('data-active', String(isRegister));
    $('form-register').hidden = !isRegister;
    $('form-guest').setAttribute('data-active', String(isGuestPane));
    $('form-guest').hidden = !isGuestPane;
    $('form-forgot').setAttribute('data-active', String(isForgotPane));
    $('form-forgot').hidden = !isForgotPane;
    // Abas e "jogar sem login" somem enquanto qualquer painel secundário
    // (convidado ou esqueci-senha) está aberto — só um formulário por vez.
    const showTabsRow = !isGuestPane && !isForgotPane;
    $('tab-login').closest('.auth-tabs').hidden = !showTabsRow;
    $('guest-entry-block').hidden = !showTabsRow;
    $('auth-error').textContent = '';
  }
  $('tab-login').addEventListener('click', () => setAuthTab('login'));
  $('tab-register').addEventListener('click', () => setAuthTab('register'));
  $('btn-forgot-open').addEventListener('click', () => {
    $('forgot-username').value = $('login-username').value.trim();
    clearFieldErrors(['forgot-code', 'forgot-password']);
    setAuthTab('forgot');
  });
  $('btn-forgot-back').addEventListener('click', () => setAuthTab('login'));

  function renderAccountBadge() {
    $('account-avatar').textContent = state.avatar;
    const nameEl = $('account-username');
    nameEl.textContent = state.username;
    if (state.isGuest) {
      const tag = document.createElement('span');
      tag.className = 'account-guest-tag';
      tag.textContent = 'convidado';
      nameEl.appendChild(tag);
    }
    // Editar perfil / trocar senha / sair de todos os aparelhos só fazem
    // sentido para quem tem conta de verdade — convidado não tem nada disso.
    $('account-links').hidden = state.isGuest;
  }

  /** Mostra o código de recuperação em tela cheia; `onContinue` roda quando a pessoa confirma que anotou. */
  function showRecoveryReveal(code, onContinue) {
    $('recovery-code-text').textContent = code;
    $('recovery-reveal').hidden = false;
    $('login-main-card').hidden = true;
    pendingRecoveryContinue = onContinue;
  }
  function hideRecoveryReveal() {
    $('recovery-reveal').hidden = true;
    $('login-main-card').hidden = false;
  }
  $('btn-recovery-continue').addEventListener('click', () => {
    hideRecoveryReveal();
    const fn = pendingRecoveryContinue;
    pendingRecoveryContinue = null;
    if (fn) fn();
  });
  $('btn-copy-recovery').addEventListener('click', async () => {
    const code = $('recovery-code-text').textContent;
    try {
      await navigator.clipboard.writeText(code);
      $('btn-copy-recovery').textContent = 'Copiado!';
      setTimeout(() => ($('btn-copy-recovery').textContent = 'Copiar código'), 1500);
    } catch {
      prompt('Copie o código de recuperação:', code);
    }
  });

  /** Chamado tanto após login quanto após cadastro quanto após auth:resume quanto após redefinir senha. */
  function onAuthSuccess({ authToken, userId, username, avatar, remember = true }) {
    state.authToken = authToken;
    state.userId = userId || state.userId;
    state.isGuest = false;
    sessionStorage.removeItem('qa_guest');
    state.username = username;
    state.nickname = username; // nickname usado nas salas = username da conta
    state.avatar = avatar;
    persistAuthToken(authToken, remember);
    sessionStorage.setItem('qa_username', username);
    sessionStorage.setItem('qa_avatar', avatar);
    renderAccountBadge();
    $('auth-error').textContent = '';
    goToEntryScreen();
  }

  function goToEntryScreen() {
    if (pendingJoinCode) {
      $('room-code-input').value = pendingJoinCode;
      pendingJoinCode = null;
    }
    showScreen('entry');
  }

  /**
   * Quem chega por link de convite (?join=XXXX) quer entrar na partida, não
   * criar conta — mostra o aviso da sala e faz "Jogar sem login" virar o
   * botão principal (em vez do secundário) nessa situação.
   */
  function applyInviteEmphasis(roomCode) {
    $('invite-room-code').textContent = roomCode;
    $('invite-banner').hidden = false;
    const guestBtn = $('btn-guest-open');
    guestBtn.classList.remove('btn-secondary');
    guestBtn.classList.add('btn-primary');
  }

  $('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const remember = $('login-remember').checked;
    $('auth-error').textContent = '';
    clearFieldErrors(['login-username', 'login-password']);
    if (!username) return setFieldError('login-username', 'Digite seu usuário.');
    if (!password) return setFieldError('login-password', 'Digite sua senha.');
    if (!state.socket || !state.socket.connected) {
      $('auth-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.';
      return;
    }
    $('btn-login').disabled = true;
    emitWithTimeout('auth:login', { username, password }, 12000, (res) => {
      $('btn-login').disabled = false;
      if (!res.ok) {
        if (res.reason === 'RATE_LIMIT') { $('auth-error').textContent = res.error || 'Muitas tentativas erradas. Tente de novo mais tarde.'; return; }
        setFieldError('login-password', res.reason === 'INVALID_CREDENTIALS' ? 'Usuário ou senha incorretos.' : (res.error || 'Não foi possível entrar.'));
        return;
      }
      $('login-password').value = '';
      onAuthSuccess({ ...res, remember });
    });
  });

  // Checagem de usuário disponível enquanto digita — só feedback visual, a
  // validação de verdade sempre acontece no servidor no submit (ver
  // makeUsernameAvailabilityChecker: usado aqui e na edição de perfil).
  function makeUsernameAvailabilityChecker({ inputId, hintId, excludeUserId }) {
    let debounceTimer = null;
    $(inputId).addEventListener('input', () => {
      const hint = $(hintId);
      const username = $(inputId).value.trim();
      clearTimeout(debounceTimer);
      if (!username) { hint.textContent = ''; hint.removeAttribute('data-state'); return; }
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        hint.textContent = '3 a 20 letras, números ou "_".';
        hint.removeAttribute('data-state');
        return;
      }
      hint.textContent = 'Verificando…';
      hint.removeAttribute('data-state');
      debounceTimer = setTimeout(() => {
        if (!state.socket || !state.socket.connected) return;
        state.socket.emit('auth:check_username', { username, excludeUserId: excludeUserId?.() }, (res) => {
          if ($(inputId).value.trim() !== username) return; // a pessoa já digitou outra coisa; resposta ficou velha
          if (!res || !res.ok) { hint.textContent = ''; hint.removeAttribute('data-state'); return; }
          hint.textContent = res.available ? 'Usuário disponível ✅' : 'Esse usuário já está em uso.';
          hint.setAttribute('data-state', res.available ? 'ok' : 'taken');
        });
      }, 400);
    });
  }
  makeUsernameAvailabilityChecker({ inputId: 'register-username', hintId: 'register-username-hint' });

  $('form-register').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('register-username').value.trim();
    const password = $('register-password').value;
    const remember = $('register-remember').checked;
    $('auth-error').textContent = '';
    clearFieldErrors(['register-username', 'register-password']);
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return setFieldError('register-username', 'Usuário deve ter de 3 a 20 letras, números ou "_".');
    }
    if (password.length < 6) {
      return setFieldError('register-password', 'A senha precisa ter pelo menos 6 caracteres.');
    }
    if (!state.socket || !state.socket.connected) {
      $('auth-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.';
      return;
    }
    $('btn-register').disabled = true;
    emitWithTimeout('auth:register', { username, password, avatar: registerAvatar }, 12000, (res) => {
      $('btn-register').disabled = false;
      if (!res.ok) {
        const fieldByReason = { USERNAME_TAKEN: 'register-username', INVALID_USERNAME: 'register-username', INVALID_PASSWORD: 'register-password' };
        const messages = {
          USERNAME_TAKEN: 'Esse usuário já existe. Escolha outro.',
          INVALID_USERNAME: 'Usuário inválido (3 a 20 letras, números ou "_").',
          INVALID_PASSWORD: 'Senha inválida (mínimo 6 caracteres).',
        };
        const field = fieldByReason[res.reason];
        if (field) setFieldError(field, messages[res.reason]);
        else $('auth-error').textContent = res.error || 'Não foi possível criar a conta.';
        return;
      }
      $('register-password').value = '';
      $('register-username-hint').textContent = '';
      // Mostra o código de recuperação antes de seguir para a tela de entrada
      // — é a única vez que ele aparece.
      showRecoveryReveal(res.recoveryCode, () => onAuthSuccess({ ...res, remember }));
    });
  });

  $('form-forgot').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('forgot-username').value.trim();
    const recoveryCode = $('forgot-code').value.trim();
    const newPassword = $('forgot-password').value;
    $('auth-error').textContent = '';
    clearFieldErrors(['forgot-code', 'forgot-password']);
    if (!username || !recoveryCode) return setFieldError('forgot-code', 'Preencha usuário e código de recuperação.');
    if (newPassword.length < 6) return setFieldError('forgot-password', 'A nova senha precisa ter pelo menos 6 caracteres.');
    if (!state.socket || !state.socket.connected) {
      $('auth-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.';
      return;
    }
    $('btn-forgot-submit').disabled = true;
    emitWithTimeout('auth:forgot_password', { username, recoveryCode, newPassword }, 12000, (res) => {
      $('btn-forgot-submit').disabled = false;
      if (!res.ok) {
        if (res.reason === 'RATE_LIMIT') { $('auth-error').textContent = res.error || 'Muitas tentativas erradas. Tente de novo mais tarde.'; return; }
        if (res.reason === 'INVALID_PASSWORD') return setFieldError('forgot-password', 'Senha inválida (mínimo 6 caracteres).');
        setFieldError('forgot-code', 'Usuário ou código de recuperação incorretos.');
        return;
      }
      $('forgot-password').value = '';
      // Redefinir a senha já loga a pessoa (o servidor manda um authToken
      // novo) — "manter conectado" segue marcado por padrão aqui, já que
      // quem está redefinindo a senha normalmente quer voltar a jogar.
      showRecoveryReveal(res.recoveryCode, () => onAuthSuccess({ ...res, remember: true }));
    });
  });

  // ------------------------------------------------------------------
  // Jogar sem login (convidado): só apelido + avatar, tudo local. O servidor
  // não exige conta para criar/entrar em sala — o login sempre foi só uma
  // etapa da interface — então aqui basta preencher nickname/avatar do estado.
  // ------------------------------------------------------------------
  function readGuestPrefs() {
    try {
      return {
        nickname: localStorage.getItem('qa_guestNick') || '',
        avatar: localStorage.getItem('qa_guestAvatar') || '',
      };
    } catch { return { nickname: '', avatar: '' }; }
  }

  function openGuestPane() {
    const prefs = readGuestPrefs(); // repõe o último apelido/avatar usados neste navegador
    if (prefs.nickname && !$('guest-nickname').value) $('guest-nickname').value = prefs.nickname;
    if (AVATARS.includes(prefs.avatar)) guestAvatar = prefs.avatar;
    renderAvatarGrid('guest-avatar-grid', guestAvatar, (emoji) => { guestAvatar = emoji; });
    setAuthTab('guest');
    $('guest-nickname').focus();
  }

  $('btn-guest-open').addEventListener('click', openGuestPane);
  $('btn-guest-back').addEventListener('click', () => setAuthTab('login'));

  $('form-guest').addEventListener('submit', (e) => {
    e.preventDefault();
    // Mesma limpeza do servidor (sem < >, máx. MAX_NICKNAME_LENGTH), para o
    // que aparece aqui ser exatamente o que os outros jogadores vão ver.
    const nickname = $('guest-nickname').value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NICKNAME_LENGTH);
    clearFieldErrors(['guest-nickname']);
    if (nickname.length < 2) {
      setFieldError('guest-nickname', 'Escolha um apelido com pelo menos 2 caracteres.');
      return;
    }
    $('auth-error').textContent = '';
    $('guest-nickname').value = nickname; // mostra o apelido já limpo, igual ao que os outros vão ver
    state.isGuest = true;
    state.username = nickname;
    state.nickname = nickname;
    state.avatar = guestAvatar;
    sessionStorage.setItem('qa_guest', '1');
    sessionStorage.setItem('qa_username', nickname);
    sessionStorage.setItem('qa_avatar', guestAvatar);
    try {
      localStorage.setItem('qa_guestNick', nickname);
      localStorage.setItem('qa_guestAvatar', guestAvatar);
    } catch { /* sem localStorage: só não lembra o apelido na próxima vez */ }
    renderAccountBadge();
    goToEntryScreen();
  });

  function leaveGuestMode() {
    state.isGuest = false;
    state.username = '';
    state.nickname = '';
    sessionStorage.removeItem('qa_guest');
    sessionStorage.removeItem('qa_username');
    clearSession();
    $('login-username').value = '';
    $('login-password').value = '';
    setAuthTab('login');
    showScreen('login');
  }

  $('btn-logout').addEventListener('click', () => {
    if (state.isGuest) return leaveGuestMode(); // convidado não tem token de conta pra invalidar
    const token = state.authToken;
    if (state.socket && state.socket.connected && token) {
      state.socket.emit('auth:logout', { authToken: token });
    }
    state.authToken = null;
    state.userId = null;
    state.username = '';
    persistAuthToken(null);
    sessionStorage.removeItem('qa_username');
    clearSession(); // por segurança, também sai de qualquer sala aberta nesta aba
    $('login-username').value = '';
    $('login-password').value = '';
    setAuthTab('login');
    showScreen('login');
  });

  $('btn-logout-all').addEventListener('click', () => {
    if (!window.confirm('Isso desconecta sua conta de todos os aparelhos onde ela está logada, incluindo este. Continuar?')) return;
    const token = state.authToken;
    const finish = () => {
      state.authToken = null;
      state.userId = null;
      state.username = '';
      persistAuthToken(null);
      sessionStorage.removeItem('qa_username');
      clearSession();
      setAuthTab('login');
      showScreen('login');
    };
    if (state.socket && state.socket.connected && token) {
      emitWithTimeout('auth:logout_all', { authToken: token }, 8000, () => finish());
    } else {
      finish();
    }
  });

  // ------------------------------------------------------------------
  // Tela de entrada (criar/entrar em sala) — já logado, usa a conta atual
  // ------------------------------------------------------------------
  /** authToken enviado ao criar/entrar em sala: só de quem está logado (convidado não manda). */
  function roomAuthToken() {
    return !state.isGuest && state.authToken ? state.authToken : null;
  }

  /** O servidor não reconheceu mais o login (token expirado/removido): volta para a tela de login. */
  function handleAuthExpired() {
    state.authToken = null;
    state.userId = null;
    state.username = '';
    persistAuthToken(null);
    sessionStorage.removeItem('qa_username');
    setAuthTab('login');
    showScreen('login');
    $('auth-error').textContent = 'Sua sessão expirou. Entre novamente.';
  }

  // ------------------------------------------------------------------
  // Editar perfil (usuário + avatar) — só para quem tem conta.
  // ------------------------------------------------------------------
  $('btn-open-profile').addEventListener('click', () => {
    $('profile-username').value = state.username;
    profileAvatar = state.avatar;
    renderAvatarGrid('profile-avatar-grid', profileAvatar, (emoji) => { profileAvatar = emoji; });
    $('profile-username-hint').textContent = '';
    $('profile-error').textContent = '';
    clearFieldErrors(['profile-username']);
    showScreen('profile');
  });
  $('btn-profile-back').addEventListener('click', () => showScreen('entry'));

  makeUsernameAvailabilityChecker({
    inputId: 'profile-username', hintId: 'profile-username-hint',
    excludeUserId: () => state.userId, // não acusa "já em uso" pro próprio username atual
  });

  $('form-profile').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('profile-username').value.trim();
    $('profile-error').textContent = '';
    clearFieldErrors(['profile-username']);
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return setFieldError('profile-username', 'Usuário deve ter de 3 a 20 letras, números ou "_".');
    }
    if (!state.socket || !state.socket.connected) {
      $('profile-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.';
      return;
    }
    $('btn-profile-save').disabled = true;
    emitWithTimeout('auth:update_profile', { authToken: state.authToken, username, avatar: profileAvatar }, 12000, (res) => {
      $('btn-profile-save').disabled = false;
      if (!res.ok) {
        if (res.reason === 'AUTH_EXPIRED' || res.reason === 'INVALID_TOKEN' || res.reason === 'NO_TOKEN') return handleAuthExpired();
        const fieldByReason = { USERNAME_TAKEN: 'profile-username', INVALID_USERNAME: 'profile-username' };
        const messages = { USERNAME_TAKEN: 'Esse usuário já existe. Escolha outro.', INVALID_USERNAME: 'Usuário inválido (3 a 20 letras, números ou "_").' };
        const field = fieldByReason[res.reason];
        if (field) setFieldError(field, messages[res.reason]);
        else $('profile-error').textContent = res.error || 'Não foi possível salvar o perfil.';
        return;
      }
      state.username = res.username;
      state.nickname = res.username;
      state.avatar = res.avatar;
      sessionStorage.setItem('qa_username', res.username);
      sessionStorage.setItem('qa_avatar', res.avatar);
      renderAccountBadge();
      showScreen('entry');
    });
  });

  // ------------------------------------------------------------------
  // Trocar senha — só para quem tem conta; exige a senha atual.
  // ------------------------------------------------------------------
  $('btn-open-password').addEventListener('click', () => {
    $('current-password').value = '';
    $('new-password').value = '';
    $('password-error').textContent = '';
    clearFieldErrors(['current-password', 'new-password']);
    showScreen('password');
  });
  $('btn-password-back').addEventListener('click', () => showScreen('entry'));

  $('form-change-password').addEventListener('submit', (e) => {
    e.preventDefault();
    const currentPassword = $('current-password').value;
    const newPassword = $('new-password').value;
    $('password-error').textContent = '';
    clearFieldErrors(['current-password', 'new-password']);
    if (!currentPassword) return setFieldError('current-password', 'Digite sua senha atual.');
    if (newPassword.length < 6) return setFieldError('new-password', 'A nova senha precisa ter pelo menos 6 caracteres.');
    if (!state.socket || !state.socket.connected) {
      $('password-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.';
      return;
    }
    $('btn-password-save').disabled = true;
    emitWithTimeout('auth:change_password', { authToken: state.authToken, currentPassword, newPassword }, 12000, (res) => {
      $('btn-password-save').disabled = false;
      if (!res.ok) {
        if (res.reason === 'AUTH_EXPIRED' || res.reason === 'INVALID_TOKEN' || res.reason === 'NO_TOKEN') return handleAuthExpired();
        if (res.reason === 'INVALID_CURRENT_PASSWORD') return setFieldError('current-password', 'Senha atual incorreta.');
        if (res.reason === 'INVALID_PASSWORD') return setFieldError('new-password', 'Senha inválida (mínimo 6 caracteres).');
        $('password-error').textContent = res.error || 'Não foi possível trocar a senha.';
        return;
      }
      $('current-password').value = '';
      $('new-password').value = '';
      showScreen('entry');
    });
  });

  function persistSession(roomId, sessionToken, playerId) {
    state.roomId = roomId;
    state.sessionToken = sessionToken;
    state.playerId = playerId || null;
    sessionStorage.setItem('qa_roomId', roomId);
    sessionStorage.setItem('qa_sessionToken', sessionToken);
  }

  function clearSession() {
    clearChat();
    state.roomId = null;
    state.sessionToken = null;
    state.playerId = null;
    state.hostPlayerId = null;
    sessionStorage.removeItem('qa_roomId');
    sessionStorage.removeItem('qa_sessionToken');
  }

  $('btn-create-room').addEventListener('click', () => {
    $('entry-error').textContent = '';
    if (!state.socket || !state.socket.connected) {
      return ($('entry-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.');
    }
    $('btn-create-room').disabled = true;
    emitWithTimeout('create_room', { nickname: state.nickname, avatar: state.avatar, deviceId: state.deviceId, authToken: roomAuthToken() }, 12000, (res) => {
      $('btn-create-room').disabled = false;
      if (!res.ok) {
        if (res.reason === 'AUTH_EXPIRED') return handleAuthExpired();
        const messages = {
          SERVER_FULL: 'O servidor está com muitas salas abertas agora. Tente de novo em alguns minutos.',
          TOO_MANY_ROOMS_FOR_IP: 'Você já tem várias salas abertas ao mesmo tempo. Feche alguma antes de criar outra.',
          RATE_LIMIT: 'Muitas salas criadas em pouco tempo. Espere um pouco e tente de novo.',
          NICKNAME_RESERVED: 'Esse apelido pertence a uma conta cadastrada. Escolha outro ou entre com a conta (botão "Sair" para trocar).',
        };
        $('entry-error').textContent = messages[res.reason] || res.error || 'Não foi possível criar a sala. Tente novamente.';
        return;
      }
      persistSession(res.roomId, res.sessionToken, res.playerId);
      showScreen('lobby');
    });
  });

  // Sair do lobby e voltar ao menu inicial (tela de criar/entrar em sala).
  $('btn-leave-room').addEventListener('click', () => {
    const others = state.playerCount > 1;
    if (state.isHost && others && !window.confirm('Você é o host. Se sair, a liderança passa para outro jogador. Sair mesmo?')) return;

    const { roomId, sessionToken } = state;
    const goToMenu = () => {
      clearSession();
      $('entry-error').textContent = '';
      showScreen('entry');
    };
    if (state.socket && state.socket.connected && roomId && sessionToken) {
      // Segue para o menu mesmo se o servidor não responder: sem conexão, o
      // grace period de reconexão remove a pessoa da sala sozinho.
      emitWithTimeout('leave_room', { roomId, sessionToken }, 4000, (res) => {
        if (res && res.ok === false && res.reason === 'GAME_ALREADY_STARTED') {
          return window.alert('A partida já começou, não dá mais para sair por aqui.');
        }
        goToMenu();
      });
    } else {
      goToMenu();
    }
  });

  $('btn-join-room').addEventListener('click', () => {
    const roomId = $('room-code-input').value.trim().toUpperCase();
    if (roomId.length !== 4) return ($('entry-error').textContent = 'Digite o código de 4 caracteres da sala.');
    $('entry-error').textContent = '';
    if (!state.socket || !state.socket.connected) {
      return ($('entry-error').textContent = 'Sem conexão com o servidor no momento. Aguarde reconectar e tente de novo.');
    }
    $('btn-join-room').disabled = true;
    emitWithTimeout('join_room', { roomId, nickname: state.nickname, avatar: state.avatar, deviceId: state.deviceId, authToken: roomAuthToken() }, 12000, (res) => {
      $('btn-join-room').disabled = false;
      if (!res.ok) {
        if (res.reason === 'AUTH_EXPIRED') return handleAuthExpired();
        const messages = {
          ROOM_NOT_FOUND: 'Sala não encontrada. Confira o código.',
          BANNED: 'Você foi banido desta sala.',
          GAME_ALREADY_STARTED: 'Essa partida já começou.',
          ROOM_FULL: 'Sala cheia (máximo de 8 jogadores).',
          NICKNAME_RESERVED: 'Esse apelido pertence a uma conta cadastrada. Escolha outro ou entre com a conta (botão "Sair" para trocar).',
        };
        $('entry-error').textContent = messages[res.reason] || 'Não foi possível entrar na sala.';
        return;
      }
      persistSession(res.roomId, res.sessionToken, res.playerId);
      showScreen('lobby');
    });
  });

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  function renderRoundTimeOptions(current) {
    const container = $('round-time-options');
    container.innerHTML = '';
    [10, 15, 20, 30].forEach((sec) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill';
      btn.textContent = `${sec}s`;
      btn.setAttribute('data-active', String(current === sec * 1000));
      btn.addEventListener('click', () => {
        state.socket.emit('host:set_round_time', { roomId: state.roomId, sessionToken: state.sessionToken, seconds: sec });
      });
      container.appendChild(btn);
    });
  }

  function renderTotalQuestionsOptions(current) {
    [...$('total-questions-options').children].forEach((btn) => {
      btn.setAttribute('data-active', String(Number(btn.dataset.value) === current));
      btn.onclick = () => {
        state.socket.emit('host:set_total_questions', {
          roomId: state.roomId, sessionToken: state.sessionToken, total: Number(btn.dataset.value),
        });
      };
    });
  }

  function renderCategoryGrid(activeCategories) {
    const grid = $('category-grid');
    grid.innerHTML = '';
    Object.entries(CATEGORY_LABELS).forEach(([id, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'category-chip';
      chip.textContent = label;
      const isActive = activeCategories.includes(id);
      chip.setAttribute('data-active', String(isActive));
      chip.addEventListener('click', () => {
        const next = new Set(activeCategories);
        if (next.has(id)) next.delete(id); else next.add(id);
        if (next.size === 0) return; // precisa de ao menos 1 categoria
        state.socket.emit('host:set_categories', {
          roomId: state.roomId, sessionToken: state.sessionToken, categoryIds: [...next],
        });
      });
      grid.appendChild(chip);
    });
  }

  function renderPlayerList(players) {
    $('player-count').textContent = players.length;
    const list = $('player-list');
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-row';
      const amHost = state.playerId !== null && state.playerId === state.hostPlayerId;
      const canModerate = amHost && p.playerId !== state.playerId;
      li.innerHTML = `
        <span class="player-avatar">${p.avatar}</span>
        <span class="player-name">${escapeHtml(p.nickname)}${p.isHost ? ' <span class="player-crown">👑</span>' : ''}</span>
        <span class="status-dot" data-status="${p.connectionStatus}" title="${p.connectionStatus}"></span>
      `;
      if (canModerate) {
        const actions = document.createElement('span');
        actions.className = 'player-actions';
        actions.innerHTML = `
          <button class="icon-btn" data-action="crown" title="Tornar host">👑</button>
          <button class="icon-btn" data-action="kick" title="Expulsar">✕</button>
          <button class="icon-btn" data-action="ban" title="Banir">⛔</button>
        `;
        actions.querySelector('[data-action="crown"]').addEventListener('click', () =>
          state.socket.emit('host:transfer_leadership', { roomId: state.roomId, sessionToken: state.sessionToken, targetPlayerId: p.playerId }));
        actions.querySelector('[data-action="kick"]').addEventListener('click', () =>
          state.socket.emit('host:kick_player', { roomId: state.roomId, sessionToken: state.sessionToken, targetPlayerId: p.playerId }));
        actions.querySelector('[data-action="ban"]').addEventListener('click', () =>
          state.socket.emit('host:ban_player', { roomId: state.roomId, sessionToken: state.sessionToken, targetPlayerId: p.playerId }));
        li.appendChild(actions);
      }
      list.appendChild(li);
    });
  }

  function onLobbyState(payload) {
    state.hostPlayerId = payload.hostPlayerId;
    state.isHost = state.playerId !== null && payload.hostPlayerId === state.playerId;
    state.settings = payload.settings;
    state.playerCount = payload.players.length;

    $('lobby-room-code').textContent = payload.roomId;
    renderPlayerList(payload.players);

    $('host-panel').hidden = !state.isHost;
    $('guest-waiting').style.display = state.isHost ? 'none' : 'flex';

    if (state.isHost) {
      renderRoundTimeOptions(payload.settings.roundTimeMs);
      renderTotalQuestionsOptions(payload.settings.totalQuestions);
      renderCategoryGrid(payload.settings.categories);
      const connectedCount = payload.players.filter((p) => p.connectionStatus === 'connected').length;
      const startBtn = $('btn-start-game');
      startBtn.disabled = connectedCount < 2;
      startBtn.textContent = connectedCount < 2
        ? 'Iniciar partida (mín. 2 jogadores)'
        : `Iniciar partida (${connectedCount} jogadores)`;
    }

    if (payload.phase === 'lobby' && screens.entry.getAttribute('data-active') !== 'true') {
      showScreen('lobby');
    }
  }

  $('btn-start-game').addEventListener('click', () => {
    state.socket.emit('host:start_game', { roomId: state.roomId, sessionToken: state.sessionToken });
  });

  $('btn-copy-link').addEventListener('click', async () => {
    const url = `${location.origin}/?join=${state.roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      $('btn-copy-link').textContent = 'Copiado!';
      setTimeout(() => ($('btn-copy-link').textContent = 'Copiar convite'), 1500);
    } catch {
      prompt('Copie o link da sala:', url);
    }
  });

  // ------------------------------------------------------------------
  // Pergunta
  // ------------------------------------------------------------------
  function renderQuestion(q, hiddenIndices = null) {
    state.currentQuestion = q;
    state.hasAnswered = false;
    state.fiftyFiftyHiddenIndices = null;
    state.doublePointsArmed = false;
    resetReportUI();

    $('question-progress').textContent = `Pergunta ${q.questionNumber}/${q.totalQuestions}`;
    $('question-category').textContent = CATEGORY_LABELS[q.category] || q.category;
    $('question-bonus-badge').hidden = !q.isBonus;
    $('question-text').textContent = q.questionText;
    $('answers-progress').textContent = '';

    const grid = $('options-grid');
    grid.innerHTML = '';
    q.options.forEach((optionText, i) => {
      const key = OPTION_KEYS[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-btn';
      btn.dataset.key = key;
      btn.dataset.selected = 'false';
      btn.dataset.index = String(i);
      btn.innerHTML = `<span class="option-shape">${OPTION_SHAPES[key]}</span><span>${escapeHtml(optionText)}</span>`;
      btn.addEventListener('click', () => submitAnswer(i, btn));
      grid.appendChild(btn);
    });

    showScreen('question');
    startCountdown(q.serverStartTs, q.timeLimitMs);

    // Se veio de uma reconexão em que o 50/50 já tinha sido usado nesta
    // pergunta (ver rejoin_room), restaura o mesmo par escondido — nunca
    // sorteia de novo (ver comentário equivalente no servidor).
    if (Array.isArray(hiddenIndices) && hiddenIndices.length) applyFiftyFifty(hiddenIndices);
    updatePowerupUI();
  }

  // ------------------------------------------------------------------
  // Power-ups (50/50 e pontos em dobro) — a sequência de acertos concede
  // cargas automaticamente (ver 'you:state'); usar é sempre uma escolha do
  // jogador, validada e aplicada pelo servidor. O cliente só reflete o que
  // o servidor manda, nunca decide o efeito sozinho.
  // ------------------------------------------------------------------
  function applyFiftyFifty(hiddenIndices) {
    state.fiftyFiftyHiddenIndices = hiddenIndices;
    hiddenIndices.forEach((i) => {
      const btn = $('options-grid').querySelector(`[data-index="${i}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('option-hidden'); }
    });
  }

  function updatePowerupUI() {
    const fiftyBtn = $('btn-powerup-fifty');
    const doubleBtn = $('btn-powerup-double');
    const streakEl = $('streak-indicator');

    $('charge-fiftyFifty').textContent = String(state.powerups.fiftyFifty);
    $('charge-doublePoints').textContent = String(state.powerups.doublePoints);

    const inQuestionPhase = !state.hasAnswered && screens.question.getAttribute('data-active') === 'true';

    fiftyBtn.hidden = state.powerups.fiftyFifty <= 0 && !state.fiftyFiftyHiddenIndices;
    fiftyBtn.disabled = !inQuestionPhase || state.powerups.fiftyFifty <= 0 || !!state.fiftyFiftyHiddenIndices;
    fiftyBtn.dataset.active = state.fiftyFiftyHiddenIndices ? 'true' : 'false';

    doubleBtn.hidden = state.powerups.doublePoints <= 0 && !state.doublePointsArmed;
    doubleBtn.disabled = !inQuestionPhase || state.powerups.doublePoints <= 0 || state.doublePointsArmed;
    doubleBtn.dataset.active = state.doublePointsArmed ? 'true' : 'false';
    doubleBtn.innerHTML = state.doublePointsArmed
      ? '⚡ Pontos em dobro ativado!'
      : `⚡ Pontos em dobro <span class="powerup-charge-count" id="charge-doublePoints">${state.powerups.doublePoints}</span>`;

    streakEl.hidden = state.currentStreak < 2; // só mostra quando já é notável
    $('streak-count').textContent = String(state.currentStreak);
  }

  $('btn-powerup-fifty').addEventListener('click', () => {
    if (!state.currentQuestion || state.fiftyFiftyHiddenIndices) return;
    emitWithTimeout('powerup:use', {
      roomId: state.roomId, sessionToken: state.sessionToken,
      questionId: state.currentQuestion.id, type: 'fiftyFifty',
    }, 6000, (res) => {
      if (!res?.ok) return; // sem carga, pergunta já mudou etc. — falha silenciosa, baixo risco
      if (res.powerups) state.powerups = res.powerups;
      applyFiftyFifty(res.hiddenIndices);
      updatePowerupUI();
    });
  });

  $('btn-powerup-double').addEventListener('click', () => {
    if (!state.currentQuestion || state.doublePointsArmed) return;
    emitWithTimeout('powerup:use', {
      roomId: state.roomId, sessionToken: state.sessionToken,
      questionId: state.currentQuestion.id, type: 'doublePoints',
    }, 6000, (res) => {
      if (!res?.ok) return;
      if (res.powerups) state.powerups = res.powerups;
      state.doublePointsArmed = true;
      updatePowerupUI();
    });
  });

  function submitAnswer(chosenIndex, btnEl) {
    if (state.hasAnswered) return;
    state.hasAnswered = true;
    [...$('options-grid').children].forEach((b) => (b.disabled = true));
    btnEl.dataset.selected = 'true';
    updatePowerupUI(); // depois de responder, os botões de power-up desativam junto

    state.socket.emit('submit_answer', {
      roomId: state.roomId,
      sessionToken: state.sessionToken,
      questionId: state.currentQuestion.id,
      chosenIndex,
    });
  }

  function startCountdown(serverStartTs, timeLimitMs) {
    // O timer visual é só estético: a autoridade real fica no servidor,
    // que valida deltaMs de forma independente do que o cliente mostra.
    const clockOffset = state.clockOffsetMs || 0; // estimativa de diferença entre relógio local e do servidor
    const ring = $('timer-ring-fg');
    const label = $('timer-seconds');
    const circumference = 175.9;

    cancelAnimationFrame(state.countdownRAF);

    function tick() {
      const nowServerEstimate = Date.now() - clockOffset;
      const elapsed = nowServerEstimate - serverStartTs;
      const remainingMs = Math.max(0, timeLimitMs - elapsed);
      const fraction = remainingMs / timeLimitMs;

      ring.style.strokeDashoffset = String(circumference * (1 - fraction));
      label.textContent = String(Math.ceil(remainingMs / 1000));

      if (fraction > 0.5) ring.dataset.state = 'ok';
      else if (fraction > 0.2) ring.dataset.state = 'warn';
      else ring.dataset.state = 'danger';

      if (remainingMs > 0) {
        state.countdownRAF = requestAnimationFrame(tick);
      } else if (!state.hasAnswered) {
        [...$('options-grid').children].forEach((b) => (b.disabled = true));
      }
    }
    tick();
  }

  function onAnswersProgress({ answered, total }) {
    $('answers-progress').textContent = `${answered}/${total} responderam`;
  }

  // ------------------------------------------------------------------
  // Revelação
  // ------------------------------------------------------------------
  function renderScoreboardInto(el, scoreboard) {
    el.innerHTML = '';
    scoreboard.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'scoreboard-row';
      li.innerHTML = `
        <span class="scoreboard-rank">${i + 1}</span>
        <span class="player-avatar">${p.avatar}</span>
        <span class="player-name">${escapeHtml(p.nickname)}</span>
        <span class="scoreboard-score">${p.score} pts</span>
      `;
      el.appendChild(li);
    });
  }

  function onReveal({ correctIndex, perPlayerResults, updatedScoreboard }) {
    cancelAnimationFrame(state.countdownRAF);
    const mine = perPlayerResults.find((r) => r.playerId === state.playerId);

    // Mostra visualmente qual era a correta na própria tela de pergunta por um instante
    [...$('options-grid').children].forEach((btn, i) => {
      if (i === correctIndex) btn.style.boxShadow = '0 0 0 3px #fff inset';
    });

    const verdict = $('reveal-verdict');
    if (mine?.correct) {
      verdict.textContent = 'Você acertou! ✓';
      verdict.dataset.correct = 'true';
    } else {
      verdict.textContent = mine ? 'Você errou ✗' : 'Sem resposta';
      verdict.dataset.correct = 'false';
    }
    $('reveal-points').textContent = mine?.correct ? `+${mine.points} pontos` : 'Sem pontos nesta rodada';

    // Aviso de power-up ganho nesta rodada (marco de sequência batido — ver
    // STREAK_MILESTONE/grantStreakPowerupIfMilestone em server.js). A carga
    // em si já foi somada no servidor e chega pro dono dela via 'you:state'
    // no início da próxima pergunta; este aviso é só feedback visual de QUE
    // ela foi ganha, por isso não mexe em state.powerups.
    const powerupNotice = $('reveal-powerup-notice');
    const earnedLabel = mine?.powerupGranted ? POWERUP_EARNED_LABELS[mine.powerupGranted] : null;
    if (earnedLabel) {
      powerupNotice.textContent = `🎉 Sequência de ${mine.streak}! Você ganhou: ${earnedLabel}`;
      powerupNotice.hidden = false;
    } else {
      powerupNotice.hidden = true;
    }

    renderScoreboardInto($('reveal-scoreboard-list'), updatedScoreboard);
    showScreen('reveal');
  }

  // ------------------------------------------------------------------
  // Reportar pergunta com problema
  // ------------------------------------------------------------------
  function resetReportUI() {
    $('btn-report-question').hidden = false;
    $('report-reasons').hidden = true;
    $('report-thanks').hidden = true;
  }

  $('btn-report-question').addEventListener('click', () => {
    $('btn-report-question').hidden = true;
    $('report-reasons').hidden = false;
  });

  $('report-reasons').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.pill[data-reason]');
    if (!btn || !state.currentQuestion) return;
    [...$('report-reasons').children].forEach((b) => (b.disabled = true));
    state.socket.emit('report_question', {
      roomId: state.roomId,
      sessionToken: state.sessionToken,
      questionId: state.currentQuestion.id,
      reason: btn.dataset.reason,
    }, () => {
      // Independente do ack (ok ou não): do ponto de vista do jogador, o
      // fluxo termina aqui — não vale a pena expor erros internos de
      // "a pergunta já mudou" etc. numa ação tão de baixo risco quanto essa.
      $('report-reasons').hidden = true;
      $('report-thanks').hidden = false;
    });
  });

  // ------------------------------------------------------------------
  // Pódio
  // ------------------------------------------------------------------
  function onGameOver({ podium, rankedGame, minRankedPlayers }) {
    const top3 = podium.slice(0, 3);
    const rest = podium.slice(3);

    const top3Container = $('podium-top3');
    top3Container.innerHTML = '';
    top3.forEach((p) => {
      const slot = document.createElement('div');
      slot.className = 'podium-slot';
      slot.dataset.place = String(p.position);
      slot.innerHTML = `
        <span class="podium-avatar">${p.avatar}</span>
        <span class="podium-name">${escapeHtml(p.nickname)}</span>
        <span class="podium-score">${p.totalScore} pts</span>
        <div class="podium-bar">${p.position}º</div>
      `;
      top3Container.appendChild(slot);
    });

    const restList = $('podium-rest');
    restList.innerHTML = '';
    rest.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'scoreboard-row';
      li.innerHTML = `
        <span class="scoreboard-rank">${p.position}</span>
        <span class="player-avatar">${p.avatar}</span>
        <span class="player-name">${escapeHtml(p.nickname)}</span>
        <span class="scoreboard-score">${p.totalScore} pts</span>
      `;
      restList.appendChild(li);
    });

    const mine = podium.find((p) => p.playerId === state.playerId);
    renderPersonalStats(mine?.allTimeStats);
    const note = $('ranked-note');
    note.hidden = rankedGame !== false;
    if (rankedGame === false) {
      note.textContent = `Partida com menos de ${minRankedPlayers} jogadores: conta no seu placar pessoal, mas não vale para o ranking.`;
    }

    showScreen('podium'); // o próprio showScreen recarrega o ranking
  }

  function renderPersonalStats(stats) {
    const el = $('personal-stats');
    if (!stats) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <div class="personal-stat">
        <span class="personal-stat-value" data-kind="games">${stats.gamesPlayed}</span>
        <span class="personal-stat-label">Partidas jogadas</span>
      </div>
      <div class="personal-stat">
        <span class="personal-stat-value" data-kind="wins">${stats.wins}</span>
        <span class="personal-stat-label">Vitórias</span>
      </div>
      <div class="personal-stat">
        <span class="personal-stat-value" data-kind="losses">${stats.losses}</span>
        <span class="personal-stat-label">Derrotas</span>
      </div>
      <div class="personal-stat">
        <span class="personal-stat-value" data-kind="correct">${stats.correctAnswers}</span>
        <span class="personal-stat-label">Questões acertadas</span>
      </div>
      <div class="personal-stat">
        <span class="personal-stat-value" data-kind="wrong">${stats.wrongAnswers}</span>
        <span class="personal-stat-label">Questões erradas</span>
      </div>
    `;
  }

  // ------------------------------------------------------------------
  // Ranking (placar geral) — período + critério, com a sua posição.
  // Um recorte só (lbSel) vale para os dois lugares onde aparece (menu e pódio);
  // cada troca de aba pede ao servidor (leaderboard:get) e redesenha os dois.
  // ------------------------------------------------------------------
  const LB_CONTAINERS = ['lb-home', 'lb-podium'];
  const LB_PERIODS = [['all', 'Sempre'], ['month', '30 dias'], ['week', '7 dias']];
  const LB_METRICS = [['points', 'Pontos'], ['average', 'Média'], ['wins', 'Vitórias'], ['accuracy', 'Precisão']];
  const lbSel = { period: 'all', metric: 'points' };
  let lbSeq = 0;

  const fmtNum = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function lbValueText(row, metric) {
    switch (metric) {
      case 'average': return `${fmtNum(row.average)} pts/partida`;
      case 'wins': return plural(row.wins, 'vitória', 'vitórias');
      case 'accuracy': return `${fmtNum(row.accuracy)}%`;
      default: return `${fmtNum(row.score)} pts`;
    }
  }

  function lbRowEl(row, metric) {
    const li = document.createElement('li');
    li.className = 'scoreboard-row';
    if (row.isMe) li.classList.add('is-you');
    const cells = [
      ['scoreboard-rank', String(row.rank)],
      ['player-avatar', row.avatar || ''],
      ['player-name', row.nickname],
    ];
    cells.forEach(([cls, text]) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text; // textContent: nome de jogador nunca vira HTML
      li.appendChild(span);
    });
    const value = document.createElement('span');
    value.className = 'scoreboard-value';
    const main = document.createElement('span');
    main.className = 'scoreboard-score';
    main.textContent = lbValueText(row, metric);
    const sub = document.createElement('span');
    sub.className = 'scoreboard-sub';
    sub.textContent = plural(row.games, 'partida', 'partidas');
    value.append(main, sub);
    li.appendChild(value);
    return li;
  }

  function buildLeaderboardShell(containerId) {
    const root = $(containerId);
    if (!root) return;
    root.innerHTML = '';

    const controls = document.createElement('div');
    controls.className = 'lb-controls';
    const makeGroup = (label, items, key) => {
      const group = document.createElement('div');
      group.className = 'pill-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      items.forEach(([value, text]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pill';
        btn.dataset.lbKey = key;
        btn.dataset.lbValue = value;
        btn.textContent = text;
        btn.addEventListener('click', () => {
          if (lbSel[key] === value) return;
          lbSel[key] = value;
          syncLeaderboardControls();
          refreshLeaderboards();
        });
        group.appendChild(btn);
      });
      return group;
    };
    controls.append(makeGroup('Período', LB_PERIODS, 'period'), makeGroup('Critério', LB_METRICS, 'metric'));

    const hint = document.createElement('p');
    hint.className = 'lb-hint';
    hint.dataset.lb = 'hint';
    const list = document.createElement('ol');
    list.className = 'scoreboard-list';
    list.dataset.lb = 'list';
    const meLabel = document.createElement('p');
    meLabel.className = 'lb-me-label';
    meLabel.dataset.lb = 'me-label';
    meLabel.textContent = 'Sua posição';
    meLabel.hidden = true;
    const meList = document.createElement('ol');
    meList.className = 'scoreboard-list';
    meList.dataset.lb = 'me';
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.dataset.lb = 'empty';
    empty.hidden = true;

    root.append(controls, hint, list, meLabel, meList, empty);
  }

  function syncLeaderboardControls() {
    LB_CONTAINERS.forEach((id) => {
      const root = $(id);
      if (!root) return;
      root.querySelectorAll('.pill[data-lb-key]').forEach((btn) => {
        btn.setAttribute('data-active', String(lbSel[btn.dataset.lbKey] === btn.dataset.lbValue));
      });
    });
  }

  function renderLeaderboard(containerId, res) {
    const root = $(containerId);
    if (!root) return;
    const part = (name) => root.querySelector(`[data-lb="${name}"]`);
    const list = part('list');
    const meList = part('me');
    list.innerHTML = '';
    meList.innerHTML = '';

    res.rows.forEach((row) => list.appendChild(lbRowEl(row, res.metric)));

    // Fora do top: mostra a posição real de quem consulta logo abaixo.
    const meOutside = res.me && res.me.rank > res.rows.length;
    if (meOutside) meList.appendChild(lbRowEl(res.me, res.metric));
    part('me-label').hidden = !meOutside;

    const needsMin = res.metric === 'average' || res.metric === 'accuracy';
    let hint = needsMin ? `Mínimo de ${plural(res.minGames, 'partida', 'partidas')} para aparecer neste ranking.` : '';
    if (res.meNeeded) hint += `${hint ? ' ' : ''}Faltam ${plural(res.meNeeded, 'partida', 'partidas')} para você entrar.`;
    part('hint').textContent = hint;

    const empty = part('empty');
    empty.hidden = res.rows.length > 0;
    empty.textContent = needsMin
      ? 'Ninguém tem partidas suficientes neste período ainda.'
      : 'Ninguém no ranking neste período ainda — seja o primeiro!';
  }

  function renderLeaderboardError() {
    LB_CONTAINERS.forEach((id) => {
      const root = $(id);
      if (!root) return;
      const hint = root.querySelector('[data-lb="hint"]');
      if (hint) hint.textContent = 'Não foi possível carregar o ranking agora.';
    });
  }

  /** Pede ao servidor o recorte escolhido (com a minha posição) e redesenha os dois placares. */
  function refreshLeaderboards() {
    if (!state.socket || !state.socket.connected) return;
    const seq = ++lbSeq;
    const payload = { period: lbSel.period, metric: lbSel.metric, authToken: roomAuthToken(), deviceId: state.deviceId };
    emitWithTimeout('leaderboard:get', payload, 8000, (res) => {
      if (seq !== lbSeq) return; // resposta de um recorte antigo (a pessoa já trocou de aba)
      if (!res || !res.ok) return renderLeaderboardError();
      LB_CONTAINERS.forEach((id) => renderLeaderboard(id, res));
    });
  }

  $('btn-play-again').addEventListener('click', () => {
    clearSession();
    location.href = location.origin;
  });

  $('btn-clear-leaderboard').addEventListener('click', () => {
    const code = window.prompt('Digite o código de administrador para limpar o placar geral:');
    if (code === null) return; // usuário cancelou
    if (!code.trim()) {
      window.alert('Você precisa informar o código.');
      return;
    }
    state.socket.emit('admin:clear_leaderboard', { code: code.trim() }, (res) => {
      if (res?.ok) {
        refreshLeaderboards();
        window.alert('Placar geral limpo com sucesso.');
      } else {
        window.alert(res?.error || 'Não foi possível limpar o placar geral.');
      }
    });
  });

  // ------------------------------------------------------------------
  // Kicked / Banned / Expired
  // ------------------------------------------------------------------
  function backToEntryWithMessage(msg) {
    clearSession();
    if (state.username) {
      showScreen('entry');
      $('entry-error').textContent = msg;
    } else {
      // Caso raro: o evento chegou antes de terminar o login da conta.
      showScreen('login');
      $('auth-error').textContent = msg;
    }
  }

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Conexão / reconexão
  // ------------------------------------------------------------------
  function initSocket() {
    state.socket = io({ transports: ['websocket', 'polling'] });

    const setConnIndicator = (quality) => $('connection-indicator').setAttribute('data-quality', quality);
    setConnIndicator('warn'); // ainda conectando pela primeira vez
    updateConnStatus('connecting');
    state.socket.on('disconnect', () => { setConnIndicator('bad'); updateConnStatus('reconnecting'); });
    state.socket.on('connect_error', () => { setConnIndicator('bad'); updateConnStatus('connecting'); });
    state.socket.on('reconnect_attempt', () => setConnIndicator('warn'));

    state.socket.on('connect', () => {
      setConnIndicator('ok');
      updateConnStatus('connected');
      if (screens.entry.getAttribute('data-active') === 'true') refreshLeaderboards();

      // Reconexão de SALA (sessionToken) — independente de estar logado ou
      // não na conta; se a pessoa já estava numa partida, ela continua nela.
      if (state.sessionToken && state.roomId) {
        state.socket.emit('rejoin_room', { sessionToken: state.sessionToken, roomId: state.roomId }, (res) => {
          if (!res.ok) return backToEntryWithMessage('Sua sessão expirou. Entre novamente.');
          const snap = res.snapshot;
          renderChatHistory(snap.chat);
          state.playerId = snap.playerId;
          state.hostPlayerId = snap.hostPlayerId;
          state.isHost = snap.hostPlayerId === state.playerId;

          if (snap.phase === 'lobby') {
            onLobbyState({
              roomId: state.roomId, hostPlayerId: snap.hostPlayerId,
              settings: snap.settings, players: snap.players, phase: 'lobby',
            });
            showScreen('lobby');
          } else if (snap.phase === 'question' && snap.currentQuestion) {
            state.powerups = snap.powerups;
            state.currentStreak = snap.currentStreak;
            state.bestStreak = snap.bestStreak;
            renderQuestion(snap.currentQuestion, snap.hiddenIndices);
            // renderQuestion() reseta hasAnswered pra false por padrão (é o
            // caminho normal de pergunta NOVA) — aqui é reconexão, então o
            // valor de verdade (se já respondeu) só pode ser aplicado depois.
            state.hasAnswered = snap.hasAnsweredCurrent;
            if (snap.hasAnsweredCurrent) {
              [...$('options-grid').children].forEach((b) => (b.disabled = true));
              updatePowerupUI();
            }
          } else if (snap.phase === 'reveal' && snap.reveal) {
            // Reconectou bem no intervalo entre perguntas — reaproveita o
            // mesmo handler do broadcast ao vivo (ver onReveal) pra mostrar
            // exatamente a mesma tela de quem nunca saiu, incluindo o aviso
            // de power-up ganho.
            state.powerups = snap.powerups;
            state.currentStreak = snap.currentStreak;
            state.bestStreak = snap.bestStreak;
            onReveal({
              correctIndex: snap.reveal.correctIndex,
              perPlayerResults: snap.reveal.perPlayerResults,
              updatedScoreboard: snap.scoreboard,
            });
          } else if (snap.phase === 'podium') {
            showScreen('podium');
          } else {
            showScreen('lobby');
          }
        });
        return;
      }

      // Sem sala em aberto: tenta retomar o login da CONTA a partir do
      // authToken salvo (localStorage) — é o que evita pedir usuário/senha
      // de novo a cada visita, em qualquer dispositivo onde já tenha logado.
      if (state.authToken && !state.isGuest) {
        const remembered = isAuthTokenRemembered(); // preserva onde o token já estava, não promove sessionStorage a localStorage sozinho
        state.socket.emit('auth:resume', { authToken: state.authToken }, (res) => {
          if (!res.ok) {
            state.authToken = null;
            state.userId = null;
            persistAuthToken(null);
            showScreen('login');
            $('auth-error').textContent = 'Sua sessão expirou. Entre novamente.';
            return;
          }
          onAuthSuccess({ authToken: state.authToken, userId: res.userId, username: res.username, avatar: res.avatar, remember: remembered });
        });
      }
    });

    state.socket.on('lobby_state', onLobbyState);
    state.socket.on('chat:message', (msg) => appendChatMessage(msg, { countUnread: true }));
    state.socket.on('chat:notice', appendChatNotice);
    state.socket.on('chat:history', ({ messages }) => renderChatHistory(messages));
    state.socket.on('player_joined', () => {});
    state.socket.on('answers_progress', onAnswersProgress);
    state.socket.on('question:start', renderQuestion);
    state.socket.on('question:reveal', onReveal);
    state.socket.on('game_over', onGameOver);
    // Estado pessoal de power-ups/sequência, enviado a cada início de
    // pergunta (e no snapshot de reconexão) — ver comentário equivalente em
    // server.js, logo depois do broadcast de 'question:start'.
    state.socket.on('you:state', ({ powerups, currentStreak, bestStreak }) => {
      state.powerups = powerups;
      state.currentStreak = currentStreak;
      state.bestStreak = bestStreak;
      updatePowerupUI();
    });
    // Aviso do servidor de que o placar mudou (fim de partida) / conexão nova:
    // quem está olhando o menu recarrega o recorte atual.
    state.socket.on('overall_leaderboard', () => {
      if (screens.entry.getAttribute('data-active') === 'true') refreshLeaderboards();
    });
    state.socket.on('you_were_kicked', () => backToEntryWithMessage('Você foi removido da sala pelo host.'));
    state.socket.on('you_were_banned', () => backToEntryWithMessage('Você foi banido desta sala.'));
    state.socket.on('session_expired', () => backToEntryWithMessage('Sua sessão expirou.'));
    state.socket.on('connection_rejected', ({ reason } = {}) => {
      const messages = {
        TOO_MANY_CONNECTIONS: 'Muitas conexões abertas a partir da sua rede agora. Feche alguma aba/dispositivo e tente de novo.',
      };
      backToEntryWithMessage(messages[reason] || 'Conexão recusada pelo servidor.');
    });

    // Indicador de latência (heartbeat visual) + estimativa de diferença de
    // relógio (clockOffsetMs), usada pelo timer visual da pergunta
    // (startCountdown). Sem isso, num aparelho com o relógio adiantado ou
    // atrasado em relação ao servidor, o timer na tela roda errado mesmo que
    // a rede esteja ótima — o servidor sempre valida pelo próprio relógio de
    // qualquer forma, mas a pessoa via uma contagem que não batia com a
    // realidade, o que parecia (e na prática causava) perder tempo de resposta.
    setInterval(() => {
      const start = Date.now();
      state.socket.emit('ping_check', (res) => {
        const end = Date.now();
        const rtt = end - start;
        const dot = $('connection-indicator');
        dot.setAttribute('data-quality', rtt > 400 ? 'bad' : rtt > 150 ? 'warn' : 'ok');

        // Só usa a amostra se o servidor respondeu com o timestamp esperado
        // e a viagem não foi longa/assimétrica demais pra confiar na
        // estimativa (rtt alto = latência de ida e volta pode ser bem
        // diferente uma da outra, e o cálculo assume que são parecidas).
        if (typeof res?.serverTs === 'number' && rtt < 1000) {
          const offsetSample = (start + end) / 2 - res.serverTs;
          // Média móvel: suaviza ruído de uma amostra isolada sem descartar
          // uma mudança real e sustentada (ex.: trocou de rede).
          state.clockOffsetMs = state.clockOffsetMs == null
            ? offsetSample
            : state.clockOffsetMs * 0.7 + offsetSample * 0.3;
        }
      });
    }, 4000);
  }

  // ------------------------------------------------------------------
  // Bootstrap
  // ------------------------------------------------------------------
  function bootstrap() {
    renderAvatarGrid('register-avatar-grid', registerAvatar, (emoji) => { registerAvatar = emoji; });
    LB_CONTAINERS.forEach(buildLeaderboardShell);
    syncLeaderboardControls();
    if (state.username) renderAccountBadge(); // repinta na hora com o que já tinha salvo, sem esperar auth:resume

    const params = new URLSearchParams(location.search);
    const joinCode = params.get('join');
    if (joinCode) {
      pendingJoinCode = joinCode.toUpperCase();
      applyInviteEmphasis(pendingJoinCode);
    }

    initSocket();

    // Se já havia uma sessão de SALA salva, tenta reconectar direto (o
    // handler 'connect' cuida disso) — isso não depende de estar logado.
    if (state.sessionToken && state.roomId) {
      showScreen('lobby');
    } else if (state.isGuest && state.username) {
      // Recarregou a página no modo convidado: volta direto pro menu.
      goToEntryScreen();
    }
    // Sem sala em aberto: fica na tela de login (ativa por padrão no HTML).
    // Se houver authToken salvo, o handler 'connect' tenta o auth:resume e,
    // se der certo, chama goToEntryScreen() sozinho (que já usa pendingJoinCode).
  }

  bootstrap();
})();
