const db = require('../config/db');
const { getUsuarioTiendas, ensureUsuarioTiendasSchema } = require('./authController');

const READ_ONLY_ROLES = new Set(['franquicias', 'eciclinicas', 'ecclinicas']);
const VALID_ESTADOS = new Set(['pendiente', 'pedido', 'cancelado', 'sin_stock']);

function normalizeEstado(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'pendiente';
  if (raw === 'pedido' || raw === 'realizado') return 'pedido';
  if (raw === 'cancelado' || raw === 'cancelada') return 'cancelado';
  if (raw === 'sin stock' || raw === 'sinstock' || raw === 'sin_stock') return 'sin_stock';
  if (raw === 'pendiente') return 'pendiente';
  return raw;
}

function toNullableString(value) {
  const str = String(value ?? '').trim();
  return str ? str : null;
}

function toNullableNumber(value) {
  if (value === '' || value === null || typeof value === 'undefined') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return ['si', 'sí', 's', 'true', '1', 'yes'].includes(raw);
}

async function ensurePedidosSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      fecha_envio DATE NULL,
      hora_envio TIME NULL,
      tienda_origen VARCHAR(120) NOT NULL,
      referencia VARCHAR(120) NOT NULL,
      etiqueta VARCHAR(255) NULL,
      unidades DECIMAL(10,2) NOT NULL DEFAULT 1,
      coste_gsm DECIMAL(10,2) NULL,
      coste_interno DECIMAL(10,2) NULL,
      logistica_gsm DECIMAL(10,2) NULL,
      logistica_interna DECIMAL(10,2) NULL,
      pvp_reparacion DECIMAL(10,2) NULL,
      proveedor VARCHAR(160) NULL,
      terminal_en_tienda TINYINT(1) NOT NULL DEFAULT 0,
      numero_presupuesto VARCHAR(120) NULL,
      deposito_15 TINYINT(1) NOT NULL DEFAULT 0,
      numero_factura VARCHAR(120) NULL,
      observaciones TEXT NULL,
      estado ENUM('pendiente','pedido','cancelado','sin_stock') NOT NULL DEFAULT 'pendiente',
      fecha_realizado DATETIME NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pedidos_estado (estado),
      KEY idx_pedidos_tienda (tienda_origen),
      KEY idx_pedidos_fecha (fecha_envio),
      KEY idx_pedidos_ref (referencia),
      KEY idx_pedidos_created_by (created_by),
      CONSTRAINT fk_pedidos_created_by FOREIGN KEY (created_by) REFERENCES usuarios (id_usuario),
      CONSTRAINT fk_pedidos_updated_by FOREIGN KEY (updated_by) REFERENCES usuarios (id_usuario)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_spanish_ci
  `);

  const [cols] = await db.execute(
    `SELECT COUNT(*) AS n
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'usuarios'
        AND COLUMN_NAME = 'tienda'`
  );
  if (!Number(cols[0]?.n || 0)) {
    await db.execute(`ALTER TABLE usuarios ADD COLUMN tienda VARCHAR(120) NULL AFTER email`);
  }
  await ensureUsuarioTiendasSchema();
}

function rowToApi(row) {
  return {
    id: row.id,
    fecha_envio: row.fecha_envio,
    hora_envio: row.hora_envio,
    tienda_origen: row.tienda_origen,
    referencia: row.referencia,
    etiqueta: row.etiqueta,
    unidades: row.unidades,
    coste_gsm: row.coste_gsm,
    coste_interno: row.coste_interno,
    logistica_gsm: row.logistica_gsm,
    logistica_interna: row.logistica_interna,
    pvp_reparacion: row.pvp_reparacion,
    proveedor: row.proveedor,
    terminal_en_tienda: Boolean(row.terminal_en_tienda),
    numero_presupuesto: row.numero_presupuesto,
    deposito_15: Boolean(row.deposito_15),
    numero_factura: row.numero_factura,
    observaciones: row.observaciones,
    estado: row.estado,
    fecha_realizado: row.fecha_realizado,
    created_at: row.created_at,
    updated_at: row.updated_at,
    creado_por: row.creado_por || null,
    actualizado_por: row.actualizado_por || null,
  };
}

async function getUserStores(userId) {
  const [rows] = await db.execute(
    `SELECT tienda, nombre FROM usuarios WHERE id_usuario = ? LIMIT 1`,
    [userId]
  );
  return getUsuarioTiendas(userId, rows[0]?.tienda || null);
}

async function listar(req, res) {
  try {
    await ensurePedidosSchema();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];

    if (req.user.rol !== 'admin') {
      const tiendas = await getUserStores(req.user.id);
      if (tiendas.length) {
        where.push(`(p.tienda_origen IN (${tiendas.map(() => '?').join(',')}) OR p.created_by = ?)`);
        params.push(...tiendas, req.user.id);
      } else {
        where.push('p.created_by = ?');
        params.push(req.user.id);
      }
    } else if (req.query.tienda) {
      where.push('p.tienda_origen = ?');
      params.push(String(req.query.tienda));
    }

    const estado = normalizeEstado(req.query.estado);
    if (req.query.estado && VALID_ESTADOS.has(estado)) {
      where.push('p.estado = ?');
      params.push(estado);
    }

    const q = String(req.query.q || '').trim();
    if (q) {
      where.push('(p.referencia LIKE ? OR p.etiqueta LIKE ? OR p.observaciones LIKE ? OR p.proveedor LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM pedidos p ${whereSQL}`, params);
    const [rows] = await db.execute(
      `SELECT p.*, uc.nombre AS creado_por, uu.nombre AS actualizado_por
         FROM pedidos p
         LEFT JOIN usuarios uc ON p.created_by = uc.id_usuario
         LEFT JOIN usuarios uu ON p.updated_by = uu.id_usuario
        ${whereSQL}
        ORDER BY COALESCE(p.fecha_envio, DATE(p.created_at)) DESC, p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data: rows.map(rowToApi), total: countRows[0]?.total || 0, page, limit });
  } catch (err) {
    console.error('Error listando pedidos:', err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
}

async function tiendas(req, res) {
  try {
    await ensurePedidosSchema();
    const [rows] = await db.execute(
      `SELECT DISTINCT tienda_origen AS tienda
         FROM pedidos
        WHERE tienda_origen IS NOT NULL AND tienda_origen <> ''
        ORDER BY tienda_origen`
    );
    res.json(rows.map(r => r.tienda));
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener tiendas' });
  }
}

async function crear(req, res) {
  if (READ_ONLY_ROLES.has(String(req.user?.rol || '').toLowerCase())) {
    return res.status(403).json({ error: 'Tu rol no tiene permiso para crear pedidos' });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  if (!items.length) return res.status(400).json({ error: 'El pedido está vacío' });

  const conn = await db.getConnection();
  try {
    await ensurePedidosSchema();
    await conn.beginTransaction();
    const ids = [];
    const now = new Date();

    for (const item of items) {
      const tienda = toNullableString(item.tienda_origen || item.tienda);
      const referencia = toNullableString(item.referencia);
      const unidades = toNullableNumber(item.unidades);
      if (!tienda || !referencia || !unidades) {
        throw Object.assign(new Error('Tienda, referencia y unidades son obligatorias'), { status: 400 });
      }

      const [result] = await conn.execute(
        `INSERT INTO pedidos
           (fecha_envio, hora_envio, tienda_origen, referencia, etiqueta, unidades,
            pvp_reparacion, proveedor, terminal_en_tienda, numero_presupuesto,
            deposito_15, numero_factura, observaciones, estado, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`,
        [
          now.toISOString().slice(0, 10),
          now.toTimeString().slice(0, 8),
          tienda,
          referencia,
          toNullableString(item.etiqueta),
          unidades,
          toNullableNumber(item.pvp_reparacion || item.pvpReparacion),
          toNullableString(item.proveedor),
          toBoolean(item.terminal_en_tienda ?? item.terminalTienda),
          toNullableString(item.numero_presupuesto || item.numeroPresupuesto),
          toBoolean(item.deposito_15 ?? item.deposito15),
          toNullableString(item.numero_factura || item.numeroFactura),
          toNullableString(item.observaciones),
          req.user.id,
          req.user.id,
        ]
      );
      ids.push(result.insertId);
    }

    await conn.commit();
    res.status(201).json({ ids, message: 'Pedido creado correctamente' });
  } catch (err) {
    await conn.rollback();
    const status = err.status || 500;
    res.status(status).json({ error: status === 500 ? 'Error al crear pedido' : err.message });
  } finally {
    conn.release();
  }
}

async function actualizar(req, res) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin puede actualizar pedidos' });

  const estado = normalizeEstado(req.body.estado);
  if (req.body.estado && !VALID_ESTADOS.has(estado)) {
    return res.status(400).json({ error: 'Estado no válido' });
  }

  try {
    await ensurePedidosSchema();
    const fields = [
      ['coste_gsm', toNullableNumber(req.body.coste_gsm)],
      ['coste_interno', toNullableNumber(req.body.coste_interno)],
      ['logistica_gsm', toNullableNumber(req.body.logistica_gsm)],
      ['logistica_interna', toNullableNumber(req.body.logistica_interna)],
      ['proveedor', toNullableString(req.body.proveedor)],
      ['observaciones', toNullableString(req.body.observaciones)],
    ];
    const sets = fields.map(([name]) => `${name} = ?`);
    const params = fields.map(([, value]) => value);

    if (req.body.estado) {
      sets.push('estado = ?');
      params.push(estado);
      sets.push(`fecha_realizado = CASE WHEN ? = 'pedido' AND fecha_realizado IS NULL THEN NOW() ELSE fecha_realizado END`);
      params.push(estado);
    }
    sets.push('updated_by = ?');
    params.push(req.user.id);
    params.push(req.params.id);

    const [result] = await db.execute(
      `UPDATE pedidos SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ message: 'Pedido actualizado correctamente' });
  } catch (err) {
    console.error('Error actualizando pedido:', err);
    res.status(500).json({ error: 'Error al actualizar pedido' });
  }
}

async function resumen(req, res) {
  try {
    await ensurePedidosSchema();
    const where = [];
    const params = [];
    if (req.user.rol !== 'admin') {
      const tiendas = await getUserStores(req.user.id);
      if (tiendas.length) {
        where.push(`(tienda_origen IN (${tiendas.map(() => '?').join(',')}) OR created_by = ?)`);
        params.push(...tiendas, req.user.id);
      } else {
        where.push('created_by = ?');
        params.push(req.user.id);
      }
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await db.execute(
      `SELECT estado, COUNT(*) AS total FROM pedidos ${whereSQL} GROUP BY estado`,
      params
    );
    res.json({
      total: rows.reduce((acc, r) => acc + Number(r.total || 0), 0),
      estados: Object.fromEntries(rows.map(r => [r.estado, Number(r.total || 0)])),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener resumen de pedidos' });
  }
}

module.exports = { listar, tiendas, crear, actualizar, resumen, ensurePedidosSchema, normalizeEstado };
