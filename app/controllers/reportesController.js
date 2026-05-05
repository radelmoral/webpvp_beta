const db = require('../config/db');

let _schemaReady = false;
async function ensureReportesSchema() {
  if (_schemaReady) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reportes_referencias (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      referencia VARCHAR(120) NOT NULL,
      catalogo VARCHAR(30) NOT NULL,
      categoria VARCHAR(120) NULL,
      marca VARCHAR(120) NULL,
      modelo VARCHAR(160) NULL,
      etiqueta VARCHAR(255) NULL,
      motivo TEXT NOT NULL,
      estado ENUM('pendiente', 'resuelto', 'rechazado') NOT NULL DEFAULT 'pendiente',
      comentario_admin TEXT NULL,
      motivo_rechazo TEXT NULL,
      usuario_id INT NOT NULL,
      admin_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_estado_created (estado, created_at),
      INDEX idx_usuario_created (usuario_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  const [cols] = await db.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'reportes_referencias'
        AND COLUMN_NAME IN ('tipo_reporte', 'pvp_reportado', 'motivo_rechazo')`
  );
  const hasTipo = cols.some(c => c.COLUMN_NAME === 'tipo_reporte');
  const hasPvp = cols.some(c => c.COLUMN_NAME === 'pvp_reportado');
  const hasMotivoRechazo = cols.some(c => c.COLUMN_NAME === 'motivo_rechazo');
  if (!hasTipo) {
    await db.execute(
      `ALTER TABLE reportes_referencias
       ADD COLUMN tipo_reporte ENUM('referencia', 'pvp') NOT NULL DEFAULT 'referencia' AFTER etiqueta`
    );
  }
  if (!hasPvp) {
    await db.execute(
      `ALTER TABLE reportes_referencias
       ADD COLUMN pvp_reportado DECIMAL(10,2) NULL AFTER tipo_reporte`
    );
  }
  if (!hasMotivoRechazo) {
    await db.execute(
      `ALTER TABLE reportes_referencias
       ADD COLUMN motivo_rechazo TEXT NULL AFTER comentario_admin`
    );
  }
  await db.execute(
    `ALTER TABLE reportes_referencias
     MODIFY COLUMN estado ENUM('pendiente','resuelto','rechazado') NOT NULL DEFAULT 'pendiente'`
  );
  _schemaReady = true;
}

/** GET /api/reportes-referencias */
async function listar(req, res) {
  try {
    await ensureReportesSchema();
    const { estado } = req.query;
    const where = [];
    const params = [];

    if (req.user.rol !== 'admin') {
      where.push('r.usuario_id = ?');
      params.push(req.user.id);
    }
    if (estado) {
      where.push('r.estado = ?');
      params.push(estado);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await db.execute(
      `SELECT r.id, r.referencia, r.catalogo, r.categoria, r.marca, r.modelo, r.etiqueta,
              r.tipo_reporte, r.pvp_reportado,
              r.motivo, r.estado, r.comentario_admin, r.motivo_rechazo, r.created_at, r.updated_at,
              u.nombre AS solicitante
       FROM reportes_referencias r
       LEFT JOIN usuarios u ON u.id_usuario = r.usuario_id
       ${whereSQL}
       ORDER BY r.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar reportes' });
  }
}

/** POST /api/reportes-referencias */
async function crear(req, res) {
  try {
    await ensureReportesSchema();
    if (['franquicias', 'eciclinicas', 'ecclinicas'].includes(String(req.user?.rol || '').toLowerCase())) {
      return res.status(403).json({ error: 'Tu rol no tiene permiso para reportar referencias' });
    }
    const { referencia, catalogo, categoria, marca, modelo, etiqueta, motivo, tipo_reporte, pvp_reportado } = req.body;
    if (!referencia || !catalogo || !motivo || !String(motivo).trim()) {
      return res.status(400).json({ error: 'referencia, catalogo y motivo son obligatorios' });
    }
    const catalogosValidos = ['repuestos', 'telefonos', 'apple', 'oppo', 'consolas'];
    if (!catalogosValidos.includes(String(catalogo))) {
      return res.status(400).json({ error: 'Catálogo inválido' });
    }
    const tipo = String(tipo_reporte || 'referencia').toLowerCase();
    if (!['referencia', 'pvp'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de reporte inválido' });
    }
    const pvpNum = tipo === 'pvp'
      ? Number(pvp_reportado)
      : null;
    if (tipo === 'pvp' && (!Number.isFinite(pvpNum) || pvpNum < 0)) {
      return res.status(400).json({ error: 'Para reportes de PVP debes indicar un PVP válido' });
    }

    const [result] = await db.execute(
      `INSERT INTO reportes_referencias
       (referencia, catalogo, categoria, marca, modelo, etiqueta, tipo_reporte, pvp_reportado, motivo, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(referencia).trim(),
        String(catalogo).trim(),
        categoria || null,
        marca || null,
        modelo || null,
        etiqueta || null,
        tipo,
        tipo === 'pvp' ? Number(pvpNum.toFixed(2)) : null,
        String(motivo).trim(),
        req.user.id
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Reporte enviado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear reporte' });
  }
}

/** PUT /api/reportes-referencias/:id/resolver  — admin */
async function resolver(req, res) {
  try {
    await ensureReportesSchema();
    const { comentario_admin } = req.body;
    const [result] = await db.execute(
      `UPDATE reportes_referencias
       SET estado = 'resuelto',
           comentario_admin = ?,
           motivo_rechazo = NULL,
           admin_id = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [comentario_admin || null, req.user.id, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Reporte no encontrado o ya resuelto' });
    }
    res.json({ message: 'Reporte marcado como resuelto' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al resolver reporte' });
  }
}

/** PUT /api/reportes-referencias/:id/rechazar  — admin */
async function rechazar(req, res) {
  try {
    await ensureReportesSchema();
    const motivo = String(req.body?.motivo_rechazo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'El motivo del rechazo es obligatorio' });
    const [result] = await db.execute(
      `UPDATE reportes_referencias
       SET estado = 'rechazado',
           motivo_rechazo = ?,
           comentario_admin = NULL,
           admin_id = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [motivo, req.user.id, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Reporte no encontrado o ya procesado' });
    }
    res.json({ message: 'Reporte rechazado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar reporte' });
  }
}

module.exports = { listar, crear, resolver, rechazar };
