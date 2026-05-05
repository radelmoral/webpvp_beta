const db = require('../config/db');
const _tableColsCache = new Map();
let _catalogAuditReady = false;

function addTokenizedSearch(where, params, q, columns) {
  const raw = String(q || '').trim();
  const baseTokens = raw.split(/\s+/).filter(Boolean);
  if (!baseTokens.length) return;
  const normalizedExpr = (c) => `REPLACE(REPLACE(LOWER(${c}), ' ', ''), '-', '')`;
  const hasDigit = (s) => /\d/.test(s);

  // Fusiona patrones tipo "iphone 7" => "iphone7"
  // para evitar falsos positivos por el término numérico suelto.
  const tokens = [];
  baseTokens.forEach((tkRaw) => {
    const tk = tkRaw.toLowerCase();
    if (!tokens.length) {
      tokens.push(tk);
      return;
    }
    const prev = tokens[tokens.length - 1];
    if (/^\d+[a-z]*$/i.test(tk) && !hasDigit(prev)) {
      tokens[tokens.length - 1] = `${prev}${tk}`;
      return;
    }
    tokens.push(tk);
  });

  // Requiere que TODOS los términos estén presentes (AND),
  // pero cada término puede estar en cualquier columna (OR).
  tokens.forEach((tk) => {
    const tkNorm = tk.replace(/[\s-]+/g, '');
    const perToken = columns
      .map((c) => `(${c} LIKE ? OR ${normalizedExpr(c)} LIKE ?)`)
      .join(' OR ');
    where.push(`(${perToken})`);
    columns.forEach(() => {
      params.push(`%${tk}%`);
      params.push(`%${tkNorm}%`);
    });
  });
}

async function getTableColumns(tableName) {
  if (_tableColsCache.has(tableName)) return _tableColsCache.get(tableName);
  const [rows] = await db.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  const cols = new Set(rows.map(r => r.COLUMN_NAME));
  _tableColsCache.set(tableName, cols);
  return cols;
}

async function ensureConsolasTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS consolas (
      referencia VARCHAR(120) NOT NULL PRIMARY KEY,
      marca VARCHAR(120) NULL,
      categoria VARCHAR(120) NULL,
      modelo VARCHAR(160) NULL,
      etiqueta VARCHAR(255) NULL,
      pvp DECIMAL(10,2) NULL,
      pvp_clubsave DECIMAL(10,2) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      pvp_updated_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  _tableColsCache.delete('consolas');
}

async function ensureCatalogAuditColumns() {
  if (_catalogAuditReady) return;
  await ensureConsolasTable();
  const tables = ['repuestos', 'telefonos', 'apple_original', 'oppo_original', 'consolas'];
  for (const table of tables) {
    const cols = await getTableColumns(table);
    if (table === 'consolas' && !cols.has('pvp_clubsave')) {
      await db.execute(
        `ALTER TABLE ${table}
         ADD COLUMN pvp_clubsave DECIMAL(10,2) NULL`
      );
      _tableColsCache.delete(table);
    }
    if (!cols.has('created_at')) {
      await db.execute(
        `ALTER TABLE ${table}
         ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
      );
      _tableColsCache.delete(table);
    }
    const colsAfterCreated = await getTableColumns(table);
    if (!colsAfterCreated.has('updated_at')) {
      await db.execute(
        `ALTER TABLE ${table}
         ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
      );
      _tableColsCache.delete(table);
    }
    const colsAfterUpdated = await getTableColumns(table);
    if (!colsAfterUpdated.has('pvp_updated_at')) {
      await db.execute(
        `ALTER TABLE ${table}
         ADD COLUMN pvp_updated_at TIMESTAMP NULL DEFAULT NULL`
      );
      _tableColsCache.delete(table);
    }
  }
  _catalogAuditReady = true;
}

