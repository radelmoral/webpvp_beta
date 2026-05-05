const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { ensureMustChangePasswordColumn } = require('../controllers/authController');

/**
 * Verifica el token JWT en la cabecera Authorization: Bearer <token>
 * Adjunta req.user = { id, username, rol }
 */
async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;

    // Si el usuario debe cambiar contraseña inicial, bloquear el resto de endpoints.
    if (payload.rol !== 'admin') {
      const hasMustChangeCol = await ensureMustChangePasswordColumn();
      if (hasMustChangeCol) {
        const [rows] = await db.execute(
          `SELECT rol, must_change_password
           FROM usuarios
           WHERE id_usuario = ?
           LIMIT 1`,
          [payload.id]
        );
        if (rows.length) {
          const dbRol = Number(rows[0].rol || 0);
          const mustChange = Number(rows[0].must_change_password || 0) === 1;
          const allowedPaths = ['/auth/me', '/auth/change-password-first-login'];
          if (dbRol !== 1 && mustChange && !allowedPaths.includes(req.path)) {
            return res.status(403).json({
              error: 'Debes cambiar tu contraseña antes de continuar',
              code: 'PASSWORD_CHANGE_REQUIRED'
            });
          }
        }
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

/**
 * Restringe el acceso a uno o varios roles
 * Uso: router.get('/ruta', auth, role('admin'), handler)
 */
function role(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Acceso denegado — rol insuficiente' });
    }
    next();
  };
}

module.exports = { authMiddleware, role };
