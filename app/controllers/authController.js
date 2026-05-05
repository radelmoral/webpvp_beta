const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

// Mapeo numérico de roles de tu BBDD → nombres usados en la app
const ROL_MAP = { 1: 'admin', 2: 'carrefour', 3: 'eci', 4: 'franquicias', 5: 'eciclinicas' };
// Y al revés, para filtros
const ROL_NUM = { admin: 1, carrefour: 2, eci: 3, franquicias: 4, eciclinicas: 5, ecclinicas: 5 };
let _hasMustChangePasswordCol = null;
let _hasTiendaCol = null;

async function ensureMustChangePasswordColumn() {
  if (_hasMustChangePasswordCol !== null) return _hasMustChangePasswordCol;
  try {
    const [cols] = await db.execute(
      `SELECT COUNT(*) AS n
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'usuarios'
         AND COLUMN_NAME = 'must_change_password'`
    );
    if (Number(cols[0]?.n || 0) > 0) {
      _hasMustChangePasswordCol = true;
      return true;
    }

    await db.execute(
      `ALTER TABLE usuarios
       ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0`
    );
    // Migración inicial: todos los no-admin deberán cambiarla una vez.
    await db.execute(`UPDATE usuarios SET must_change_password = 1 WHERE rol <> 1`);
    _hasMustChangePasswordCol = true;
    return true;
  } catch (err) {
    console.warn('No se pudo habilitar must_change_password:', err.message);
    _hasMustChangePasswordCol = false;
    return false;
  }
}

async function ensureTiendaColumn() {
  if (_hasTiendaCol !== null) return _hasTiendaCol;
  try {
    const [cols] = await db.execute(
      `SELECT COUNT(*) AS n
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'usuarios'
         AND COLUMN_NAME = 'tienda'`
    );
    if (Number(cols[0]?.n || 0) > 0) {
      _hasTiendaCol = true;
      return true;
    }
    await db.execute(`ALTER TABLE usuarios ADD COLUMN tienda VARCHAR(120) NULL AFTER email`);
    _hasTiendaCol = true;
    return true;
  } catch (err) {
    console.warn('No se pudo habilitar tienda en usuarios:', err.message);
    _hasTiendaCol = false;
    return false;
  }
}

async function ensureUsuarioTiendasSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS usuario_tiendas (
      usuario_id INT NOT NULL,
      tienda VARCHAR(120) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (usuario_id, tienda),
      KEY idx_usuario_tiendas_tienda (tienda),
      CONSTRAINT fk_usuario_tiendas_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios (id_usuario)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_spanish_ci
  `);
}

async function getUsuarioTiendas(userId, fallback = null) {
  await ensureUsuarioTiendasSchema();
  const [rows] = await db.execute(
    `SELECT tienda FROM usuario_tiendas WHERE usuario_id = ? ORDER BY tienda`,
    [userId]
  );
  const tiendas = rows.map(r => r.tienda).filter(Boolean);
  if (!tiendas.length && fallback) tiendas.push(fallback);
  return [...new Set(tiendas)];
}

/**
 * POST /api/auth/login
 * Usa la tabla `usuarios` original con columnas:
   *   id_usuario, nombre, usuario, email, clave, rol (1..5)
 * Los hashes son $2y$ (PHP bcrypt) — compatibles con bcryptjs
 */
async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  try {
    const hasMustChangeCol = await ensureMustChangePasswordColumn();
    const hasTiendaCol = await ensureTiendaColumn();
    const selectMustChange = hasMustChangeCol ? 'must_change_password' : '0 AS must_change_password';
    const selectTienda = hasTiendaCol ? 'tienda' : 'NULL AS tienda';
    const [rows] = await db.execute(
      `SELECT id_usuario, nombre, usuario, email, ${selectTienda}, clave, rol, ${selectMustChange}
       FROM usuarios
       WHERE usuario = ?`,
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = rows[0];

    // bcryptjs acepta hashes $2y$ de PHP directamente
    const valid = await bcrypt.compare(password, user.clave);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const rolNombre = ROL_MAP[user.rol] || 'eci';
    const forcePasswordChange = rolNombre !== 'admin' && Number(user.must_change_password || 0) === 1;
    const tiendas = await getUsuarioTiendas(user.id_usuario, user.tienda || null);

    const token = jwt.sign(
      {
        id:       user.id_usuario,
        username: user.usuario,
        nombre:   user.nombre,
        rol:      rolNombre,       // 'admin' | 'carrefour' | 'eci' | 'franquicias' | 'eciclinicas'
        rolNum:   user.rol,        // 1..5  (por si hace falta)
        tienda:   tiendas[0] || user.tienda || null,
        tiendas,
        mustChangePassword: forcePasswordChange,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      user: {
        id:       user.id_usuario,
        nombre:   user.nombre,
        username: user.usuario,
        email:    user.email,
        tienda:   tiendas[0] || user.tienda || null,
        tiendas,
        rol:      rolNombre,
        mustChangePassword: forcePasswordChange,
      }
      ,
      forcePasswordChange
    });

  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * GET /api/auth/me
 */
async function me(req, res) {
  try {
    const hasMustChangeCol = await ensureMustChangePasswordColumn();
    const hasTiendaCol = await ensureTiendaColumn();
    const selectMustChange = hasMustChangeCol ? 'must_change_password' : '0 AS must_change_password';
    const selectTienda = hasTiendaCol ? 'tienda' : 'NULL AS tienda';
    const [rows] = await db.execute(
      `SELECT id_usuario AS id, nombre, usuario AS username, email, ${selectTienda}, rol, ${selectMustChange}
       FROM usuarios WHERE id_usuario = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = rows[0];
    const rolNombre = ROL_MAP[u.rol] || 'eci';
    const mustChangePassword = rolNombre !== 'admin' && Number(u.must_change_password || 0) === 1;
    const tiendas = await getUsuarioTiendas(u.id, u.tienda || null);
    res.json({ ...u, tienda: tiendas[0] || u.tienda || null, tiendas, rol: rolNombre, mustChangePassword });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
}

/**
 * POST /api/auth/change-password-first-login
 * Usuario autenticado (no admin): cambia su contraseña inicial y desactiva el bloqueo.
 */
async function changePasswordFirstLogin(req, res) {
  try {
    const hasMustChangeCol = await ensureMustChangePasswordColumn();
    if (!hasMustChangeCol) {
      return res.status(500).json({ error: 'Función de cambio de contraseña no disponible en este entorno' });
    }
    if (!req.user?.id) return res.status(401).json({ error: 'Token inválido' });

    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const [rows] = await db.execute(
      `SELECT id_usuario, rol, must_change_password
       FROM usuarios
       WHERE id_usuario = ?
       LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const u = rows[0];
    const rolNombre = ROL_MAP[u.rol] || 'eci';
    if (rolNombre === 'admin') {
      return res.status(400).json({ error: 'Este cambio solo aplica a usuarios no administradores' });
    }
    if (Number(u.must_change_password || 0) !== 1) {
      return res.status(400).json({ error: 'Tu usuario no requiere cambio de contraseña inicial' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute(
      `UPDATE usuarios
       SET clave = ?, must_change_password = 0
       WHERE id_usuario = ?`,
      [hash, req.user.id]
    );

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar la contraseña' });
  }
}

module.exports = { login, me, changePasswordFirstLogin, ensureMustChangePasswordColumn, ensureTiendaColumn, ensureUsuarioTiendasSchema, getUsuarioTiendas, ROL_MAP, ROL_NUM };
