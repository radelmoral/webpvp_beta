FROM node:20-alpine

WORKDIR /srv/app

COPY app/package*.json ./
RUN npm ci --omit=dev

COPY app/ ./

WORKDIR /srv
COPY index.html login.html Pedidos.html save_logo.png ./

WORKDIR /srv/app

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
