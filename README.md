# QuizArena — Quiz Multiplayer Web

Implementação de referência da especificação técnica: servidor Node.js
autoritativo (Express + Socket.IO) e cliente web estático (HTML/CSS/JS puro,
sem build step), para até 8 jogadores remotos.

## O que já funciona

- Criação/entrada em salas por código de 4 caracteres
- Lobby com controles de host: tempo por rodada, nº de perguntas, categorias,
  transferir liderança, expulsar e banir (por IP + sessionToken)
- **Jogar de novo**: no pódio o host clica em "Jogar de novo com os mesmos jogadores" e a
  sala (mesmo código, jogadores, chat e configurações) volta ao lobby com o placar zerado —
  sem precisar recriar/entrar de novo; quem não quiser continuar sai pelo "Voltar ao início"
- Sessão persistente via `sessionToken` (UUID) guardado em `sessionStorage`:
  recarregar a página reconecta automaticamente à sala e à pergunta em curso
- Reconexão com grace period de 45s (o jogo não pausa; o timer continua)
- Pontuação anti-empate calculada 100% no servidor: `BasePoints(dificuldade) ×
  SpeedFactor(Δt, tempoLimite)`, com `correct_index` nunca enviado ao cliente
  antes da revelação
- Critério de desempate final em cascata (pontuação → acertos → tempo total
  → ordem de entrada), eliminando empates no pódio
- 12 categorias com um banco de 433 perguntas reais (validadas, sem
  duplicatas) — importe mais via CSV ou edite o banco bruto para chegar a
  100/categoria (ver seção própria)

## Funcionalidades adicionadas após a versão inicial

- **Curva de dificuldade**: as perguntas começam fáceis e ficam mais difíceis
  ao longo da partida; a cada 5ª pergunta é uma "pergunta bônus" (sempre
  difícil, vale pontuação em dobro).
- **Histórico anti-repetição entre partidas**: perguntas usadas recentemente
  são evitadas em jogos seguintes, mesmo após reiniciar o servidor
  (persistido em SQLite — ver "Persistência em SQLite" abaixo).
- **Placar geral / rankings**: no menu e no pódio, com abas de **período**
  (Sempre · 30 dias · 7 dias, janelas móveis) e de **critério** (Pontos ·
  Média por partida · Vitórias · Precisão). Média e Precisão exigem um mínimo
  de partidas (5 no geral, 3 em 30 dias, 2 em 7 dias) — senão uma única
  partida boa lideraria. Quem consulta vê a **própria posição** mesmo fora do
  top 10, e quantas partidas faltam para entrar em Média/Precisão.
  - *Identidade*: quem está logado acumula pela **conta** (o mesmo placar em
    qualquer aparelho, e o nome vem da conta — o servidor ignora o nome que o
    cliente mandar); convidado acumula pelo `deviceId` do navegador. Na
    primeira partida logado, o histórico de convidado daquele aparelho passa
    para a conta (uma vez; num aparelho compartilhado, a primeira conta a
    jogar leva o histórico).
  - *Anti-farm*: partida que começa com menos de 3 jogadores
    (`MIN_RANKED_PLAYERS`) conta no placar **pessoal**, mas não no ranking.
  - *Limpar*: o botão de limpar o placar (código de admin) zera o geral **e**
    os rankings de 7/30 dias (que saem do `game_log`).
  O login por conta é opcional: na tela inicial há também **Jogar sem login**
  (apelido + avatar, válidos só naquela aba; o último apelido fica lembrado no
  navegador). O servidor nunca exigiu conta para criar/entrar em sala — o
  login é uma etapa da interface.
- **Voltar ao menu inicial**: no lobby, o botão "← Voltar ao menu inicial"
  (evento `leave_room`, só permitido antes de a partida começar) tira a pessoa
  da sala e leva ao menu. Se o host sai, a liderança passa para quem ficou; se
  era o último jogador, a sala é apagada.
- **Chat da sala**: botão 💬 no canto da tela, disponível em todas as fases
  (lobby, perguntas, revelação e pódio). Mensagens de até 200 caracteres,
  limite de 5 por 10 s por jogador (anti-spam), últimas 50 guardadas na sala —
  quem entra depois ou recarrega recebe o histórico. Contador de não lidas com
  o painel fechado. Texto sempre exibido como texto puro (`textContent`).