/** GET /api/dashboard/resumen */
async function dashboardResumen(req, res) {
  try {
    await ensureCatalogAuditColumns();
    const catalogos = [
      { table: 'repuestos', label: 'Repuestos' },
      { table: 'telefonos', label: 'Teléfonos' },
      { table: 'apple_original', label: 'Apple Original' },
      { table: 'oppo_original', label: 'Oppo Original' },
      { table: 'consolas', label: 'Consolas' },
    ];
    const colsByTable = {};
    for (const c of catalogos) {
      colsByTable[c.table] = await getTableColumns(c.table);
    }

    const getOrderAdded = (cols) => {
      if (cols.has('created_at')) return 'created_at DESC, referencia DESC';
      if (cols.has('id')) return 'id DESC';
      if (cols.has('updated_at')) return 'updated_at DESC, referencia DESC';
      return 'referencia DESC';
    };
    const getOrderPvp = (cols) => {
      if (cols.has('pvp_updated_at')) return 'pvp_updated_at DESC, referencia DESC';
      if (cols.has('updated_at')) return 'updated_at DESC, referencia DESC';
      if (cols.has('created_at')) return 'created_at DESC, referencia DESC';
      if (cols.has('id')) return 'id DESC';
      return 'referencia DESC';
    };
    const sortExpr = (cols) => {
      if (cols.has('updated_at')) return 'UNIX_TIMESTAMP(updated_at)';
      if (cols.has('created_at')) return 'UNIX_TIMESTAMP(created_at)';
      if (cols.has('id')) return 'CAST(id AS SIGNED)';
      return '0';
    };
    const wherePvp = (cols) => (
      cols.has('pvp_updated_at')
        ? 'pvp IS NOT NULL AND pvp_updated_at IS NOT NULL'
        : cols.has('updated_at') && cols.has('created_at')
        ? 'pvp IS NOT NULL AND updated_at > created_at'
        : 'pvp IS NOT NULL'
    );

    const [
      [[repCount]],
      [[telCount]],
      [[conCount]],
      [catRows],
      [marcaRows],
    ] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS total FROM repuestos`),
      db.execute(`SELECT COUNT(*) AS total FROM telefonos`),
      db.execute(`SELECT COUNT(*) AS total FROM consolas`),
      db.execute(
        `SELECT COALESCE(NULLIF(TRIM(categoria), ''), 'Sin categoría') AS nombre, COUNT(*) AS total
           FROM repuestos
          GROUP BY COALESCE(NULLIF(TRIM(categoria), ''), 'Sin categoría')
          ORDER BY total DESC
          LIMIT 6`
      ),
      db.execute(
        `SELECT COALESCE(NULLIF(TRIM(marca), ''), 'Sin marca') AS nombre, COUNT(*) AS total
           FROM repuestos
          GROUP BY COALESCE(NULLIF(TRIM(marca), ''), 'Sin marca')
          ORDER BY total DESC
          LIMIT 6`
      ),
    ]);

    const latestByCatalogPromises = catalogos.map(({ table, label }) => {
      const cols = colsByTable[table];
      const order = getOrderAdded(cols);
      const sort = sortExpr(cols);
      const categoriaSel = cols.has('categoria') ? 'categoria' : "'' AS categoria";
      const pvpClubSel = cols.has('pvp_clubsave') ? 'pvp_clubsave' : 'NULL AS pvp_clubsave';
      return db.execute(
        `SELECT referencia, marca, ${categoriaSel}, modelo, etiqueta, pvp, ${pvpClubSel},
                '${label}' AS catalogo,
                ${sort} AS __sort
           FROM ${table}
          ORDER BY ${order}
          LIMIT 20`
      );
    });
    const latestPvpByCatalogPromises = catalogos.map(({ table, label }) => {
      const cols = colsByTable[table];
      const order = getOrderPvp(cols);
      const sort = cols.has('pvp_updated_at') ? 'UNIX_TIMESTAMP(pvp_updated_at)' : sortExpr(cols);
      const categoriaSel = cols.has('categoria') ? 'categoria' : "'' AS categoria";
      const pvpClubSel = cols.has('pvp_clubsave') ? 'pvp_clubsave' : 'NULL AS pvp_clubsave';
      return db.execute(
        `SELECT referencia, marca, ${categoriaSel}, modelo, etiqueta, pvp, ${pvpClubSel},
                '${label}' AS catalogo,
                ${sort} AS __sort
           FROM ${table}
          WHERE ${wherePvp(cols)}
          ORDER BY ${order}
          LIMIT 20`
      );
    });

    const latestRowsAll = (await Promise.all(latestByCatalogPromises))
      .flatMap(([rows]) => rows)
      .sort((a, b) => (Number(b.__sort || 0) - Number(a.__sort || 0)) || String(b.referencia || '').localeCompare(String(a.referencia || '')))
      .slice(0, 5)
      .map(({ __sort, ...r }) => r);

    const latestPvpRowsAll = (await Promise.all(latestPvpByCatalogPromises))
      .flatMap(([rows]) => rows)
      .sort((a, b) => (Number(b.__sort || 0) - Number(a.__sort || 0)) || String(b.referencia || '').localeCompare(String(a.referencia || '')))
      .slice(0, 5)
      .map(({ __sort, ...r }) => r);

    res.json({
      totalRepuestos: Number(repCount.total || 0),
      totalTelefonos: Number(telCount.total || 0),
      totalConsolas: Number(conCount.total || 0),
      topCategorias: catRows,
      topMarcas: marcaRows,
      ultimasReferencias: latestRowsAll,
      ultimosPvpModificados: latestPvpRowsAll,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cargar resumen de dashboard' });
  }
}

/**
 * Tablas reales en la BBDD `Repuestos`:
 *   repuestos       — referencia, marca, categoria, modelo, etiqueta,
 *                     sage_act, sage_new, pvp, pvp_clubsave, stock, vendidos, diferencia
 *   apple_original  — misma estructura
 *   oppo_original   — misma estructura
 *   telefonos       — referencia, marca, modelo, etiqueta, pvp
 */

/** GET /api/repuestos  — listado con filtros */
async function listar(req, res) {
  try {
    const { ref, categoria, marca, modelo, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    const params = [];

    if (ref)       { where.push('referencia LIKE ?');  params.push(`%${ref}%`); }
    if (categoria) { where.push('categoria = ?');      params.push(categoria);  }
    if (marca)     { where.push('marca = ?');          params.push(marca);      }
    if (modelo)    { where.push('modelo LIKE ?');      params.push(`%${modelo}%`); }
    addTokenizedSearch(where, params, q, ['referencia', 'etiqueta', 'marca', 'modelo', 'categoria']);

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM repuestos ${whereSQL}`, params
    );

    const [rows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta,
              sage_act, sage_new, pvp, pvp_clubsave, stock
       FROM repuestos ${whereSQL}
       ORDER BY referencia
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener repuestos' });
  }
}

