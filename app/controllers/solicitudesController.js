const db = require('../config/db');

let _schemaReady = false;
async function ensureSolicitudesSchema() {
  if (_schemaReady) return;
  const [cols] = await db.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'solicitudes_pvp'
        AND COLUMN_NAME IN ('marca', 'modelo')`
  );
  const hasMarca = cols.some(c => c.COLUMN_NAME === 'marca');
  const hasModelo = cols.some(c => c.COLUMN_NAME === 'modelo');
  if (!hasMarca) {
    await db.execute(`ALTER TABLE solicitudes_pvp ADD COLUMN marca VARCHAR(120) NULL AFTER categoria`);
  }
  if (!hasModelo) {
    await db.execute(`ALTER TABLE solicitudes_pvp ADD COLUMN modelo VARCHAR(160) NULL AFTER marca`);
  }
  _schemaReady = true;
}

async function buscarReferenciaExistente(referenciaRaw) {
  const referencia = String(referenciaRaw || '').trim();
  if (!referencia) return { existe: false };

  const refParam = referencia.toUpperCase();
  const refNorm = refParam.replace(/[.\s\-_]/g, '');
  const normExpr = "UPPER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(referencia), ' ', ''), '-', ''), '.', ''), '_', ''))";
  const checks = await Promise.all([
    db.execute(
      `SELECT referencia FROM repuestos
       WHERE UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?
       LIMIT 1`,
      [refParam, refNorm]
    ),
    db.execute(
      `SELECT referencia FROM telefonos
       WHERE UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?
       LIMIT 1`,
      [refParam, refNorm]
    ),
    db.execute(
      `SELECT referencia FROM apple_original
       WHERE UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?
       LIMIT 1`,
      [refParam, refNorm]
    ),
    db.execute(
      `SELECT referencia FROM oppo_original
       WHERE UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?
       LIMIT 1`,
      [refParam, refNorm]
    ),
    db.execute(
      `SELECT referencia FROM consolas
       WHERE UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?
       LIMIT 1`,
      [refParam, refNorm]
    ),
    db.execute(
      `SELECT id FROM solicitudes_pvp
       WHERE (UPPER(TRIM(referencia)) = ? OR ${normExpr} = ?)
         AND estado = 'pendiente'
       LIMIT 1`,
      [refParam, refNorm]
    ),
  ]);

  const [repRows] = checks[0];
  if (repRows.length) return { existe: true, origen: 'repuestos', tipo: 'catalogo' };
  const [telRows] = checks[1];
  if (telRows.length) return { existe: true, origen: 'telefonos', tipo: 'catalogo' };
  const [appleRows] = checks[2];
  if (appleRows.length) return { existe: true, origen: 'apple', tipo: 'catalogo' };
  const [oppoRows] = checks[3];
  if (oppoRows.length) return { existe: true, origen: 'oppo', tipo: 'catalogo' };
  const [conRows] = checks[4];
  if (conRows.length) return { existe: true, origen: 'consolas', tipo: 'catalogo' };
  const [pendRows] = checks[5];
  if (pendRows.length) return { existe: true, origen: 'solicitud_pendiente', tipo: 'solicitud' };

  return { existe: false };
}

/** GET /api/solicitudes/validar-referencia?referencia=... */
async function validarReferencia(req, res) {
  try {
    await ensureSolicitudesSchema();
    const referencia = String(req.query.referencia || '').trim();
    if (!referencia) return res.status(400).json({ error: 'referencia es obligatoria' });
    const result = await buscarReferenciaExistente(referencia);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error validando referencia' });
  }
}

/**
 * Tabla: `solicitudes_pvp` (creada con migrate.sql)
 * Usa `categoria` como texto libre (igual que en repuestos)
 * Roles: admin ve todas; carrefour/eci solo las suyas
 */

/** GET /api/solicitudes */
async function listar(req, res) {
  try {
    await ensureSolicitudesSchema();
    const { estado } = req.query;
    let where = [];
    const params = [];

    if (req.user.rol !== 'admin') {
      where.push('s.usuario_id = ?');
      params.push(req.user.id);
    }
    if (estado) {
      where.push('s.estado = ?');
      params.push(estado);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await db.execute(
      `SELECT s.id, s.referencia, s.descripcion, s.categoria, s.marca, s.modelo,
              s.coste, s.proveedor, s.observaciones,
              u.nombre AS solicitante, u.rol AS rol_solicitante_num,
              s.estado, s.pvp_asignado, s.pvp_club_asignado,
              s.motivo_rechazo, s.created_at, s.updated_at
       FROM solicitudes_pvp s
       LEFT JOIN usuarios u ON s.usuario_id = u.id_usuario
       ${whereSQL}
       ORDER BY s.created_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener solicitudes' });
  }
}