- **Censura de respostas no chat**: enquanto uma pergunta está aberta, o
  servidor (`chat-guard.js`) censura mensagens que citem as alternativas —
  o texto delas (mesmo com acento, maiúsculas, "q.u.e.e.n" ou "qu33n"),
  referências como "letra B", "opção 2", "a segunda", "a vermelha" ou
  os símbolos ▲◆●■. A mensagem não é entregue nem guardada no histórico, o
  remetente recebe um aviso e a sala vê "🚫 Mensagem de X censurada".
  Censura **qualquer** alternativa (não só a certa), senão o bloqueio viraria
  um jeito de descobrir a resposta por tentativa e erro; tentativas
  censuradas contam no limite de spam. Depois da revelação, o assunto é
  liberado. Limitação: dicas indiretas ("é uma banda britânica") e códigos
  combinados entre jogadores não são detectados.
- **Segurança da sala**: o `sessionToken` de cada jogador é um segredo e
  nunca é enviado a outros jogadores. Na tela, jogadores (host, moderação,
  "eu") são identificados por um `playerId` público e aleatório. Ações de
  host e respostas exigem o token **e** o socket atual do jogador.
- **Limpar placar geral (admin)**: protegido por código secreto. **Exige** a
  variável de ambiente `ADMIN_CLEAR_CODE` — sem ela, o recurso fica desativado
  (não existe um código padrão embutido no código-fonte):

  ```bash
  ADMIN_CLEAR_CODE=umaSenhaForte npm start
  ```

- **Persistência em SQLite**: placar geral e histórico anti-repetição de
  perguntas ficam num único arquivo `quizarena.db` (módulo nativo
  `node:sqlite`, sem dependência externa) em vez dos antigos arquivos JSON.
  Se `data/player-stats.json` e/ou `data/question-history.json` já existirem
  de uma instalação anterior, eles são **migrados automaticamente** na
  primeira subida do servidor e renomeados para `*.migrado-<timestamp>`
  (nunca apagados). Veja "Persistência de verdade em produção" abaixo — isso
  sozinho **não** resolve disco efêmero sem um disco persistente apontado
  via `DATA_DIR`.
- **Limites anti-abuso**: teto de salas simultâneas no processo, teto de
  salas por IP, limite de criação de salas por IP numa janela de tempo,
  limite de conexões simultâneas por IP, limpeza automática de salas
  ociosas e tamanho máximo de pacote reduzido de 1 MB (padrão do
  Socket.IO) para 8 KB. Todos configuráveis por variável de ambiente — veja
  a tabela abaixo.
- **`GET /health`**: status agregado (salas ativas, jogadores conectados,
  uptime) para healthcheck de hospedagem/orquestrador — ver Docker/Render.
- **Suíte de testes automatizados** (`npm test`) e **Dockerfile** — ver
  seções próprias abaixo.
- **Importação de perguntas por CSV/planilha** e **detecção automática de
  duplicatas** (no import e na geração do banco final) — ver "Ampliando o
  banco de perguntas" abaixo. A detecção já encontrou e removeu 4
  duplicatas reais que existiam no banco original.
- **Categoria "Religião" única** (61 perguntas — o triplo de qualquer
  outra), cobrindo Cristianismo, Judaísmo, Islamismo e outras religiões
  num só recorte.
- **Botão "reportar pergunta com problema"** na tela de revelação —
  registra o relato (não corrige nada sozinho) para revisão via
  `scripts/list-reports.js`.

## Rodando localmente

Requer **Node.js 22.5+** (usa o módulo nativo `node:sqlite`).

```bash
cd server
npm install
npm start
```

Acesse `http://localhost:3000` no navegador. Para testar o multiplayer
localmente, abra várias abas (ou peça para outra pessoa na sua rede acessar
`http://SEU_IP_LOCAL:3000`).

## Deploy (acesso público, sem loja de aplicativos)

Qualquer host que rode um processo Node.js persistente com WebSocket
funciona. Sugestões gratuitas/baratas:

- **Railway** (`railway up`) — detecta o `package.json` automaticamente
- **Render** (Web Service) — build command `npm install`, start command `npm start`
- **Fly.io** (`fly launch`) — gera o `Dockerfile` automaticamente a partir do Node
- **VPS próprio** — `pm2 start server.js` atrás de um Nginx com `proxy_pass`
  e upgrade de conexão configurado para WebSocket:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
  ```

Depois do deploy, o link da sala (`https://seu-dominio.com/?join=X7K2`) pode
ser compartilhado com qualquer pessoa — não é necessário login nem instalar
nada.

