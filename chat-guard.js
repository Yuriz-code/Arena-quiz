'use strict';

/**
 * Censura de spoilers no chat: durante uma pergunta aberta, decide se uma
 * mensagem "entrega" a resposta.
 *
 * Decisão importante de projeto: censuramos QUALQUER menção às alternativas
 * (texto ou referência tipo "letra B"), não só à correta. Se só a correta
 * fosse censurada, bastaria testar "A", "B", "C", "D" e ver qual some — o
 * próprio bloqueio viraria um oráculo que revela a resposta.
 *
 * O que detecta:
 *  1. Texto de uma alternativa (frase inteira ou palavra característica dela,
 *     inclusive com acento/maiúscula/pontuação diferentes, "q.u.e.e.n" e
 *     trocas de letras por números tipo "qu33n").
 *  2. Referência por letra/número: "letra B", "opção 2", "é a C", "b".
 *  3. Referência por posição: "a segunda", "a última".
 *  4. Referência por cor/forma dos botões: "a vermelha", "o triângulo", ▲◆●■.
 *
 * Limitações conhecidas (não dá para cobrir tudo): dicas indiretas ("é uma
 * banda britânica"), outros idiomas, códigos combinados entre os jogadores.
 */

const STOPWORDS = new Set([
  'the', 'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'as', 'os', 'um', 'uma', 'em', 'no', 'na',
  'of', 'and', 'la', 'el', 'le', 'les', 'du', 'des', 'del', 'san', 'sao', 'ao', 'com', 'por', 'para',
  'que', 'se', 'ou', 'nos', 'nas', 'dum', 'duma',
]);

const LETTER_OR_NUMBER = new Set(['a', 'b', 'c', 'd', '1', '2', '3', '4']);
const CUE_WORDS = new Set(['letra', 'opcao', 'alternativa', 'item', 'alt', 'opc', 'numero', 'resposta', 'gabarito']);
const ORDINALS = new Set([
  'primeira', 'segunda', 'terceira', 'quarta', 'ultima',
  'primeiro', 'segundo', 'terceiro', 'quarto', 'ultimo',
]);
const COLORS_AND_SHAPES = new Set([
  'vermelho', 'vermelha', 'azul', 'amarelo', 'amarela', 'verde',
  'triangulo', 'losango', 'bolinha', 'circulo', 'quadrado', 'quadradinho',
]);

/** minúsculas, sem acento, só letras/números separados por um espaço. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** troca comuns de "leetspeak" (qu33n -> queen). Aplicada antes de normalizar. */
function leetFold(text) {
  const map = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
  return String(text ?? '').toLowerCase().replace(/[013457@$]/g, (c) => map[c]);
}

function tokensOf(normalized) {
  return normalized ? normalized.split(' ') : [];
}

/**
 * Conjunto de palavras da mensagem, incluindo palavras "soletradas": uma
 * sequência de 3+ letras soltas ("q u e e n" / "q.u.e.e.n") vira "queen".
 * Só junta letras soltas — juntar tudo geraria falsos positivos
 * ("que entra" contém "queen").
 */
function wordSet(tokens) {
  const words = new Set(tokens);
  let run = '';
  for (const t of [...tokens, '']) {
    if (t.length === 1) {
      run += t;
    } else {
      if (run.length >= 3) words.add(run);
      run = '';
    }
  }
  return words;
}

/**
 * @param {string} message  texto já limpo da mensagem
 * @param {{question:string, options:string[]}} question  pergunta em andamento
 * @returns {boolean} true se a mensagem deve ser censurada
 */
function revealsAnswer(message, question) {
  const raw = String(message ?? '');
  if (!raw.trim() || !question) return false;

  // Símbolos dos botões (▲ ◆ ● ■): referência direta a uma alternativa.
  if (/[▲◆●■▪◼◾🔺🔷🔴🟡🟢🔵🟥🟦🟨🟩]/u.test(raw)) return true;

  const norm = normalize(raw);
  const tokens = tokensOf(norm);
  if (tokens.length === 0) return false;
  const n = tokens.length;
  const last = tokens[n - 1];

  // 2) Letra/número: "letra b", "opção 2", "resposta é a", "b", "é c"
  for (let i = 0; i < n; i++) {
    if (!CUE_WORDS.has(tokens[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 3, n - 1); j++) {
      const t = tokens[j];
      if (t === 'a') {
        // "a" é artigo em português: só conta logo depois da palavra-chave
        // ("letra a") ou como última palavra ("a resposta é a").
        if (j === i + 1 || j === n - 1) return true;
      } else if (LETTER_OR_NUMBER.has(t)) {
        return true;
      }
    }
  }
  if (n === 1 && LETTER_OR_NUMBER.has(tokens[0])) return true;
  if (n <= 4 && LETTER_OR_NUMBER.has(last)) return true;

  // 3) Posição e 4) cor/forma — só em mensagens curtas, onde é referência à opção
  if (n <= 5 && tokens.some((t) => ORDINALS.has(t))) return true;
  if (n <= 5 && tokens.some((t) => COLORS_AND_SHAPES.has(t))) return true;

  // 1) Texto das alternativas
  const options = Array.isArray(question.options) ? question.options.map(String) : [];
  const questionTokens = new Set(tokensOf(normalize(question.question)));
  const optionTokenSets = options.map((o) => new Set(tokensOf(normalize(o)).filter((t) => !STOPWORDS.has(t))));

  const padded = ` ${norm} `;
  const leetNorm = normalize(leetFold(raw));
  const leetPadded = ` ${leetNorm} `;
  const words = wordSet(tokens);
  const leetWords = wordSet(tokensOf(leetNorm));

  for (let idx = 0; idx < options.length; idx++) {
    const phrase = normalize(options[idx]);
    if (!phrase) continue;
    const contentTokens = tokensOf(phrase).filter((t) => !STOPWORDS.has(t));

    // Alternativas muito curtas ("4", "Rio", "Sim"): só conta em mensagem curta,
    // senão qualquer "4" no meio de uma frase seria censurado. Números de 3+
    // dígitos ("206") são raros em conversa, então valem em qualquer mensagem.
    const isNumeric = /^\d+$/.test(phrase);
    if (phrase.length <= 3 && !(isNumeric && phrase.length === 3)) {
      if (n <= 6 && padded.includes(` ${phrase} `)) return true;
      continue;
    }

    // Frase inteira da alternativa dentro da mensagem
    if (padded.includes(` ${phrase} `) || leetPadded.includes(` ${phrase} `)) return true;

    // Palavra característica: aparece só nessa alternativa e não na pergunta
    for (const t of contentTokens) {
      if (t.length < 4) continue;
      if (questionTokens.has(t)) continue;
      if (optionTokenSets.some((set, k) => k !== idx && set.has(t))) continue;
      if (words.has(t) || leetWords.has(t)) return true; // inclui "q.u.e.e.n" e "qu33n"
    }
  }

  return false;
}

module.exports = { revealsAnswer, normalize };
