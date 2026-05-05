const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { ROL_MAP, ROL_NUM, ensureMustChangePasswordColumn, ensureTiendaColumn } = require('./authController');

/**
 * Tabla real: `usuarios`
 * Columnas: id_usuario, nombre, usuario, email, clave, rol (1/2/3)
 * Roles: 1=admin, 2=carrefour, 3=eci
 */

async function ensureUsuarioTiendasSchema(conn = db) {
  await conn.execute(`
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

function normalizeTiendas(input, fallback = null) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(',') : []);
  const values = raw
    .map(v => String(v || '').trim())
    .filter(Boolean);
  if (!values.length && fallback) values.push(String(fallback).trim());
  return [...new Set(values.filter(Boolean))];
}

async function replaceUsuarioTiendas(conn, usuarioId, tiendas) {
  await ensureUsuarioTiendasSchema(conn);
  await conn.execute('DELETE FROM usuario_tiendas WHERE usuario_id = ?', [usuarioId]);
  for (const tienda of tiendas) {
    await conn.execute(
      'INSERT INTO usuario_tiendas (usuario_id, tienda) VALUES (?, ?)',
      [usuarioId, tienda]
    );
  }
}

/** GET /api/usuarios  — solo admin */
async function listar(req, res) {
  try {
    await ensureTiendaColumn();
    await ensureUsuarioTiendasSchema();
    const [rows] = await db.execute(
      `SELECT id_usuario AS id, nombre, usuario AS username, email, tienda, rol
       FROM usuarios ORDER BY id_usuario`
    );
    const [storeRows] = await db.execute(
      `SELECT usuario_id, tienda FROM usuario_tiendas ORDER BY tienda`
    );
    const storesByUser = storeRows.reduce((acc, row) => {
      if (!acc[row.usuario_id]) acc[row.usuario_id] = [];
      acc[row.usuario_id].push(row.tienda);
      return acc;
    }, {});
    // Convertir rol numérico a nombre legible
    const data = rows.map(u => {
      const tiendas = storesByUser[u.id] || normalizeTiendas([], u.tienda);
      return { ...u, tiendas, tienda: tiendas[0] || u.tienda || null, rolNombre: ROL_MAP[u.rol] || 'eci' };
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
}

/** POST /api/usuarios  — solo admin */
async function crear(req, res) {
  const { nombre, username, email, tienda, tiendas, password, rol } = req.body;

  if (!nombre || !username || !password || !rol) {
    return res.status(400).json({ error: 'nombre, username, password y rol son obligatorios' });
  }

  // Aceptar rol como nombre ('admin','carrefour','eci') o como número (1,2,3)
  const rolNum = typeof rol === 'number' ? rol : (ROL_NUM[rol] || 3);

  try {
    const hasMustChangeCol = await ensureMustChangePasswordColumn();
    await ensureTiendaColumn();
    await ensureUsuarioTiendasSchema();
    // Generar hash compatible con bcryptjs ($2a$) — válido también en PHP
    const hash = await bcrypt.hash(password, 10);
    const tiendasNorm = normalizeTiendas(tiendas, tienda);
    const tiendaPrincipal = tiendasNorm[0] || null;
    let result;
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      if (hasMustChangeCol) {
        [result] = await conn.execute(
          'INSERT INTO usuarios (nombre, usuario, email, tienda, clave, rol, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [nombre, username, email || '', tiendaPrincipal, hash, rolNum, rolNum === 1 ? 0 : 1]
        );
      } else {
        [result] = await conn.execute(
          'INSERT INTO usuarios (nombre, usuario, email, tienda, clave, rol) VALUES (?, ?, ?, ?, ?, ?)',
          [nombre, username, email || '', tiendaPrincipal, hash, rolNum]
        );
      }
      await replaceUsuarioTiendas(conn, result.insertId, tiendasNorm);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(201).json({ id: result.insertId, message: 'Usuario creado correctamente' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El username o email ya existe' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
}

/** PUT /api/usuarios/:id  — solo admin */
async function actualizar(req, res) {
  const { nombre, username, email, tienda, tiendas, rol, password } = req.body;
  const rolNum = rol !== undefined
    ? (typeof rol === 'number' ? rol : (ROL_NUM[rol] || 3))
    : null;

  try {
    const hasMustChangeCol = await ensureMustChangePasswordColumn();
    await ensureTiendaColumn();
    await ensureUsuarioTiendasSchema();
    const tiendasNorm = normalizeTiendas(tiendas, tienda);
    const tiendaPrincipal = tiendasNorm[0] || null;
    let effectiveRolNum = rolNum;
    if (effectiveRolNum === null) {
      const [rows] = await db.execute(
        'SELECT rol FROM usuarios WHERE id_usuario = ? LIMIT 1',
        [req.params.id]
      );
      effectiveRolNum = rows[0]?.rol || 3;
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      if (hasMustChangeCol) {
        await conn.execute(
          `UPDATE usuarios SET nombre=?, usuario=?, email=?, tienda=?${rolNum ? ', rol=?' : ''}, clave=?, must_change_password=? WHERE id_usuario=?`,
          rolNum
            ? [nombre, username, email || '', tiendaPrincipal, rolNum, hash, effectiveRolNum === 1 ? 0 : 1, req.params.id]
            : [nombre, username, email || '', tiendaPrincipal, hash, effectiveRolNum === 1 ? 0 : 1, req.params.id]
        );
      } else {
        await conn.execute(
          `UPDATE usuarios SET nombre=?, usuario=?, email=?, tienda=?${rolNum ? ', rol=?' : ''}, clave=? WHERE id_usuario=?`,
          rolNum
            ? [nombre, username, email || '', tiendaPrincipal, rolNum, hash, req.params.id]
            : [nombre, username, email || '', tiendaPrincipal, hash, req.params.id]
        );
      }
    } else {
      await conn.execute(
        `UPDATE usuarios SET nombre=?, usuario=?, email=?, tienda=?${rolNum ? ', rol=?' : ''} WHERE id_usuario=?`,
        rolNum
          ? [nombre, username, email || '', tiendaPrincipal, rolNum, req.params.id]
          : [nombre, username, email || '', tiendaPrincipal, req.params.id]
      );
    }
      await replaceUsuarioTiendas(conn, req.params.id, tiendasNorm);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ message: 'Usuario actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El username o email ya existe' });
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
}

/** DELETE /api/usuarios/:id  — solo admin */
async function eliminar(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de usuario inválido' });
  }

  // Evitar borrado del propio usuario admin en sesión.
  if (req.user?.id === id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario en sesión' });
  }

  try {
    const [result] = await db.execute(
      'DELETE FROM usuarios WHERE id_usuario = ?',
      [id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
}

/** GET /api/categorias — extraídas dinámicamente de la tabla repuestos */
async function listarCategorias(req, res) {
  // Delegado al repuestosController para centralizar
  const repCtrl = require('./repuestosController');
  return repCtrl.listarCategorias(req, res);
}

/** POST /api/categorias  — solo admin
 *  En tu BBDD no hay tabla de categorías separada, así que esto solo
 *  devuelve confirmación (la categoría se añadirá al crear/editar un repuesto)
 */
async function crearCategoria(req, res) {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  // La categoría se crea implícitamente al insertar un repuesto con ese valor
  res.status(201).json({ nombre: nombre.trim(), message: 'Categoría registrada — se aplicará al crear el primer repuesto con este nombre' });
}

module.exports = { listar, crear, actualizar, eliminar, listarCategorias, crearCategoria, ensureUsuarioTiendasSchema, normalizeTiendas };