### Persistência de verdade em produção (disco efêmero)

A maioria dos hosts gratuitos/baratos (Render incluso) apaga o disco do
serviço a cada deploy — trocar JSON por SQLite, sozinho, **não** resolve
isso: o arquivo `quizarena.db` mora no mesmo disco efêmero e some junto. O
que resolve é gravar o banco num **disco persistente**, fora da pasta do
código:

1. No Render: crie um **Disk** para o serviço (aba "Disks"), com um mount
   path, por exemplo `/data`.
2. Defina a variável de ambiente `DATA_DIR=/data`.
3. Pronto: `quizarena.db` passa a viver no disco persistente e sobrevive a
   deploys, reinícios e restarts do serviço. Sem `DATA_DIR` definido, o
   banco fica em `~/.quizarena/quizarena.db` (pasta do usuário, **fora** da
   pasta do projeto — ver "Atualizar o código sem perder contas e placar").

Isso não afeta `data/questions/*.json` (o banco de perguntas): esses
arquivos fazem parte do código-fonte, são versionados no Git e não
precisam de disco persistente.

### Atualizar o código sem perder contas e placar

Contas, placar geral, histórico e reports vivem no banco `quizarena.db`. Para
que atualizar os arquivos nunca os apague, há três camadas automáticas:

1. **Banco fora da pasta do código.** Sem `DATA_DIR`, o banco fica em
   `~/.quizarena/` (pasta do usuário). Substituir, apagar ou recriar a pasta
   `server/` não toca nele. Se você vinha de uma versão que guardava o banco
   em `server/data/quizarena.db`, ele é **copiado sozinho** para o novo local
   na primeira subida (o original não é apagado).
2. **Backups automáticos** (`~/.quizarena/backups/`, ou `BACKUP_DIR`):
   - ao **iniciar** — antes de qualquer migração de esquema da versão nova, ou
     seja, o estado anterior à atualização fica guardado;
   - a cada 6 horas (`BACKUP_INTERVAL_MINUTES`, `0` desliga só este);
   - ao **encerrar** o servidor.

   Só os 14 mais recentes ficam (`BACKUP_KEEP`). Reiniciar sem mudanças não
   cria cópias repetidas, e banco vazio nunca gera backup (não empurra os
   bons para fora da rotação).
3. **Auto-restauração.** Se no boot não existe banco (disco novo, pasta
   apagada) mas há um backup íntegro em `BACKUP_DIR`, o mais recente é
   restaurado sozinho. O log mostra `[db] ... restaurado o backup ...`.

Ao subir, o servidor imprime o caminho do banco e dos backups
(`[db] Banco de dados em: ...`) e avisa quando o banco é **novo**.

**Backup e restauração manuais**

```bash
npm run backup                       # snapshot em <backups>/ (pode rodar com o servidor ligado)
npm run backup -- ./meu-backup.db    # ou num arquivo à sua escolha
npm run restore -- ./meu-backup.db   # PARE o servidor antes; o banco atual é guardado em <backups>/
npm run restore -- --latest          # restaura o backup mais recente
```

**Baixar um backup pela internet** (útil antes de trocar de servidor/host),
com `ADMIN_CLEAR_CODE` configurado — o código vai no cabeçalho, nunca na URL:

```bash
curl -H "x-admin-code: SEU_CODIGO" -o quizarena-backup.db https://seu-site/admin/backup
```

Para usar o arquivo baixado em outro servidor, ponha-o em `BACKUP_DIR` (com
nome `quizarena-*.db`) e inicie sem banco, ou use `npm run restore`.

> **Limite honesto:** se `DATA_DIR` e `BACKUP_DIR` ficam no **mesmo disco
> efêmero** (Render sem Disk, container sem volume), o host apaga os dois
> juntos a cada deploy. No Render gratuito use o backup no GitHub (seção
> seguinte); com disco pago, use o disco persistente descrito acima (`DATA_DIR=/data`) e, se quiser uma
> segunda camada, aponte `BACKUP_DIR` para outro volume ou baixe cópias
> periodicamente pela rota `/admin/backup`.

### Render gratuito + GitHub: contas e placar que sobrevivem a deploys

