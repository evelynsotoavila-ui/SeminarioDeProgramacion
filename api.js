const { query, withTransaction, conexionError } = require('./db');

const BD_SORT = {
  no: '`no`', folio: 'folio', alumno: 'alumno', grado: 'grado',
  titulo_tesis: 'titulo_tesis', fecha_elaboracion: 'fecha_elaboracion',
  docente: 'docente', fungio: 'fungio', punto: 'punto', ciudad: 'ciudad',
  no_tesis: 'no_tesis', no_caja: 'no_caja', capturo: 'capturo',
  fecha_captura: 'fecha_captura', archivo: 'archivo', digital: 'digital',
  programa: 'programa', no_empleado: 'no_empleado', observaciones: 'observaciones',
  pdf: 'pdf', cd: 'cd', anio: 'anio', id: 'id'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function like(q) {
  return '%' + String(q).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
}

function pageLimit(url, def = 50) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const raw = parseInt(url.searchParams.get('limit') || String(def), 10);
  const limit = Math.min(500, Math.max(1, raw || def));
  return { page, limit, offset: (page - 1) * limit };
}

function isAdmin(req) {
  return String(req.headers['x-rol'] || '') === 'admin';
}

function usuarioDe(req, body) {
  return String((body && body.usuario) || req.headers['x-usuario'] || 'Administrador').slice(0, 120);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) reject(new Error('Cuerpo demasiado grande')); });
    req.on('end', () => {
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function distinctList(col) {
  return query(
    `SELECT DISTINCT ${col} AS v FROM bd WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`
  );
}

function sameTesis(a, b) {
  return Number(a.anio) === Number(b.anio)
    && String(a.alumno || '') === String(b.alumno || '')
    && String(a.titulo_tesis || '') === String(b.titulo_tesis || '');
}

async function ensureAppTables() {
  await query(
    `CREATE TABLE IF NOT EXISTS app_historial (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tipo VARCHAR(60) NOT NULL,
      valor_anterior TEXT NULL,
      valor_nuevo TEXT NULL,
      usuario VARCHAR(120) NULL,
      detalle TEXT NULL,
      creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_app_hist_fecha (creado_en)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

async function historialInsert(q, row) {
  await q(
    `INSERT INTO app_historial (tipo, valor_anterior, valor_nuevo, usuario, detalle)
     VALUES (?, ?, ?, ?, ?)`,
    [row.tipo, row.valor_anterior ?? null, row.valor_nuevo ?? null, row.usuario ?? null, row.detalle ?? null]
  );
}

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function resolverDocente(q, nombre, idHint) {
  const nom = String(nombre || '').trim();
  let id = idHint ? Number(idHint) : null;
  let noEmp = null;
  if (id) {
    const d = await q('SELECT id, num_empleado, nombre FROM docentes WHERE id = ?', [id]);
    if (d[0]) return { id: d[0].id, noEmp: d[0].num_empleado, nombre: nom || d[0].nombre };
    id = null;
  }
  if (nom) {
    const d = await q('SELECT id, num_empleado, nombre FROM docentes WHERE nombre = ? LIMIT 1', [nom]);
    if (d[0]) return { id: d[0].id, noEmp: d[0].num_empleado, nombre: d[0].nombre };
    const ins = await q('INSERT INTO docentes (nombre) VALUES (?)', [nom]);
    return { id: ins.insertId, noEmp: null, nombre: nom };
  }
  return { id: null, noEmp: null, nombre: nom || null };
}

async function renumerarNoTesis(q, docenteId) {
  if (!docenteId) return;
  const rows = await q(
    'SELECT id FROM bd WHERE docente_id = ? ORDER BY fecha_elaboracion IS NULL, fecha_elaboracion, id',
    [docenteId]
  );
  let n = 1;
  for (const r of rows) {
    await q('UPDATE bd SET no_tesis = ? WHERE id = ?', [n++, r.id]);
  }
}

function mapAlumnoVista(r) {
  return {
    id: r.id,
    nombre: r.nombre,
    matricula: r.matricula,
    sexo: r.sexo,
    programa_habitual: r.programa_habitual,
    fecha_registro: r.fecha_registro,
    tesis: Number(r.tesis) || 0
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  try {
    if (p === '/api/salud' && m === 'GET') {
      await query('SELECT 1 AS ok');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/conteos' && m === 'GET') {
      const rows = await query(
        `SELECT 'bd' AS t, COUNT(*) AS n FROM bd
         UNION ALL SELECT 'docentes', COUNT(*) FROM docentes
         UNION ALL SELECT 'alumnos', COUNT(*) FROM alumnos
         UNION ALL SELECT 'bd_alumnos', COUNT(*) FROM bd_alumnos
         UNION ALL SELECT 'bd_asignacion', COUNT(*) FROM bd_asignacion
         UNION ALL SELECT 'v_docentes', COUNT(*) FROM v_docentes
         UNION ALL SELECT 'v_alumnos', COUNT(*) FROM v_alumnos
         UNION ALL SELECT 'v_actividad_docente', COUNT(*) FROM v_actividad_docente`
      );
      const map = {};
      rows.forEach(r => { map[r.t] = Number(r.n); });
      return send(res, 200, map);
    }

    if (p === '/api/filtros' && m === 'GET') {
      const [anios, grados, ciudades, programas, puntos] = await Promise.all([
        query('SELECT DISTINCT anio AS v FROM bd WHERE anio IS NOT NULL ORDER BY anio DESC'),
        distinctList('grado'),
        distinctList('ciudad'),
        distinctList('programa'),
        distinctList('punto')
      ]);
      return send(res, 200, {
        anios: anios.map(r => r.v),
        grados: grados.map(r => r.v),
        ciudades: ciudades.map(r => r.v),
        programas: programas.map(r => r.v),
        puntos: puntos.map(r => r.v)
      });
    }

    if (p === '/api/alumnos' && m === 'GET') {
      const { page, limit, offset } = pageLimit(url);
      const qtxt = (url.searchParams.get('q') || '').trim();
      let where = ' WHERE 1=1';
      const params = [];
      if (qtxt) {
        const lk = like(qtxt);
        where += ' AND (v.Alumno LIKE ? OR v.`Matrícula` LIKE ?)';
        params.push(lk, lk);
      }
      const totalRows = await query('SELECT COUNT(*) AS n FROM v_alumnos v' + where, params);
      const rows = await query(
        `SELECT v.id, v.Alumno AS nombre, v.\`Matrícula\` AS matricula, v.Sexo AS sexo,
                v.\`Programa habitual\` AS programa_habitual, v.\`Fecha de registro\` AS fecha_registro,
                v.\`Tesis registradas\` AS tesis
         FROM v_alumnos v${where}
         ORDER BY v.Alumno
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      return send(res, 200, { page, limit, total: Number(totalRows[0].n), rows: rows.map(mapAlumnoVista) });
    }

    if (p === '/api/alumnos/buscar' && m === 'GET') {
      const qtxt = (url.searchParams.get('q') || '').trim();
      if (!qtxt) return send(res, 200, { rows: [] });
      const lk = like(qtxt);
      const rows = await query(
        `SELECT id, nombre, matricula, sexo, programa_habitual
         FROM alumnos
         WHERE nombre LIKE ? OR matricula LIKE ?
         ORDER BY nombre LIMIT 12`,
        [lk, lk]
      );
      return send(res, 200, { rows });
    }

    if (p === '/api/alumnos' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede registrar alumnos.' });
      const body = await readBody(req);
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return send(res, 400, { error: 'Escribe el nombre del alumno.' });
      const matricula = String(body.matricula || '').trim();
      const sexo = String(body.sexo || '').trim().slice(0, 1);
      const programa = String(body.programa_habitual || '').trim();
      const fecha = body.fecha_registro || null;
      if (matricula) {
        const dup = await query('SELECT id FROM alumnos WHERE matricula = ? LIMIT 1', [matricula]);
        if (dup.length) return send(res, 409, { error: 'Ya existe un alumno con esa matrícula.' });
      }
      const dupN = await query('SELECT id FROM alumnos WHERE nombre = ? LIMIT 1', [nombre]);
      if (dupN.length) return send(res, 409, { error: 'Ya existe un alumno con ese nombre exacto.' });
      const ins = await query(
        `INSERT INTO alumnos (nombre, matricula, sexo, programa_habitual, fecha_registro)
         VALUES (?, ?, ?, ?, ?)`,
        [nombre, matricula || null, sexo || null, programa || null, fecha]
      );
      return send(res, 201, { id: ins.insertId, nombre, matricula, sexo, programa_habitual: programa, fecha_registro: fecha });
    }

    const aluId = p.match(/^\/api\/alumnos\/(\d+)$/);
    if (aluId && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede editar alumnos.' });
      const id = Number(aluId[1]);
      const body = await readBody(req);
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return send(res, 400, { error: 'Escribe el nombre del alumno.' });
      const matricula = String(body.matricula || '').trim();
      const sexo = String(body.sexo || '').trim().slice(0, 1);
      const programa = String(body.programa_habitual || '').trim();
      const fecha = body.fecha_registro || null;
      if (matricula) {
        const dup = await query('SELECT id FROM alumnos WHERE matricula = ? AND id <> ? LIMIT 1', [matricula, id]);
        if (dup.length) return send(res, 409, { error: 'Ya existe un alumno con esa matrícula.' });
      }
      const dupN = await query('SELECT id FROM alumnos WHERE nombre = ? AND id <> ? LIMIT 1', [nombre, id]);
      if (dupN.length) return send(res, 409, { error: 'Ya existe un alumno con ese nombre exacto.' });
      const prev = await query('SELECT nombre FROM alumnos WHERE id = ?', [id]);
      if (!prev.length) return send(res, 404, { error: 'Alumno no encontrado' });
      const r = await query(
        `UPDATE alumnos SET nombre=?, matricula=?, sexo=?, programa_habitual=?, fecha_registro=? WHERE id=?`,
        [nombre, matricula || null, sexo || null, programa || null, fecha, id]
      );
      if (!r.affectedRows) return send(res, 404, { error: 'Alumno no encontrado' });
      if (prev[0].nombre && prev[0].nombre !== nombre) {
        await query('UPDATE bd SET alumno = ? WHERE alumno = ?', [nombre, prev[0].nombre]);
        await query('UPDATE bd_asignacion SET nombre_alumno = ? WHERE nombre_alumno = ?', [nombre, prev[0].nombre]);
      }
      return send(res, 200, { ok: true });
    }
    if (aluId && m === 'DELETE') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede borrar alumnos.' });
      const id = Number(aluId[1]);
      const links = await query('SELECT COUNT(*) AS n FROM bd_alumnos WHERE alumno_id = ?', [id]);
      if (Number(links[0].n) > 0) {
        return send(res, 409, { error: 'No se puede borrar: el alumno tiene tesis vinculadas.' });
      }
      const r = await query('DELETE FROM alumnos WHERE id = ?', [id]);
      if (!r.affectedRows) return send(res, 404, { error: 'Alumno no encontrado' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/bd' && m === 'GET') {
      const { page, limit, offset } = pageLimit(url);
      const anio = url.searchParams.get('anio') || '';
      const grado = url.searchParams.get('grado') || '';
      const ciudad = url.searchParams.get('ciudad') || '';
      const programa = url.searchParams.get('programa') || '';
      const punto = url.searchParams.get('punto') || '';
      const qtxt = (url.searchParams.get('q') || '').trim();
      const sortKey = BD_SORT[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'id';
      const dir = url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
      let where = ' WHERE 1=1';
      const params = [];
      if (/^\d{4}$/.test(anio)) { where += ' AND anio = ?'; params.push(Number(anio)); }
      if (grado && grado !== 'Todos') { where += ' AND grado = ?'; params.push(grado); }
      if (ciudad && ciudad !== 'Todas') { where += ' AND ciudad = ?'; params.push(ciudad); }
      if (programa && programa !== 'Todos') { where += ' AND programa = ?'; params.push(programa); }
      if (punto && punto !== 'Todos') { where += ' AND punto = ?'; params.push(punto); }
      if (qtxt) {
        const lk = like(qtxt);
        where += ' AND (alumno LIKE ? OR titulo_tesis LIKE ? OR docente LIKE ? OR folio LIKE ?)';
        params.push(lk, lk, lk, lk);
      }
      const totalRows = await query('SELECT COUNT(*) AS n FROM bd' + where, params);
      const orderCol = BD_SORT[sortKey] || 'id';
      const rows = await query(
        `SELECT id, anio, \`no\`, folio, alumno, grado, titulo_tesis, fecha_elaboracion, docente, fungio,
                punto, ciudad, no_tesis, no_caja, capturo, fecha_captura, archivo, digital, programa,
                no_empleado, observaciones, pdf, cd, docente_id
         FROM bd${where}
         ORDER BY ${orderCol} ${dir}, id ASC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      return send(res, 200, { page, limit, total: Number(totalRows[0].n), rows });
    }

    if (p === '/api/bd/siguiente-folio' && m === 'GET') {
      const rows = await query("SELECT MAX(CAST(folio AS UNSIGNED)) AS mx FROM bd WHERE folio REGEXP '^[0-9]+$'");
      const mx = Number(rows[0] && rows[0].mx) || 0;
      return send(res, 200, { folio: String(mx + 1) });
    }

    const folioPath = p.match(/^\/api\/bd\/(\d+)\/folio$/);
    if (folioPath && m === 'PATCH') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede editar folios.' });
      const id = Number(folioPath[1]);
      const body = await readBody(req);
      let folio = String(body.folio ?? '').trim();
      if (folio.length > 20) return send(res, 400, { error: 'El folio admite máximo 20 caracteres.' });
      if (!folio) folio = null;
      const rows = await query('SELECT id, anio, alumno, titulo_tesis, folio FROM bd WHERE id = ?', [id]);
      if (!rows.length) return send(res, 404, { error: 'Registro no encontrado' });
      const base = rows[0];
      if (folio) {
        const others = await query(
          `SELECT id, anio, alumno, titulo_tesis FROM bd
           WHERE folio = ? AND NOT (anio <=> ? AND alumno <=> ? AND titulo_tesis <=> ?)
           LIMIT 5`,
          [folio, base.anio, base.alumno, base.titulo_tesis]
        );
        if (others.length && !body.confirmar) {
          return send(res, 409, {
            duplicate: true,
            error: 'Ese folio ya lo usa otra tesis. ¿Deseas guardarlo de todos modos?'
          });
        }
      }
      const anterior = base.folio == null ? '' : String(base.folio);
      const n = await withTransaction(async q => {
        const upd = await q(
          `UPDATE bd SET folio = ? WHERE anio <=> ? AND alumno <=> ? AND titulo_tesis <=> ?`,
          [folio, base.anio, base.alumno, base.titulo_tesis]
        );
        await historialInsert(q, {
          tipo: 'Cambio de folio',
          valor_anterior: anterior,
          valor_nuevo: folio || '',
          usuario: usuarioDe(req, body),
          detalle: `Tesis ${base.anio || ''} · ${(base.alumno || '').slice(0, 80)}`
        });
        return upd.affectedRows;
      });
      return send(res, 200, { ok: true, actualizados: n, folio: folio || '' });
    }

    const bdId = p.match(/^\/api\/bd\/(\d+)$/);
    if (bdId && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede editar la base de datos.' });
      const id = Number(bdId[1]);
      const b = await readBody(req);
      const prev = await query('SELECT * FROM bd WHERE id = ?', [id]);
      if (!prev.length) return send(res, 404, { error: 'Registro no encontrado' });
      const fecha = emptyToNull(b.fecha_elaboracion);
      const anio = b.anio != null && b.anio !== ''
        ? Number(b.anio)
        : (fecha && /^\d{4}/.test(fecha) ? Number(String(fecha).slice(0, 4)) : prev[0].anio);
      await withTransaction(async q => {
        const resD = await resolverDocente(q, b.docente, b.docente_id);
        await q(
          `UPDATE bd SET anio=?, \`no\`=?, folio=?, alumno=?, grado=?, titulo_tesis=?, fecha_elaboracion=?,
              docente=?, fungio=?, punto=?, ciudad=?, no_caja=?, capturo=?, fecha_captura=?,
              archivo=?, digital=?, programa=?, no_empleado=?, observaciones=?, pdf=?, cd=?, docente_id=?
           WHERE id=?`,
          [
            anio, emptyToNull(b.no), emptyToNull(String(b.folio || '').slice(0, 20)),
            emptyToNull(b.alumno), emptyToNull(b.grado), emptyToNull(b.titulo_tesis), fecha,
            resD.nombre, emptyToNull(b.fungio), emptyToNull(b.punto), emptyToNull(b.ciudad),
            emptyToNull(b.no_caja), emptyToNull(b.capturo), emptyToNull(b.fecha_captura),
            emptyToNull(b.archivo), emptyToNull(b.digital), emptyToNull(b.programa),
            resD.noEmp, emptyToNull(b.observaciones), emptyToNull(b.pdf), emptyToNull(b.cd),
            resD.id, id
          ]
        );
        const viejo = prev[0].docente_id;
        if (viejo && Number(viejo) !== Number(resD.id)) await renumerarNoTesis(q, viejo);
        await renumerarNoTesis(q, resD.id);
        await historialInsert(q, {
          tipo: 'Edición BD',
          valor_anterior: (prev[0].docente || '') + ' · ' + (prev[0].titulo_tesis || ''),
          valor_nuevo: (resD.nombre || '') + ' · ' + (b.titulo_tesis || ''),
          usuario: usuarioDe(req, b),
          detalle: 'Registro id ' + id
        });
      });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/tesis' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede registrar tesis.' });
      const body = await readBody(req);
      const titulo = String(body.titulo || '').trim();
      const grado = String(body.grado || '').trim();
      const folio = String(body.folio || '').trim().slice(0, 20);
      const slots = Array.isArray(body.docentes) ? body.docentes.filter(s => String(s.nombre || '').trim()) : [];
      if (!titulo || !grado || !slots.length) {
        return send(res, 400, { error: 'Faltan título, grado o al menos un docente.' });
      }
      const fecha = body.fecha || null;
      const anio = fecha && /^\d{4}/.test(fecha) ? Number(String(fecha).slice(0, 4)) : new Date().getFullYear();
      let alumnoIds = Array.isArray(body.alumno_ids) ? body.alumno_ids.map(Number).filter(Boolean) : [];
      const nombresRaw = String(body.alumno || '').split(/\r?\n|\\n/).map(s => s.trim()).filter(Boolean);
      const alumnoTxt = nombresRaw.join('\n');
      if (!alumnoTxt) return send(res, 400, { error: 'Falta el alumno.' });

      const ids = await withTransaction(async q => {
        const resolved = [];
        for (const id of alumnoIds) {
          const rows = await q('SELECT id, nombre FROM alumnos WHERE id = ?', [id]);
          if (rows[0]) resolved.push(rows[0]);
        }
        for (const nom of nombresRaw) {
          if (resolved.some(a => a.nombre === nom)) continue;
          const found = await q('SELECT id, nombre FROM alumnos WHERE nombre = ? LIMIT 1', [nom]);
          if (found[0]) resolved.push(found[0]);
          else {
            const insA = await q(
              'INSERT INTO alumnos (nombre, programa_habitual, fecha_registro) VALUES (?, ?, ?)',
              [nom, body.programa || null, body.fecha_cap || fecha]
            );
            resolved.push({ id: insA.insertId, nombre: nom });
          }
        }
        const inserted = [];
        const docentesTocados = new Set();
        for (const s of slots) {
          const resD = await resolverDocente(q, s.nombre, s.id);
          docentesTocados.add(resD.id);
          const ins = await q(
            `INSERT INTO bd (anio, folio, alumno, grado, titulo_tesis, fecha_elaboracion, docente, fungio,
                             punto, ciudad, capturo, fecha_captura, archivo, digital, programa,
                             no_empleado, observaciones, docente_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              anio, folio || null, alumnoTxt, grado, titulo, fecha, resD.nombre, s.fungio || null,
              body.punto || null, body.ciudad || null, body.capturo || null, body.fecha_cap || null,
              body.archivo || null, body.digital || null, body.programa || null,
              resD.noEmp, body.obs || null, resD.id
            ]
          );
          inserted.push(ins.insertId);
          for (const a of resolved) {
            await q('INSERT INTO bd_alumnos (bd_id, alumno_id) VALUES (?, ?)', [ins.insertId, a.id]);
          }
        }
        for (const did of docentesTocados) await renumerarNoTesis(q, did);
        return inserted;
      });
      return send(res, 201, { ok: true, ids });
    }

    if (p === '/api/docentes' && m === 'GET') {
      const { page, limit, offset } = pageLimit(url, 50);
      const qtxt = (url.searchParams.get('q') || '').trim();
      let where = ' WHERE 1=1';
      const params = [];
      if (qtxt) {
        const lk = like(qtxt);
        where += ' AND (v.Docente LIKE ? OR v.`No. Empleado` LIKE ?)';
        params.push(lk, lk);
      }
      const totalRows = await query('SELECT COUNT(*) AS n FROM v_docentes v' + where, params);
      const rows = await query(
        `SELECT v.\`No.\` AS id, v.\`No.\` AS no_num, v.Docente AS nombre, v.\`No. Empleado\` AS num_empleado,
                v.\`Teléfono\` AS telefono, v.Correo AS correo, v.Sexo AS sexo, v.TC AS tc,
                v.\`No. Tesis\` AS no_tesis
         FROM v_docentes v
         ${where}
         ORDER BY v.\`No.\`
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      return send(res, 200, { page, limit, total: Number(totalRows[0].n), rows });
    }

    if (p === '/api/docentes/buscar' && m === 'GET') {
      const qtxt = (url.searchParams.get('q') || '').trim();
      if (!qtxt) return send(res, 200, { rows: [] });
      const lk = like(qtxt);
      const rows = await query(
        `SELECT id, nombre, num_empleado, sexo, tc FROM docentes
         WHERE nombre LIKE ? OR num_empleado LIKE ?
         ORDER BY nombre LIMIT 12`,
        [lk, lk]
      );
      return send(res, 200, { rows });
    }

    if (p === '/api/docentes' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede registrar docentes.' });
      const body = await readBody(req);
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return send(res, 400, { error: 'Escribe el nombre del docente.' });
      const ins = await query(
        `INSERT INTO docentes (nombre, num_empleado, telefono, correo, sexo, tc) VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, body.num_empleado || null, body.telefono || null, body.correo || null, body.sexo || null, body.tc || null]
      );
      return send(res, 201, { id: ins.insertId });
    }

    const docenteId = p.match(/^\/api\/docentes\/(\d+)$/);
    if (docenteId && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede editar docentes.' });
      const id = Number(docenteId[1]);
      const body = await readBody(req);
      const nombre = String(body.nombre || '').trim();
      if (!nombre) return send(res, 400, { error: 'Escribe el nombre del docente.' });
      const prev = await query('SELECT * FROM docentes WHERE id = ?', [id]);
      if (!prev.length) return send(res, 404, { error: 'Docente no encontrado' });
      await query(
        `UPDATE docentes SET nombre=?, num_empleado=?, telefono=?, correo=?, sexo=?, tc=? WHERE id=?`,
        [
          nombre,
          emptyToNull(body.num_empleado),
          emptyToNull(body.telefono),
          emptyToNull(body.correo),
          emptyToNull(body.sexo),
          emptyToNull(body.tc),
          id
        ]
      );
      if (prev[0].nombre !== nombre) {
        await query('UPDATE bd SET docente = ? WHERE docente_id = ?', [nombre, id]);
        await query('UPDATE bd_asignacion SET nombre_docente = ? WHERE nombre_docente = ?', [nombre, prev[0].nombre]);
      }
      const emp = emptyToNull(body.num_empleado);
      if (emp) await query('UPDATE bd SET no_empleado = ? WHERE docente_id = ?', [emp, id]);
      return send(res, 200, { ok: true });
    }

    if (docenteId && m === 'GET') {
      const id = Number(docenteId[1]);
      const docs = await query('SELECT * FROM docentes WHERE id = ?', [id]);
      if (!docs.length) return send(res, 404, { error: 'Docente no encontrado' });
      const filas = await query(
        `SELECT anio, alumno, titulo_tesis, fungio, grado, ciudad, folio, no_tesis
         FROM bd WHERE docente_id = ?
         ORDER BY anio DESC, id DESC`,
        [id]
      );
      return send(res, 200, { docente: docs[0], filas });
    }

    if (p === '/api/actividad' && m === 'GET') {
      const anio = url.searchParams.get('anio') || '';
      const ciudad = url.searchParams.get('ciudad') || 'GENERAL';
      let rows;
      if (/^\d{4}$/.test(anio) && ciudad && ciudad !== 'GENERAL') {
        rows = await query(
          `SELECT \`Año\` AS anio, \`No\` AS no_num, Docente AS docente, Ciudad AS ciudad,
                  \`L A\` AS l_a, \`L R\` AS l_r, \`M A\` AS m_a, \`M D\` AS m_d, \`M R\` AS m_r,
                  \`D A\` AS d_a, \`D D\` AS d_d, \`D R\` AS d_r, TOTAL AS total
           FROM v_actividad_docente
           WHERE \`Año\` = ? AND Ciudad = ?
           ORDER BY TOTAL DESC, Docente`,
          [Number(anio), ciudad]
        );
      } else if (/^\d{4}$/.test(anio)) {
        rows = await query(
          `SELECT \`Año\` AS anio, MIN(\`No\`) AS no_num, Docente AS docente, 'GENERAL' AS ciudad,
                  SUM(\`L A\`) AS l_a, SUM(\`L R\`) AS l_r, SUM(\`M A\`) AS m_a, SUM(\`M D\`) AS m_d, SUM(\`M R\`) AS m_r,
                  SUM(\`D A\`) AS d_a, SUM(\`D D\`) AS d_d, SUM(\`D R\`) AS d_r, SUM(TOTAL) AS total
           FROM v_actividad_docente
           WHERE \`Año\` = ?
           GROUP BY \`Año\`, Docente
           ORDER BY total DESC, Docente`,
          [Number(anio)]
        );
      } else if (ciudad && ciudad !== 'GENERAL') {
        rows = await query(
          `SELECT \`Año\` AS anio, \`No\` AS no_num, Docente AS docente, Ciudad AS ciudad,
                  \`L A\` AS l_a, \`L R\` AS l_r, \`M A\` AS m_a, \`M D\` AS m_d, \`M R\` AS m_r,
                  \`D A\` AS d_a, \`D D\` AS d_d, \`D R\` AS d_r, TOTAL AS total
           FROM v_actividad_docente
           WHERE Ciudad = ?
           ORDER BY \`Año\` DESC, TOTAL DESC, Docente`,
          [ciudad]
        );
      } else {
        rows = await query(
          `SELECT \`Año\` AS anio, MIN(\`No\`) AS no_num, Docente AS docente, 'GENERAL' AS ciudad,
                  SUM(\`L A\`) AS l_a, SUM(\`L R\`) AS l_r, SUM(\`M A\`) AS m_a, SUM(\`M D\`) AS m_d, SUM(\`M R\`) AS m_r,
                  SUM(\`D A\`) AS d_a, SUM(\`D D\`) AS d_d, SUM(\`D R\`) AS d_r, SUM(TOTAL) AS total
           FROM v_actividad_docente
           GROUP BY \`Año\`, Docente
           ORDER BY \`Año\` DESC, total DESC, Docente`
        );
      }
      const filtros = await query(
        `SELECT DISTINCT \`Año\` AS anio FROM v_actividad_docente WHERE \`Año\` IS NOT NULL ORDER BY \`Año\` DESC`
      );
      const ciudades = await query(
        `SELECT DISTINCT Ciudad AS ciudad FROM v_actividad_docente WHERE Ciudad IS NOT NULL AND Ciudad <> '' ORDER BY Ciudad`
      );
      return send(res, 200, {
        anios: filtros.map(r => r.anio),
        ciudades: ciudades.map(r => r.ciudad),
        rows
      });
    }

    if (p === '/api/constancias' && m === 'GET') {
      const folio = (url.searchParams.get('folio') || '').trim();
      if (!folio) return send(res, 400, { error: 'Escribe el folio.' });
      const filas = await query(
        `SELECT b.id, b.anio, b.folio, b.alumno, b.grado, b.titulo_tesis, b.fecha_elaboracion, b.docente, b.fungio,
                b.punto, b.ciudad, b.no_tesis, b.no_caja, b.programa, b.docente_id,
                d.sexo AS docente_sexo, d.num_empleado
         FROM bd b LEFT JOIN docentes d ON d.id = b.docente_id
         WHERE b.folio = ? ORDER BY b.id`,
        [folio]
      );
      if (!filas.length) return send(res, 200, { found: false });
      const groups = [];
      for (const row of filas) {
        let g = groups.find(x => sameTesis(x, row));
        if (!g) {
          g = {
            anio: row.anio, alumno: row.alumno, titulo_tesis: row.titulo_tesis,
            grado: row.grado, fecha_elaboracion: row.fecha_elaboracion,
            programa: row.programa, ciudad: row.ciudad, no_tesis: row.no_tesis,
            no_caja: row.no_caja, folio: row.folio, punto: row.punto,
            ids: [], docentes: [], alumnos: []
          };
          groups.push(g);
        }
        g.ids.push(row.id);
        g.docentes.push({
          nombre: row.docente, fungio: row.fungio, docente_id: row.docente_id,
          sexo: row.docente_sexo, num_empleado: row.num_empleado
        });
      }
      for (const g of groups) {
        const ph = g.ids.map(() => '?').join(',');
        g.alumnos = await query(
          `SELECT DISTINCT a.id, a.nombre, a.matricula, a.sexo
           FROM bd_alumnos ba JOIN alumnos a ON a.id = ba.alumno_id
           WHERE ba.bd_id IN (${ph})
           ORDER BY a.nombre`,
          g.ids
        );
        delete g.ids;
      }
      return send(res, 200, { found: true, tesis: groups });
    }

    if (p === '/api/historial' && m === 'GET') {
      const rows = await query(
        `SELECT id, tipo, valor_anterior, valor_nuevo, usuario, detalle, creado_en
         FROM app_historial ORDER BY creado_en DESC, id DESC LIMIT 200`
      );
      return send(res, 200, { rows });
    }

    if (p === '/api/historial' && m === 'POST') {
      const body = await readBody(req);
      await historialInsert(query, {
        tipo: String(body.tipo || 'Documento').slice(0, 60),
        valor_anterior: body.valor_anterior || null,
        valor_nuevo: body.valor_nuevo || null,
        usuario: usuarioDe(req, body),
        detalle: body.detalle || null
      });
      return send(res, 201, { ok: true });
    }

    if (p === '/api/asignacion' && m === 'GET') {
      const { page, limit, offset } = pageLimit(url, 50);
      const anio = url.searchParams.get('anio') || '';
      const estatus = url.searchParams.get('estatus') || '';
      const qtxt = (url.searchParams.get('q') || '').trim();
      let where = ' WHERE 1=1';
      const params = [];
      if (/^\d{4}$/.test(anio)) { where += ' AND anio = ?'; params.push(Number(anio)); }
      if (estatus && estatus !== 'Todos') { where += ' AND estatus = ?'; params.push(estatus); }
      if (qtxt) {
        const lk = like(qtxt);
        where += ' AND (nombre_alumno LIKE ? OR matricula LIKE ? OR nombre_docente LIKE ? OR folio_a LIKE ? OR folio_m LIKE ?)';
        params.push(lk, lk, lk, lk, lk);
      }
      const totalRows = await query('SELECT COUNT(*) AS n FROM bd_asignacion' + where, params);
      const rows = await query(
        `SELECT id, anio, \`no\`, folio_a, sexo, nombre_alumno, matricula, programa, telefono_a, correo_a,
                folio_m, nombre_docente, telefono_docente, correo_docente, fecha_solicitud, estatus, ea, ed,
                tesis_entregada, observaciones, alumno_id, docente_id
         FROM bd_asignacion${where}
         ORDER BY anio DESC, id ASC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const anios = await query('SELECT DISTINCT anio AS v FROM bd_asignacion WHERE anio IS NOT NULL ORDER BY anio DESC');
      const estatuses = await query("SELECT DISTINCT estatus AS v FROM bd_asignacion WHERE estatus IS NOT NULL AND estatus <> '' ORDER BY estatus");
      return send(res, 200, {
        page, limit, total: Number(totalRows[0].n), rows,
        anios: anios.map(r => r.v),
        estatuses: estatuses.map(r => r.v)
      });
    }

    if (p === '/api/asignacion' && m === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede agregar asignaciones.' });
      const b = await readBody(req);
      const ins = await query(
        `INSERT INTO bd_asignacion (anio, \`no\`, folio_a, sexo, nombre_alumno, matricula, programa, telefono_a, correo_a,
            folio_m, nombre_docente, telefono_docente, correo_docente, fecha_solicitud, estatus, ea, ed,
            tesis_entregada, observaciones, alumno_id, docente_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.anio || null, b.no || null, String(b.folio_a || '').slice(0, 20) || null, b.sexo || null,
          b.nombre_alumno || null, b.matricula || null, b.programa || null, b.telefono_a || null, b.correo_a || null,
          String(b.folio_m || '').slice(0, 20) || null, b.nombre_docente || null, b.telefono_docente || null,
          b.correo_docente || null, b.fecha_solicitud || null, b.estatus || null, b.ea || null, b.ed || null,
          b.tesis_entregada || null, b.observaciones || null, b.alumno_id || null, b.docente_id || null
        ]
      );
      return send(res, 201, { id: ins.insertId });
    }

    const asId = p.match(/^\/api\/asignacion\/(\d+)$/);
    if (asId && m === 'PUT') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Solo el administrador puede editar asignaciones.' });
      const id = Number(asId[1]);
      const b = await readBody(req);
      const resD = b.nombre_docente ? await resolverDocente(query, b.nombre_docente, b.docente_id) : { id: null };
      const r = await query(
        `UPDATE bd_asignacion SET anio=?, \`no\`=?, folio_a=?, sexo=?, nombre_alumno=?, matricula=?, programa=?,
            telefono_a=?, correo_a=?, folio_m=?, nombre_docente=?, telefono_docente=?, correo_docente=?,
            fecha_solicitud=?, estatus=?, ea=?, ed=?, tesis_entregada=?, observaciones=?, docente_id=?
         WHERE id=?`,
        [
          b.anio || null, b.no || null, String(b.folio_a || '').slice(0, 20) || null, b.sexo || null,
          b.nombre_alumno || null, b.matricula || null, b.programa || null, b.telefono_a || null, b.correo_a || null,
          String(b.folio_m || '').slice(0, 20) || null, b.nombre_docente || null, b.telefono_docente || null,
          b.correo_docente || null, b.fecha_solicitud || null, b.estatus || null, b.ea || null, b.ed || null,
          b.tesis_entregada || null, b.observaciones || null, resD.id, id
        ]
      );
      if (!r.affectedRows) return send(res, 404, { error: 'Asignación no encontrada' });
      return send(res, 200, { ok: true });
    }

    if (p === '/api/asignacion/oficio' && m === 'GET') {
      const tipo = (url.searchParams.get('tipo') || 'Alumno').trim();
      const folio = (url.searchParams.get('folio') || '').trim();
      if (!folio) return send(res, 400, { error: 'Escribe el folio.' });
      const esDir = /^(Doctor|Doctora|Maestro)/i.test(tipo);
      const col = esDir ? 'folio_m' : 'folio_a';
      let rows = await query(`SELECT * FROM bd_asignacion WHERE ${col} = ? ORDER BY id`, [folio]);
      if (!rows.length) {
        const otra = esDir ? 'folio_a' : 'folio_m';
        rows = await query(`SELECT * FROM bd_asignacion WHERE ${otra} = ? ORDER BY id`, [folio]);
      }
      if (!rows.length) return send(res, 200, { found: false });
      let relacionados = [];
      if (/^comit/i.test(tipo) && rows[0].nombre_alumno) {
        const alum = String(rows[0].nombre_alumno).trim();
        relacionados = await query(
          `SELECT docente, fungio FROM bd WHERE alumno = ? OR alumno LIKE ? ORDER BY id LIMIT 40`,
          [alum, '%' + alum + '%']
        );
      }
      return send(res, 200, { found: true, tipo, rows, relacionados });
    }

    return send(res, 404, { error: 'Ruta no encontrada' });
  } catch (err) {
    if (err && err.message === 'JSON inválido') return send(res, 400, { error: err.message });
    return send(res, 500, { error: conexionError(err) });
  }
}

module.exports = { handleApi, ensureAppTables };
