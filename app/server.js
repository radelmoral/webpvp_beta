require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;

// Necesario cuando Express está detrás de un proxy inverso (Easypanel/Traefik)
app.set('trust proxy', 1);

// ── Seguridad ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Rate limiter específico para login (protege credenciales sin bloquear uso normal)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Inténtalo en unos minutos.' },
});
app.use('/api/auth/login', loginLimiter);

// Límite general para escrituras (POST/PUT/PATCH/DELETE).
// Las lecturas GET no se limitan aquí para no romper refrescos en tiempo real del panel.
const apiWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  message: { error: 'Demasiadas peticiones. Inténtalo en unos minutos.' },
});
app.use('/api', apiWriteLimiter);

// ── Body parser ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API routes ─────────────────────────────────────────────
app.use('/api', require('./routes/index'));
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta API no encontrada' });
});

// ── Frontend estático ──────────────────────────────────────
// En producción (Docker) los estáticos están en la misma carpeta que server.js
// En desarrollo local están en la carpeta padre (..)
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..');

// Bloquear acceso directo al formulario legado de pedidos.
// La entrada válida es la sección "Pedidos" integrada en index.html.
app.use((req, res, next) => {
  if (req.path.toLowerCase() === '/pedidos.html') {
    return res.status(404).send('Not Found');
  }
  next();
});

app.use(express.static(STATIC_DIR, {
  index: 'index.html',
}));

// Archivos HTML específicos servidos directamente
const STATIC_HTML = ['login.html'];
app.get('/:file.html', (req, res, next) => {
  const file = req.params.file + '.html';
  if (!STATIC_HTML.includes(file)) return next();
  const filePath = path.join(STATIC_DIR, file);
  res.sendFile(filePath, err => {
    if (err) next(); // si no existe, deja pasar al catch-all
  });
});

// Cualquier otra ruta no-API devuelve el frontend (SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const filePath = path.join(STATIC_DIR, 'index.html');
  console.log(`📄  Sirviendo: ${filePath}`);
  res.sendFile(filePath, err => {
    if (err) console.error(`❌  Error sirviendo HTML: ${err.message}`);
  });
});

// ── Error handler global ───────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌  Error no controlado:', err.message);
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message : 'Error interno del servidor'
  });
});

// ── Arranque ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  SAVE PVP arrancado en http://localhost:${PORT}`);
  console.log(`📡  API disponible en  http://localhost:${PORT}/api`);
  console.log(`🌍  Entorno: ${process.env.NODE_ENV || 'development'}\n`);
});