No Render gratuito o disco é apagado a cada deploy **e** sempre que o serviço
"dorme" por inatividade. Como o banco e os backups locais moram nesse disco,
sozinhos eles somem. A solução sem pagar disco: o servidor guarda o backup num
**repositório privado do GitHub** e o restaura sozinho quando sobe sem banco.

**Configuração (uma vez):**

1. Crie um repositório **privado** só para o backup (ex.: `quizarena-backup`),
   já **inicializado** (marque "Add a README"). Precisa ser privado: o banco
   contém hashes de senha.
2. Em *GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens*: crie um token com acesso **somente a esse
   repositório** e a permissão **Contents: Read and write**.
3. No Render (*Environment*), adicione:

   | Variável               | Valor                          |
   |------------------------|--------------------------------|
   | `GITHUB_BACKUP_REPO`   | `seu-usuario/quizarena-backup` |
   | `GITHUB_BACKUP_TOKEN`  | o token do passo 2             |

   Opcionais: `GITHUB_BACKUP_BRANCH` (padrão `main`), `GITHUB_BACKUP_PATH`
   (padrão `quizarena.db.gz`), `GITHUB_BACKUP_INTERVAL_MINUTES` (padrão `10`).

**Como funciona:**
- Quando há gravação nova (conta criada, partida terminada, troca de senha…),
  o banco é enviado a cada 10 min, e **uma última vez ao receber o
  desligamento** (deploy ou suspensão do Render). Cada envio é um commit que
  sobrescreve um único arquivo; o histórico do Git guarda as versões antigas.
- Ao subir **sem banco local** (deploy novo), o servidor baixa o backup do
  GitHub antes de abrir o banco. Os logs mostram `[backup-remoto] banco
  restaurado de ...`.
- Se o GitHub estiver fora do ar nessa hora, o servidor **não sobe** (o Render
  tenta de novo). É de propósito: subir vazio e depois enviar esse banco vazio
  por cima do backup bom seria pior. `REMOTE_RESTORE_OPTIONAL=1` desliga essa
  trava.
- Banco vazio nunca é enviado.

**Limite:** o que aconteceu depois do último envio (até ~10 min) pode se perder
se o Render derrubar o processo sem aviso (falha/`SIGKILL`); em deploy e
suspensão normais o envio final acontece. Para zero perda, use um Render Disk
(pago) com `DATA_DIR=/data`.

### Variáveis de ambiente de limites anti-abuso

Todas têm um padrão razoável para uso pequeno/médio; ajuste se sua
instância tiver um público maior ou um host com menos memória.

| Variável                     | Padrão      | O que controla                                                        |
|-------------------------------|-------------|------------------------------------------------------------------------|
| `MAX_PACKET_BYTES`             | `8192`      | Tamanho máximo de um pacote Socket.IO (padrão da lib é 1 MB)           |
| `MAX_ROOMS`                     | `500`       | Teto global de salas simultâneas em memória                            |
| `MAX_ROOMS_PER_IP`             | `5`         | Teto de salas que um mesmo IP pode manter abertas ao mesmo tempo       |
| `ROOM_CREATE_MAX_PER_WINDOW`   | `20`        | Máximo de `create_room` por IP a cada 10 minutos                       |
| `CONNECTIONS_PER_IP_LIMIT`     | `40`        | Máximo de conexões (sockets) simultâneas por IP                        |
| `ROOM_IDLE_TIMEOUT_MS`         | `1800000` (30 min) | Sala sem nenhuma atividade por mais tempo que isso é removida    |
| `MIN_RANKED_PLAYERS`           | `3`         | Jogadores mínimos na largada para a partida valer no ranking           |
| `LEADERBOARD_MIN_GAMES`        | (por período) | Força um mínimo único de partidas p/ Média e Precisão (padrão: 5 / 3 / 2) |
| `MIN_TOTAL_QUESTIONS`          | `3`         | Mínimo de perguntas que o host pode escolher (os testes usam 1)        |
| `CORS_ORIGIN`                   | dev: `*` · produção: só mesma origem | Origem(ns) permitidas no Socket.IO, separadas por vírgula (ou `*` para liberar tudo de propósito). Em produção (`NODE_ENV=production`, como no Dockerfile), sem esta variável **só a mesma origem** é aceita — o frontend servido por este processo não precisa de CORS. Só defina se o frontend estiver em outro domínio |
| `TRUST_PROXY`                   | `0` (`1` no Render) | Nº de proxies reversos confiáveis na frente do servidor. Com `0`, o cabeçalho `X-Forwarded-For` é **ignorado** (não dá para forjar IP). Atrás de Render/Railway/Fly/Nginx simples use `1`; sem isso, todos os jogadores parecem ter o IP do proxy — ver "Atrás de proxy" abaixo |

