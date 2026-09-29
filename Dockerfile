# QuizArena — servidor autoritativo (Express + Socket.IO + SQLite nativo)
#
# Exige Node >=22.5 por causa do módulo nativo node:sqlite (ver db.js) —
# por isso a imagem base é a 22, não a "lts" genérica (que hoje ainda
# resolveria para 22, mas pode mudar de LTS antes deste Dockerfile).
FROM node:22.22-slim

WORKDIR /app

# Copia primeiro só os manifestos para aproveitar o cache do Docker: se só o
# código mudar (não as dependências), a camada de npm install é reaproveitada.
COPY package.json package-lock.json ./

# npm ci: instala EXATAMENTE o que está no package-lock.json (build
# reprodutível; falha se package.json e lockfile divergirem — rode
# `npm install` localmente e versione o lockfile). --omit=dev deixa de fora o
# socket.io-client (usado só pelos testes).
RUN npm ci --omit=dev

COPY . .

# Garante que a pasta de dados padrão (usada quando DATA_DIR não é definido)
# seja gravável pelo usuário sem privilégios abaixo. Se DATA_DIR apontar para
# um volume montado externamente (disco persistente), esse volume precisa
# ser gravável pelo mesmo uid (1000, usuário "node" da imagem oficial).
RUN mkdir -p data && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
# TRUST_PROXY NÃO é definido aqui de propósito: o padrão seguro é 0 (ignora
# X-Forwarded-For). Atrás de proxy, passe -e TRUST_PROXY=1 (ver README).
EXPOSE 3000

# Ver server.js: rota /health devolve 200 com contadores agregados. O Render
# (e outros hosts) também consegue apontar seu próprio healthcheck pra cá.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Sem "root": roda como o usuário "node", já criado pela imagem base.
USER node

CMD ["npm", "start"]