/** GET /api/repuestos/:ref  — busca por referencia */
async function obtener(req, res) {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM repuestos WHERE referencia = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Repuesto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
}

/** POST /api/repuestos  — solo admin */
async function crear(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, sage_act, sage_new, pvp, pvp_clubsave } = req.body;
  if (!referencia || !etiqueta) {
    return res.status(400).json({ error: 'Referencia y etiqueta son obligatorias' });
  }
  try {
    await db.execute(
      `INSERT INTO repuestos (referencia, marca, categoria, modelo, etiqueta, sage_act, sage_new, pvp, pvp_clubsave)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [referencia, marca || '', categoria || '', modelo || '', etiqueta,
       sage_act || null, sage_new || null, pvp || null, pvp_clubsave || null]
    );
    res.status(201).json({ referencia, message: 'Repuesto creado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa referencia ya existe' });
    res.status(500).json({ error: 'Error al crear repuesto' });
  }
}

/** POST /api/apple — solo admin */
async function crearApple(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp } = req.body;
  if (!referencia) return res.status(400).json({ error: 'Referencia obligatoria' });
  try {
    await db.execute(
      `INSERT INTO apple_original (referencia, marca, categoria, modelo, etiqueta, pvp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [referencia, marca || '', categoria || '', modelo || '', etiqueta || referencia, pvp || null]
    );
    res.status(201).json({ referencia, message: 'Referencia Apple creada' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa referencia ya existe' });
    res.status(500).json({ error: 'Error al crear Apple Original' });
  }
}

/** PUT /api/repuestos/:ref  — solo admin */
async function actualizar(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, sage_act, sage_new, pvp, pvp_clubsave } = req.body;
  const pvpVal = (pvp === '' || pvp === null || typeof pvp === 'undefined' || Number.isNaN(Number(pvp))) ? null : Number(pvp);
  const pvpClubVal = (pvp_clubsave === '' || pvp_clubsave === null || typeof pvp_clubsave === 'undefined' || Number.isNaN(Number(pvp_clubsave))) ? null : Number(pvp_clubsave);
  try {
    const [result] = await db.execute(
      `UPDATE repuestos
       SET referencia=COALESCE(NULLIF(?, ''), referencia),
           marca=?, categoria=?, modelo=?, etiqueta=?,
           sage_act=?, sage_new=?, pvp=?, pvp_clubsave=?,
           pvp_updated_at = IF(? IS NOT NULL, CURRENT_TIMESTAMP, pvp_updated_at)
       WHERE referencia=?`,
      [referencia || null, marca, categoria, modelo, etiqueta,
       sage_act || null, sage_new || null, pvpVal, pvpClubVal, pvpVal,
       req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Repuesto no encontrado' });
    res.json({ message: 'Repuesto actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La referencia nueva ya existe' });
    res.status(500).json({ error: 'Error al actualizar repuesto' });
  }
}

/** DELETE /api/repuestos/:ref  — solo admin */
async function eliminar(req, res) {
  try {
    const [result] = await db.execute('DELETE FROM repuestos WHERE referencia = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Repuesto no encontrado' });
    res.json({ message: 'Repuesto eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar repuesto' });
  }
}

// ── Apple Original ──────────────────────────────────────────

/** GET /api/apple */
async function listarApple(req, res) {
  try {
    const { ref, categoria, marca, modelo, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = []; const params = [];
    if (ref)      { where.push('referencia LIKE ?'); params.push(`%${ref}%`); }
    if (categoria){ where.push('categoria = ?');     params.push(categoria);  }
    if (marca)    { where.push('marca = ?');         params.push(marca);      }
    if (modelo)   { where.push('modelo LIKE ?');     params.push(`%${modelo}%`); }
    addTokenizedSearch(where, params, q, ['referencia', 'etiqueta', 'modelo', 'categoria', 'marca']);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM apple_original ${w}`, params);
    const [rows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta, sage_act, sage_new, pvp, stock
       FROM apple_original ${w} ORDER BY referencia LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) { res.status(500).json({ error: 'Error al obtener Apple Original' }); }
}

/** PUT /api/apple/:ref  — solo admin */
async function actualizarApple(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp } = req.body;
  const pvpVal = (pvp === '' || pvp === null || typeof pvp === 'undefined' || Number.isNaN(Number(pvp))) ? null : Number(pvp);
  try {
    const [result] = await db.execute(
      `UPDATE apple_original
       SET referencia=COALESCE(NULLIF(?, ''), referencia),
           marca=?, categoria=?, modelo=?, etiqueta=?, pvp=?,
           pvp_updated_at = IF(? IS NOT NULL, CURRENT_TIMESTAMP, pvp_updated_at)
       WHERE referencia=?`,
      [referencia || null, marca || '', categoria || '', modelo || '', etiqueta || '', pvpVal, pvpVal, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Apple Original actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La referencia nueva ya existe' });
    res.status(500).json({ error: 'Error al actualizar Apple Original' });
  }
}

/** DELETE /api/apple/:ref  — solo admin */
async function eliminarApple(req, res) {
  try {
    const [result] = await db.execute('DELETE FROM apple_original WHERE referencia = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Referencia Apple eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar Apple Original' });
  }
}

// ── Oppo Original ───────────────────────────────────────────

/** GET /api/oppo */
async function listarOppo(req, res) {
  try {
    const { ref, categoria, marca, modelo, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = []; const params = [];
    if (ref)   { where.push('referencia LIKE ?'); params.push(`%${ref}%`); }
    if (categoria){ where.push('categoria = ?');  params.push(categoria);  }
    if (marca) { where.push('marca = ?');         params.push(marca);      }
    if (modelo){ where.push('modelo LIKE ?');     params.push(`%${modelo}%`); }
    addTokenizedSearch(where, params, q, ['referencia', 'etiqueta', 'modelo', 'categoria', 'marca']);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM oppo_original ${w}`, params);
    const [rows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta, sage_act, sage_new, pvp, stock
       FROM oppo_original ${w} ORDER BY referencia LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) { res.status(500).json({ error: 'Error al obtener Oppo Original' }); }
}

/** PUT /api/oppo/:ref  — solo admin */
async function actualizarOppo(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp } = req.body;
  const pvpVal = (pvp === '' || pvp === null || typeof pvp === 'undefined' || Number.isNaN(Number(pvp))) ? null : Number(pvp);
  try {
    const [result] = await db.execute(
      `UPDATE oppo_original
       SET referencia=COALESCE(NULLIF(?, ''), referencia),
           marca=?, categoria=?, modelo=?, etiqueta=?, pvp=?,
           pvp_updated_at = IF(? IS NOT NULL, CURRENT_TIMESTAMP, pvp_updated_at)
       WHERE referencia=?`,
      [referencia || null, marca || '', categoria || '', modelo || '', etiqueta || '', pvpVal, pvpVal, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Oppo Original actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La referencia nueva ya existe' });
    res.status(500).json({ error: 'Error al actualizar Oppo Original' });
  }
}

/** POST /api/oppo — solo admin */
async function crearOppo(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp } = req.body;
  if (!referencia) return res.status(400).json({ error: 'Referencia obligatoria' });
  try {
    await db.execute(
      `INSERT INTO oppo_original (referencia, marca, categoria, modelo, etiqueta, pvp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [referencia, marca || '', categoria || '', modelo || '', etiqueta || referencia, pvp || null]
    );
    res.status(201).json({ referencia, message: 'Referencia Oppo creada' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa referencia ya existe' });
    res.status(500).json({ error: 'Error al crear Oppo Original' });
  }
}

/** DELETE /api/oppo/:ref  — solo admin */
async function eliminarOppo(req, res) {
  try {
    const [result] = await db.execute('DELETE FROM oppo_original WHERE referencia = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Referencia Oppo eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar Oppo Original' });
  }
}

// ── Teléfonos ───────────────────────────────────────────────

/** GET /api/telefonos */
async function listarTelefonos(req, res) {
  try {
    const { ref, marca, modelo, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = []; const params = [];
    if (ref)   { where.push('referencia LIKE ?'); params.push(`%${ref}%`); }
    if (marca) { where.push('marca = ?');         params.push(marca); }
    if (modelo){ where.push('modelo LIKE ?');     params.push(`%${modelo}%`); }
    addTokenizedSearch(where, params, q, ['referencia', 'etiqueta', 'marca', 'modelo']);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM telefonos ${w}`, params);
    const [rows] = await db.execute(
      `SELECT referencia, marca, modelo, etiqueta, pvp
       FROM telefonos ${w} ORDER BY marca, modelo LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) { res.status(500).json({ error: 'Error al obtener teléfonos' }); }
}

/** PUT /api/telefonos/:ref  — solo admin */
async function actualizarTelefono(req, res) {
  const { referencia, marca, modelo, etiqueta, pvp } = req.body;
  const pvpVal = (pvp === '' || pvp === null || typeof pvp === 'undefined' || Number.isNaN(Number(pvp))) ? null : Number(pvp);
  try {
    const [result] = await db.execute(
      `UPDATE telefonos
       SET referencia=COALESCE(NULLIF(?, ''), referencia),
           marca=?, modelo=?, etiqueta=?, pvp=?,
           pvp_updated_at = IF(? IS NOT NULL, CURRENT_TIMESTAMP, pvp_updated_at)
       WHERE referencia=?`,
      [referencia || null, marca || '', modelo || '', etiqueta || '', pvpVal, pvpVal, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Teléfono actualizado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La referencia nueva ya existe' });
    res.status(500).json({ error: 'Error al actualizar teléfono' });
  }
}

/** POST /api/telefonos — solo admin */
async function crearTelefono(req, res) {
  const { referencia, marca, modelo, etiqueta, pvp } = req.body;
  if (!referencia) return res.status(400).json({ error: 'Referencia obligatoria' });
  try {
    await db.execute(
      `INSERT INTO telefonos (referencia, marca, modelo, etiqueta, pvp)
       VALUES (?, ?, ?, ?, ?)`,
      [referencia, marca || '', modelo || '', etiqueta || referencia, pvp || null]
    );
    res.status(201).json({ referencia, message: 'Teléfono creado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa referencia ya existe' });
    res.status(500).json({ error: 'Error al crear teléfono' });
  }
}

/** DELETE /api/telefonos/:ref  — solo admin */
async function eliminarTelefono(req, res) {
  try {
    const [result] = await db.execute('DELETE FROM telefonos WHERE referencia = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Teléfono eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar teléfono' });
  }
}

// ── Consolas ────────────────────────────────────────────────

/** GET /api/consolas */
async function listarConsolas(req, res) {
  try {
    await ensureConsolasTable();
    const { ref, categoria, marca, modelo, q, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = []; const params = [];
    if (ref)      { where.push('referencia LIKE ?'); params.push(`%${ref}%`); }
    if (categoria){ where.push('categoria = ?');     params.push(categoria);  }
    if (marca)    { where.push('marca = ?');         params.push(marca);      }
    if (modelo)   { where.push('modelo LIKE ?');     params.push(`%${modelo}%`); }
    addTokenizedSearch(where, params, q, ['referencia', 'etiqueta', 'modelo', 'categoria', 'marca']);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM consolas ${w}`, params);
    const [rows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta, pvp, pvp_clubsave
       FROM consolas ${w} ORDER BY referencia LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) { res.status(500).json({ error: 'Error al obtener consolas' }); }
}

/** POST /api/consolas — solo admin */
async function crearConsola(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp, pvp_clubsave } = req.body;
  if (!referencia) return res.status(400).json({ error: 'Referencia obligatoria' });
  try {
    await ensureConsolasTable();
    await db.execute(
      `INSERT INTO consolas (referencia, marca, categoria, modelo, etiqueta, pvp, pvp_clubsave)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [referencia, marca || '', categoria || '', modelo || '', etiqueta || referencia, pvp || null, pvp_clubsave || null]
    );
    res.status(201).json({ referencia, message: 'Consola creada' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa referencia ya existe' });
    res.status(500).json({ error: 'Error al crear consola' });
  }
}

/** PUT /api/consolas/:ref — solo admin */
async function actualizarConsola(req, res) {
  const { referencia, marca, categoria, modelo, etiqueta, pvp, pvp_clubsave } = req.body;
  const pvpVal = (pvp === '' || pvp === null || typeof pvp === 'undefined' || Number.isNaN(Number(pvp))) ? null : Number(pvp);
  const pvpClubVal = (pvp_clubsave === '' || pvp_clubsave === null || typeof pvp_clubsave === 'undefined' || Number.isNaN(Number(pvp_clubsave))) ? null : Number(pvp_clubsave);
  try {
    await ensureConsolasTable();
    const [result] = await db.execute(
      `UPDATE consolas
       SET referencia=COALESCE(NULLIF(?, ''), referencia),
           marca=?, categoria=?, modelo=?, etiqueta=?, pvp=?, pvp_clubsave=?,
           pvp_updated_at = IF(? IS NOT NULL, CURRENT_TIMESTAMP, pvp_updated_at)
       WHERE referencia=?`,
      [referencia || null, marca || '', categoria || '', modelo || '', etiqueta || '', pvpVal, pvpClubVal, pvpVal, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Consola actualizada' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La referencia nueva ya existe' });
    res.status(500).json({ error: 'Error al actualizar consola' });
  }
}

/** DELETE /api/consolas/:ref — solo admin */
async function eliminarConsola(req, res) {
  try {
    await ensureConsolasTable();
    const [result] = await db.execute('DELETE FROM consolas WHERE referencia = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Referencia no encontrada' });
    res.json({ message: 'Consola eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar consola' });
  }
}

/** GET /api/busqueda-global?q=... */
async function busquedaGlobal(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q es obligatorio' });

    const repWhere = []; const repParams = [];
    addTokenizedSearch(repWhere, repParams, q, ['referencia', 'etiqueta', 'marca', 'modelo', 'categoria']);
    const [repRows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta, pvp
       FROM repuestos
       WHERE ${repWhere.join(' AND ')}
       ORDER BY referencia LIMIT 50`,
      repParams
    );

    const appleWhere = []; const appleParams = [];
    addTokenizedSearch(appleWhere, appleParams, q, ['referencia', 'etiqueta', 'marca', 'modelo', 'categoria']);
    const [appleRows] = await db.execute(
      `SELECT referencia, categoria, modelo, etiqueta, pvp
       FROM apple_original
       WHERE ${appleWhere.join(' AND ')}
       ORDER BY referencia LIMIT 50`,
      appleParams
    );

    const oppoWhere = []; const oppoParams = [];
    addTokenizedSearch(oppoWhere, oppoParams, q, ['referencia', 'etiqueta', 'marca', 'modelo', 'categoria']);
    const [oppoRows] = await db.execute(
      `SELECT referencia, categoria, modelo, etiqueta, pvp
       FROM oppo_original
       WHERE ${oppoWhere.join(' AND ')}
       ORDER BY referencia LIMIT 50`,
      oppoParams
    );

    const telWhere = []; const telParams = [];
    addTokenizedSearch(telWhere, telParams, q, ['referencia', 'etiqueta', 'marca', 'modelo']);
    const [telRows] = await db.execute(
      `SELECT referencia, marca, modelo, etiqueta, pvp
       FROM telefonos
       WHERE ${telWhere.join(' AND ')}
       ORDER BY referencia LIMIT 50`,
      telParams
    );

    const conWhere = []; const conParams = [];
    addTokenizedSearch(conWhere, conParams, q, ['referencia', 'etiqueta', 'marca', 'modelo', 'categoria']);
    const [conRows] = await db.execute(
      `SELECT referencia, marca, categoria, modelo, etiqueta, pvp
       FROM consolas
       WHERE ${conWhere.join(' AND ')}
       ORDER BY referencia LIMIT 50`,
      conParams
    );

    res.json({
      q,
      repuestos: repRows,
      apple: appleRows,
      oppo: oppoRows,
      telefonos: telRows,
      consolas: conRows,
      total: repRows.length + appleRows.length + oppoRows.length + telRows.length + conRows.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error en búsqueda global' });
  }
}

// ── Categorías únicas de la tabla repuestos ─────────────────

/** GET /api/categorias  — extrae las categorías reales de la BBDD */
async function listarCategorias(req, res) {
  try {
    await ensureConsolasTable();
    const [rows] = await db.execute(
      `SELECT nombre
       FROM (
         SELECT DISTINCT categoria AS nombre
         FROM repuestos
         WHERE categoria IS NOT NULL AND categoria != ''
         UNION
         SELECT DISTINCT categoria AS nombre
         FROM apple_original
         WHERE categoria IS NOT NULL AND categoria != ''
         UNION
         SELECT DISTINCT categoria AS nombre
         FROM oppo_original
         WHERE categoria IS NOT NULL AND categoria != ''
         UNION
         SELECT DISTINCT categoria AS nombre
         FROM consolas
         WHERE categoria IS NOT NULL AND categoria != ''
       ) c
       WHERE nombre IS NOT NULL AND nombre != ''
       ORDER BY nombre`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
}

module.exports = {
  listar, obtener, crear, actualizar, eliminar,
  listarApple, crearApple, actualizarApple, eliminarApple,
  listarOppo, crearOppo, actualizarOppo, eliminarOppo,
  listarTelefonos, crearTelefono, actualizarTelefono, eliminarTelefono,
  listarConsolas, crearConsola, actualizarConsola, eliminarConsola,
  dashboardResumen,
  busquedaGlobal,
  listarCategorias,
};