### Cabeçalhos de segurança

O servidor envia `helmet` com CSP restrita (`script-src 'self'`, fontes só do
Google Fonts, `frame-ancestors 'none'`) e não expõe `X-Powered-By`. Se você
adicionar scripts/estilos externos ao `index.html`, inclua a origem em
`server.js` (bloco `helmet`), ou o navegador os bloqueará.

### Atrás de proxy: por que todos aparecem com o mesmo IP

Hosts como Render, Railway, Fly ou um Nginx colocam um **proxy reverso** na
frente do Node: a conexão TCP chega com o IP do proxy, e o IP real do jogador
vem no cabeçalho `X-Forwarded-For`. Como esse cabeçalho pode ser forjado pelo
cliente, o servidor só o usa se você disser quantos proxies confiáveis existem
(`TRUST_PROXY`). Sem isso, todos os jogadores parecem ter o **mesmo IP** e
dividem limites, bloqueios e banimentos.

| Onde roda | Configuração |
|-----------|--------------|
| Render | automático (`RENDER` detectado → `TRUST_PROXY=1`); o `render.yaml` também define |
| Railway / Fly / Nginx / Caddy / Traefik simples (1 proxy) | `TRUST_PROXY=1` |
| CDN + proxy (ex.: Cloudflare → Nginx) | `TRUST_PROXY=2` |
| Node exposto direto, sem proxy | `TRUST_PROXY=0` (padrão) |

No boot o log mostra `[rede] TRUST_PROXY=...`. Se chegar `X-Forwarded-For` com
`TRUST_PROXY=0`, o servidor avisa uma vez no log (sinal de proxy não
configurado). Arquivos prontos: `render.yaml` (na raiz do repositório), `docker-compose.yml` e
`.env.example`.

### Estrutura do servidor

`server.js` continua sendo o ponto de entrada (salas, sockets, fluxo do jogo),
mas a lógica independente foi extraída em módulos testáveis:

| Módulo | Conteúdo |
|--------|----------|
| `client-ip.js` | IP do cliente atrás de proxy (`TRUST_PROXY`) |
| `rate-limits.js` | Limitadores por chave: bloqueio por tentativas e janela deslizante (login, admin, cadastro, criação de sala) |
| `passwords.js` | scrypt, código de recuperação, comparação em tempo constante |
| `scoring.js` | Pontuação, folga de rede e curva de dificuldade (funções puras) |

### CI e dependências

`.github/workflows/ci.yml` roda `npm ci`, `npm test`, `npm audit` e o
`docker build` a cada push/PR; `.github/dependabot.yml` abre PRs semanais de
atualização. O `Dockerfile` usa `npm ci` (exige `package-lock.json`
sincronizado: rode `npm install` localmente após mudar dependências).

### PWA

`public/manifest.webmanifest` + ícones permitem "Adicionar à tela inicial" no
celular. Não há service worker: o jogo precisa de conexão em tempo real, então
não há modo offline.

## Testes automatizados

```bash
cd server
npm install   # inclui socket.io-client, usado só pelos testes (devDependency)
npm test
```

Usa o test runner nativo do Node (`node --test`, sem framework externo) e
`socket.io-client` para simular jogadores de verdade conectando via
WebSocket num servidor real, subido numa porta livre e com seu próprio
banco SQLite temporário (nada disso toca a porta/dados de produção).
Arquivos em `tests/`:

