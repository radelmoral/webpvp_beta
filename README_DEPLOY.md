# WEBPVP V3 GitHub Deploy

Esta carpeta está preparada para subir a GitHub sin `node_modules`.

Easypanel debe construir usando el `Dockerfile` incluido. Durante la build se ejecuta:

```bash
npm ci --omit=dev
```

No tienes que ejecutar `npm` manualmente en Easypanel.

## Variables de entorno en Easypanel

```env
DB_HOST=webpvp_mariadb
DB_PORT=3306
DB_USER=save
DB_PASS=...
DB_NAME=Repuestos
JWT_SECRET=...
JWT_EXPIRES_IN=8h
PORT=3000
NODE_ENV=production
```

## Arranque

El Dockerfile arranca:

```bash
node server.js
```

desde `/srv/app`.
