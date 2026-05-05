# SAVE PVP — Guía de instalación

## Requisitos previos
- Node.js 18 o superior
- Tu BBDD MariaDB existente (`Repuestos`) ya en marcha
- npm

---

## 1. Crear SOLO la tabla nueva (no toca nada existente)

Tu BBDD `Repuestos` ya tiene todas las tablas. Solo hay que añadir `solicitudes_pvp`:

```bash
mysql -u tu_usuario -p Repuestos < app/config/migrate.sql
```

✅ Esto **no modifica** ninguna tabla existente (repuestos, usuarios, apple_original, etc.)

---

## 2. Configurar las variables de entorno

```bash
cd app
cp .env.example .env
```

Edita `.env` con tus credenciales reales:

```env
DB_HOST=localhost
DB_PORT=3306
DB_NAME=Repuestos
DB_USER=tu_usuario_mariadb
DB_PASSWORD=tu_contraseña_mariadb
JWT_SECRET=pon_aqui_una_clave_larga_y_segura
JWT_EXPIRES_IN=8h
PORT=3000
NODE_ENV=production
```

---

## 3. Instalar dependencias y arrancar

```bash
cd app
npm install
npm start
```

Disponible en **http://localhost:3000**

---

## Roles en tu BBDD existente

| Número en BBDD | Nombre en la app | Acceso |
|:--------------:|------------------|--------|
| `1` | Admin | Todo — Administración, gestión de solicitudes, usuarios |
| `2` | Carrefour | Dashboard, Tarifas, Solicitar PVP, Mis Solicitudes |
| `3` | ECI | Dashboard, Tarifas, Solicitar PVP, Mis Solicitudes |

Los usuarios y contraseñas son los que ya tienes en la tabla `usuarios`. Las contraseñas hash `$2y$` de PHP funcionan directamente — no hay que regenerarlas.

---

## Tablas utilizadas

| Tabla | Uso |
|-------|-----|
| `repuestos` | Catálogo principal de repuestos y tarifas |
| `apple_original` | Repuestos originales Apple |
| `oppo_original` | Repuestos originales Oppo |
| `telefonos` | Catálogo de teléfonos |
| `usuarios` | Autenticación y roles |
| `solicitudes_pvp` | ⭐ Nueva — solicitudes de PVP pendientes/aprobadas/rechazadas |

---

## API REST

| Método | Ruta | Rol |
|--------|------|-----|
| POST | `/api/auth/login` | Público |
| GET | `/api/auth/me` | Autenticado |
| GET | `/api/repuestos` | Autenticado |
| POST/PUT/DELETE | `/api/repuestos` | Admin |
| GET | `/api/apple` | Autenticado |
| GET | `/api/oppo` | Autenticado |
| GET | `/api/telefonos` | Autenticado |
| GET | `/api/solicitudes` | Autenticado (filtra por rol) |
| POST | `/api/solicitudes` | Autenticado |
| PUT | `/api/solicitudes/:id/aprobar` | Admin |
| PUT | `/api/solicitudes/:id/rechazar` | Admin |
| GET/POST | `/api/usuarios` | Admin |
| GET | `/api/categorias` | Autenticado |