| Arquivo                    | Cobre                                                                 |
|-----------------------------|------------------------------------------------------------------------|
| `full-game.test.js`         | Lobby → perguntas → pódio; placar geral acumulando entre partidas     |
| `rematch.test.js`           | Revanche: pódio → lobby com os mesmos jogadores e placar zerado; só o host, só após o fim |
| `persistence.test.js`       | Backup ao encerrar, auto-restauração com banco apagado, rotação, sem duplicatas, scripts backup/restore |
| `remote-backup.test.js`     | Backup no GitHub (servidor falso): envio, restauração em disco novo, trava se o GitHub cair, arquivo corrompido |
| `reconnect.test.js`         | Reconexão dentro do grace period; expiração e remoção definitiva      |
| `moderation.test.js`        | Expulsar, banir (+ bloqueio por IP), proteção contra não-host, transferir liderança |
| `chat.test.js`              | Envio/recebimento, histórico para quem entra depois, limite anti-spam |
| `censorship.test.js`        | Censura de spoiler (texto da opção e "letra B") durante a pergunta, liberada após o reveal |
| `client-ip.test.js`         | Resolução de IP atrás de proxy (`TRUST_PROXY`): `X-Forwarded-For` forjado é ignorado |
| `security.test.js`          | Cabeçalhos/CSP, spoof de `X-Forwarded-For` vs. limite por IP, payloads malformados |
| `scoring-unit.test.js`      | Pontuação, folga de rede, bônus e curva de dificuldade |
| `rate-limits-unit.test.js`  | Limitadores, scrypt, código de recuperação |
| `report.test.js`            | Reportar pergunta (motivo válido, motivo inválido, pergunta que já mudou) |

Ao adicionar uma funcionalidade nova, o ideal é escrever o teste antes (ou
junto) — é isso que evita que uma mudança futura quebre silenciosamente algo
que já funcionava (chat, reconexão, moderação...), como já aconteceu uma vez
nesta conversa.

## Docker

```bash
cd server
docker build -t quizarena-server .
docker run -p 3000:3000 -e DATA_DIR=/data -e TRUST_PROXY=1 -v quizarena_data:/data quizarena-server   # TRUST_PROXY=1 só se houver proxy na frente
```

A imagem usa `node:22-slim` (exige Node ≥22.5 por causa do `node:sqlite`,
ver seção de persistência), expõe a porta 3000 e tem um `HEALTHCHECK`
embutido que chama `/health`. O volume `-v quizarena_data:/data` (combinado
com `DATA_DIR=/data`) é o equivalente, em Docker, ao disco persistente do
Render — sem ele, o placar e o histórico também somem quando o container é
recriado.

## Ampliando o banco de perguntas para 100 por categoria

O banco "de verdade" é `scripts/raw-bank-full.json` — é dele que
`data/questions/*.json` é gerado. Duas formas de adicionar perguntas:

### Opção A — planilha/CSV (mais fácil pra quem não vai editar JSON à mão)

1. Copie `scripts/import-template.csv`, abra no Google Sheets/Excel e
   preencha linhas com as colunas `category, difficulty, question,
   option_a, option_b, option_c, option_d, correct` (`correct` aceita
   `a/b/c/d` ou `0-3`). Exporte como CSV (UTF-8).
2. Importe:

   ```bash
   node scripts/import-csv.js caminho/para/sua-planilha.csv
   ```

   O script valida cada linha, **descarta duplicatas** (contra o banco já
   existente e dentro do próprio CSV — compara o texto da pergunta
   normalizado, ignorando acento/maiúscula/pontuação) e mostra um relatório
   de quantas foram aceitas, rejeitadas ou ignoradas por duplicidade, com o
   número da linha e o motivo de cada uma.
3. Rode o gerador (passo comum às duas opções, ver abaixo).

### Opção B — editar o JSON bruto diretamente

Edite `scripts/raw-bank-full.json` seguindo o schema (ver
`scripts/question-schema.js` para a lista de categorias/dificuldades
válidas):

```json
{ "category": "historia", "difficulty": "medio",
  "question": "...", "options": ["...", "...", "...", "..."],
  "correct_index": 0 }
```

### Depois de A ou B: gerar os arquivos particionados

```bash
npm run generate-questions
```

Isso valida cada pergunta, **descarta duplicatas** (mesmo texto de pergunta
já visto, mesma categoria), embaralha as alternativas, particiona por
categoria, trava em 100/categoria e mostra um relatório com quantas ficaram
faltando em cada uma. Reinicie o servidor depois — o carregamento das
perguntas é cacheado em memória por categoria.

> Atenção: o gerador **reescreve por completo** `data/questions/` a partir
> de `raw-bank-full.json` (e remove arquivos de categorias que não existem
> mais no schema). Ele não lê os arquivos de saída antigos — o
> `raw-bank-full.json` é a única fonte de verdade. `npm run
> generate-questions:example` existe só pra teste/demonstração com um banco
> de exemplo minúsculo — não use esse pra gerar conteúdo de produção.