/** POST /api/solicitudes */
async function crear(req, res) {
  if (['franquicias', 'eciclinicas', 'ecclinicas'].includes(String(req.user?.rol || '').toLowerCase())) {
    return res.status(403).json({ error: 'Tu rol no tiene permiso para solicitar PVP' });
  }
  const { referencia, descripcion, categoria, marca, modelo, coste, proveedor, observaciones } = req.body;

  if (!referencia || !marca || !modelo || !coste) {
    return res.status(400).json({ error: 'Referencia, marca, modelo y coste son obligatorios' });
  }

  try {
    await ensureSolicitudesSchema();
    const existente = await buscarReferenciaExistente(referencia);
    if (existente.existe) {
      const msg = existente.tipo === 'solicitud'
        ? 'Ya existe una solicitud pendiente para esa referencia'
        : `La referencia ya existe en el catálogo ${existente.origen}`;
      return res.status(409).json({ error: msg, ...existente });
    }
    const [result] = await db.execute(
      `INSERT INTO solicitudes_pvp
         (referencia, descripcion, categoria, marca, modelo, coste, proveedor, observaciones, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [referencia, descripcion || null, categoria || null, marca || null, modelo || null,
       coste, proveedor || null, observaciones || null, req.user.id]
    );
    res.status(201).json({ id: result.insertId, message: 'Solicitud enviada correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear solicitud' });
  }
}

/** PUT /api/solicitudes/:id/aprobar  — solo admin */
async function aprobar(req, res) {
  const { referencia, descripcion, categoria, marca, modelo, coste, pvp_asignado, pvp_club_asignado, destino_catalogo } = req.body;

  const pvpAsignadoNum = Number(pvp_asignado);
  if (!Number.isFinite(pvpAsignadoNum) || pvpAsignadoNum <= 0) {
    return res.status(400).json({ error: 'El PVP a asignar es obligatorio' });
  }
  const pvpClubRaw = (pvp_club_asignado === '' || pvp_club_asignado === null || typeof pvp_club_asignado === 'undefined')
    ? null
    : Number(pvp_club_asignado);
  const pvpClubAsignadoNum = (Number.isFinite(pvpClubRaw) && pvpClubRaw >= 0)
    ? Number(pvpClubRaw.toFixed(2))
    : Number((pvpAsignadoNum * 0.85).toFixed(2));

  let conn;
  try {
    await ensureSolicitudesSchema();
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1. Actualizar la solicitud
    const [upd] = await conn.execute(
      `UPDATE solicitudes_pvp
       SET estado           = 'aprobado',
           referencia       = COALESCE(?, referencia),
           descripcion      = COALESCE(?, descripcion),
           categoria        = COALESCE(?, categoria),
           marca            = COALESCE(?, marca),
           modelo           = COALESCE(?, modelo),
           coste            = COALESCE(?, coste),
           pvp_asignado     = ?,
           pvp_club_asignado= ?,
           admin_id         = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [referencia || null, descripcion || null, categoria || null, marca || null, modelo || null, coste || null,
       pvpAsignadoNum, pvpClubAsignadoNum, req.user.id, req.params.id]
    );

    if (upd.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    // 2. Obtener los datos definitivos de la solicitud
    const [rows] = await conn.execute('SELECT * FROM solicitudes_pvp WHERE id = ?', [req.params.id]);
    const s = rows[0];

    // 3. Insertar o actualizar en el catálogo destino
    const destino = ['repuestos', 'telefonos', 'apple', 'oppo', 'consolas'].includes(destino_catalogo)
      ? destino_catalogo
      : 'repuestos';

    if (destino === 'repuestos') {
      await conn.execute(
        `INSERT INTO repuestos
           (referencia, marca, categoria, modelo, etiqueta, sage_new, pvp, pvp_clubsave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           marca        = VALUES(marca),
           categoria    = VALUES(categoria),
           modelo       = VALUES(modelo),
           etiqueta     = VALUES(etiqueta),
           sage_new     = VALUES(sage_new),
           pvp          = VALUES(pvp),
           pvp_clubsave = VALUES(pvp_clubsave)`,
        [s.referencia, s.marca || '', s.categoria || '', s.modelo || '', s.descripcion || s.referencia,
         s.coste, pvpAsignadoNum, pvpClubAsignadoNum]
      );
    } else if (destino === 'telefonos') {
      await conn.execute(
        `INSERT INTO telefonos
           (referencia, marca, modelo, etiqueta, pvp)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           marca    = VALUES(marca),
           modelo   = VALUES(modelo),
           etiqueta = VALUES(etiqueta),
           pvp      = VALUES(pvp)`,
        [s.referencia, s.marca || '', s.modelo || '', s.descripcion || s.referencia, pvpAsignadoNum]
      );
    } else if (destino === 'apple') {
      await conn.execute(
        `INSERT INTO apple_original
           (referencia, marca, categoria, modelo, etiqueta, pvp)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           marca    = VALUES(marca),
           categoria = VALUES(categoria),
           modelo   = VALUES(modelo),
           etiqueta  = VALUES(etiqueta),
           pvp       = VALUES(pvp)`,
        [s.referencia, s.marca || '', s.categoria || '', s.modelo || '', s.descripcion || s.referencia, pvpAsignadoNum]
      );
    } else if (destino === 'oppo') {
      await conn.execute(
        `INSERT INTO oppo_original
           (referencia, marca, categoria, modelo, etiqueta, pvp)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           marca    = VALUES(marca),
           categoria = VALUES(categoria),
           modelo   = VALUES(modelo),
           etiqueta  = VALUES(etiqueta),
           pvp       = VALUES(pvp)`,
        [s.referencia, s.marca || '', s.categoria || '', s.modelo || '', s.descripcion || s.referencia, pvpAsignadoNum]
      );
    } else if (destino === 'consolas') {
      await conn.execute(
        `INSERT INTO consolas
           (referencia, marca, categoria, modelo, etiqueta, pvp, pvp_clubsave)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           marca     = VALUES(marca),
           categoria = VALUES(categoria),
           modelo    = VALUES(modelo),
           etiqueta  = VALUES(etiqueta),
           pvp       = VALUES(pvp),
           pvp_clubsave = VALUES(pvp_clubsave)`,
        [s.referencia, s.marca || '', s.categoria || '', s.modelo || '', s.descripcion || s.referencia, pvpAsignadoNum, pvpClubAsignadoNum]
      );
    }

    await conn.commit();
    res.json({ message: `Solicitud aprobada y referencia añadida en ${destino}` });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Error al aprobar solicitud' });
  } finally {
    if (conn) conn.release();
  }
}

/** PUT /api/solicitudes/:id/rechazar  — solo admin */
async function rechazar(req, res) {
  const { motivo_rechazo } = req.body;

  if (!motivo_rechazo || !motivo_rechazo.trim()) {
    return res.status(400).json({ error: 'El motivo del rechazo es obligatorio' });
  }

  try {
    const [result] = await db.execute(
      `UPDATE solicitudes_pvp
       SET estado = 'rechazado', motivo_rechazo = ?, admin_id = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [motivo_rechazo.trim(), req.user.id, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    res.json({ message: 'Solicitud rechazada correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al rechazar solicitud' });
  }
}

module.exports = { listar, crear, aprobar, rechazar, validarReferencia };