### Categoria de religião consolidada

A categoria "religiao" reúne, num só recorte, as 61 perguntas do tema
(Cristianismo, Judaísmo, Islamismo e outras religiões — hinduísmo, budismo,
religiões afro-brasileiras, xintoísmo, taoísmo, zoroastrismo, sikhismo,
espiritismo). Chegou a ser dividida em 4 subtemas separados, mas voltou a
ser uma categoria única.

### Reportar pergunta com problema

Durante a tela de revelação, qualquer jogador pode reportar a pergunta que
acabou de cair (resposta errada, ambígua, erro de digitação, desatualizada
ou outro motivo). Isso não corrige nada sozinho — só registra no banco
(tabela `question_reports`, ver `db.js`) pra revisão manual depois:

```bash
node scripts/list-reports.js
```

Mostra um resumo agrupado por pergunta, mais reportada primeiro, com o
texto da pergunta e os motivos — o roteiro pra decidir o que corrigir em
`raw-bank-full.json` e reprocessar com `npm run generate-questions`.

## Estrutura do projeto

```
server/
├── server.js                  # servidor autoritativo (Express + Socket.IO)
├── db.js                      # persistência SQLite (placar, histórico, reports, log de partidas)
├── persistence.js             # pasta de dados estável, backups automáticos e auto-restauração
├── remote-backup.js           # backup remoto num repositório privado do GitHub (Render gratuito)
├── chat-guard.js               # censura de spoiler no chat (também usado na deduplicação de perguntas)
├── Dockerfile / .dockerignore
├── tests/                     # suíte automatizada (node --test + socket.io-client)
├── package.json
├── data/questions/*.json      # banco particionado por categoria (gerado — não editar à mão)
├── (dados)  ~/.quizarena/quizarena.db   # contas + placar + histórico + reports (fora do projeto; DATA_DIR muda o local)
├── scripts/
│   ├── raw-bank-full.json      # banco bruto de verdade (fonte única do conteúdo)
│   ├── question-schema.js      # categorias/dificuldades válidas + validação (compartilhado)
│   ├── csv-parser.js           # parser CSV sem dependências
│   ├── import-csv.js           # importa planilha CSV pro banco bruto
│   ├── import-template.csv     # modelo de planilha pronto pra copiar
│   ├── list-reports.js         # revisa perguntas reportadas por jogadores
│   ├── generate-questions.js   # gera data/questions/*.json a partir do banco bruto
│   └── raw-bank.example.json  # exemplo minúsculo (só pra demonstração)
└── public/                    # cliente estático
    ├── index.html
    ├── style.css
    └── app.js
```

## Limitações conhecidas desta versão de referência

- Estado das salas em memória (um único processo Node): reiniciar o servidor
  apaga salas ativas (placar geral e histórico de perguntas, esses sim,
  sobrevivem — ver seção de persistência). Para escalar horizontalmente
  entre múltiplas instâncias, use o `@socket.io/redis-adapter` e mova
  `rooms`/`sessionIndex` para Redis.
- Banco de perguntas com 433 itens reais (validados e sem duplicatas, ver
  relatório do gerador) distribuídos de forma desigual entre as 12
  categorias (21 a 68 cada); use a importação por CSV ou edite
  `raw-bank-full.json` para chegar a 100/categoria (1.200 no total).
- `node:sqlite` é um recurso experimental do Node (estável desde a 22.5,
  mas a própria documentação do Node avisa que a API pode mudar em versões
  futuras). Se isso for um problema para o seu ambiente, dá para trocar por
  `better-sqlite3` (mesma interface síncrona) sem mudar o resto do código —
  só a implementação de `db.js` muda.
- Os limites anti-abuso (`MAX_ROOMS`, `CONNECTIONS_PER_IP_LIMIT` etc.) va-
  lem por processo: atrás de um proxy/CDN, `clientIpOf` depende do cabeçalho
  `X-Forwarded-For` estar configurado corretamente, ou todo mundo aparenta
  vir do IP do proxy e cai no mesmo balde de limite.
- `package-lock.json` foi gerado antes de `socket.io-client` virar
  devDependency; rode `npm install` localmente (com rede) uma vez para
  atualizá-lo e comite o resultado — o Dockerfile já usa `npm install` (não
  `npm ci`) por causa disso, então o build funciona de qualquer forma, mas
  vale regularizar o lockfile.
