<?php
header('Content-Type: application/json; charset=utf-8');

$BD_SORT = [
  'no' => '`no`', 'folio' => 'folio', 'alumno' => 'alumno', 'grado' => 'grado',
  'titulo_tesis' => 'titulo_tesis', 'fecha_elaboracion' => 'fecha_elaboracion',
  'docente' => 'docente', 'fungio' => 'fungio', 'punto' => 'punto', 'ciudad' => 'ciudad',
  'no_tesis' => 'no_tesis', 'no_caja' => 'no_caja', 'capturo' => 'capturo',
  'fecha_captura' => 'fecha_captura', 'archivo' => 'archivo', 'digital' => 'digital',
  'programa' => 'programa', 'no_empleado' => 'no_empleado', 'observaciones' => 'observaciones',
  'pdf' => 'pdf', 'cd' => 'cd', 'anio' => 'anio', 'id' => 'id'
];

function send(int $status, $body): void {
  http_response_code($status);
  echo is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_UNICODE);
  exit;
}

function like(string $q): string {
  return '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
}

function page_limit(int $def = 50): array {
  $page = max(1, (int)($_GET['page'] ?? 1) ?: 1);
  $raw = (int)($_GET['limit'] ?? $def);
  $limit = min(500, max(1, $raw ?: $def));
  return ['page' => $page, 'limit' => $limit, 'offset' => ($page - 1) * $limit];
}

function is_admin(): bool {
  $rol = $_SERVER['HTTP_X_ROL'] ?? '';
  return $rol === 'admin';
}

function usuario_de(?array $body): string {
  $u = ($body['usuario'] ?? '') ?: ($_SERVER['HTTP_X_USUARIO'] ?? 'Administrador');
  return substr((string)$u, 0, 120);
}

function read_body(): array {
  $raw = file_get_contents('php://input') ?: '';
  if ($raw === '') return [];
  $data = json_decode($raw, true);
  if (!is_array($data)) send(400, ['error' => 'JSON inválido']);
  return $data;
}

function empty_to_null($v) {
  if ($v === null) return null;
  $s = trim((string)$v);
  return $s === '' ? null : $s;
}

function api_path(): string {
  $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
  if (preg_match('#/api(?:/index\\.php)?(/.*)?$#', $uri, $m)) {
    $rest = $m[1] ?? '';
    return '/api' . ($rest === '' ? '' : $rest);
  }
  return '/api';
}

function conexion_error(Throwable $err): string {
  $msg = $err->getMessage();
  if ($msg && !preg_match('/password|passwd/i', $msg)) {
    return 'Error de MySQL: ' . $msg;
  }
  return 'No se pudo conectar a MySQL. Revisa usuario, contraseña y el nombre de la base en config.php.';
}

function db_query(mysqli $db, string $sql, array $params = []): array {
  $stmt = $db->prepare($sql);
  $params ? $stmt->execute($params) : $stmt->execute();
  $res = $stmt->get_result();
  if ($res instanceof mysqli_result) {
    $rows = $res->fetch_all(MYSQLI_ASSOC);
    $res->free();
    $stmt->close();
    return $rows;
  }
  $stmt->close();
  return [];
}

function db_exec(mysqli $db, string $sql, array $params = []): array {
  $stmt = $db->prepare($sql);
  $params ? $stmt->execute($params) : $stmt->execute();
  $out = ['insertId' => $db->insert_id, 'affectedRows' => $stmt->affected_rows];
  $stmt->close();
  return $out;
}

function distinct_list(mysqli $db, string $col): array {
  return db_query(
    $db,
    "SELECT DISTINCT {$col} AS v FROM bd WHERE {$col} IS NOT NULL AND {$col} <> '' ORDER BY {$col}"
  );
}

function same_tesis(array $a, array $b): bool {
  return (int)$a['anio'] === (int)$b['anio']
    && (string)($a['alumno'] ?? '') === (string)($b['alumno'] ?? '')
    && (string)($a['titulo_tesis'] ?? '') === (string)($b['titulo_tesis'] ?? '');
}

function map_alumno_vista(array $r): array {
  return [
    'id' => $r['id'],
    'nombre' => $r['nombre'],
    'matricula' => $r['matricula'],
    'sexo' => $r['sexo'],
    'programa_habitual' => $r['programa_habitual'],
    'fecha_registro' => $r['fecha_registro'],
    'tesis' => (int)($r['tesis'] ?? 0)
  ];
}

function ensure_app_tables(mysqli $db): void {
  $db->query(
    "CREATE TABLE IF NOT EXISTS app_historial (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      tipo VARCHAR(60) NOT NULL,
      valor_anterior TEXT NULL,
      valor_nuevo TEXT NULL,
      usuario VARCHAR(120) NULL,
      detalle TEXT NULL,
      creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_app_hist_fecha (creado_en)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
}

function historial_insert(mysqli $db, array $row): void {
  db_exec(
    $db,
    'INSERT INTO app_historial (tipo, valor_anterior, valor_nuevo, usuario, detalle) VALUES (?, ?, ?, ?, ?)',
    [$row['tipo'], $row['valor_anterior'] ?? null, $row['valor_nuevo'] ?? null, $row['usuario'] ?? null, $row['detalle'] ?? null]
  );
}

function resolver_docente(mysqli $db, $nombre, $idHint): array {
  $nom = trim((string)($nombre ?? ''));
  $id = $idHint ? (int)$idHint : null;
  if ($id) {
    $d = db_query($db, 'SELECT id, num_empleado, nombre FROM docentes WHERE id = ?', [$id]);
    if ($d) return ['id' => (int)$d[0]['id'], 'noEmp' => $d[0]['num_empleado'], 'nombre' => $nom !== '' ? $nom : $d[0]['nombre']];
    $id = null;
  }
  if ($nom !== '') {
    $d = db_query($db, 'SELECT id, num_empleado, nombre FROM docentes WHERE nombre = ? LIMIT 1', [$nom]);
    if ($d) return ['id' => (int)$d[0]['id'], 'noEmp' => $d[0]['num_empleado'], 'nombre' => $d[0]['nombre']];
    $ins = db_exec($db, 'INSERT INTO docentes (nombre) VALUES (?)', [$nom]);
    return ['id' => (int)$ins['insertId'], 'noEmp' => null, 'nombre' => $nom];
  }
  return ['id' => null, 'noEmp' => null, 'nombre' => $nom !== '' ? $nom : null];
}

function renumerar_no_tesis(mysqli $db, $docenteId): void {
  if (!$docenteId) return;
  $rows = db_query($db, 'SELECT id FROM bd WHERE docente_id = ? ORDER BY fecha_elaboracion IS NULL, fecha_elaboracion, id', [(int)$docenteId]);
  $n = 1;
  foreach ($rows as $r) {
    db_exec($db, 'UPDATE bd SET no_tesis = ? WHERE id = ?', [$n++, (int)$r['id']]);
  }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$p = rtrim(api_path(), '/') ?: '/api';

try {
  require dirname(__DIR__) . '/config.php';
  ensure_app_tables($conexion);

  if ($p === '/api/salud' && $method === 'GET') {
    db_query($conexion, 'SELECT 1 AS ok');
    send(200, ['ok' => true]);
  }

  if ($p === '/api/conteos' && $method === 'GET') {
    $rows = db_query(
      $conexion,
      "SELECT 'bd' AS t, COUNT(*) AS n FROM bd
       UNION ALL SELECT 'docentes', COUNT(*) FROM docentes
       UNION ALL SELECT 'alumnos', COUNT(*) FROM alumnos
       UNION ALL SELECT 'bd_alumnos', COUNT(*) FROM bd_alumnos
       UNION ALL SELECT 'bd_asignacion', COUNT(*) FROM bd_asignacion
       UNION ALL SELECT 'v_docentes', COUNT(*) FROM v_docentes
       UNION ALL SELECT 'v_alumnos', COUNT(*) FROM v_alumnos
       UNION ALL SELECT 'v_actividad_docente', COUNT(*) FROM v_actividad_docente"
    );
    $map = [];
    foreach ($rows as $r) $map[$r['t']] = (int)$r['n'];
    send(200, $map);
  }

  if ($p === '/api/filtros' && $method === 'GET') {
    $anios = db_query($conexion, 'SELECT DISTINCT anio AS v FROM bd WHERE anio IS NOT NULL ORDER BY anio DESC');
    $grados = distinct_list($conexion, 'grado');
    $ciudades = distinct_list($conexion, 'ciudad');
    $programas = distinct_list($conexion, 'programa');
    $puntos = distinct_list($conexion, 'punto');
    send(200, [
      'anios' => array_column($anios, 'v'),
      'grados' => array_column($grados, 'v'),
      'ciudades' => array_column($ciudades, 'v'),
      'programas' => array_column($programas, 'v'),
      'puntos' => array_column($puntos, 'v')
    ]);
  }

  if ($p === '/api/alumnos' && $method === 'GET') {
    $pl = page_limit();
    $qtxt = trim((string)($_GET['q'] ?? ''));
    $where = ' WHERE 1=1';
    $params = [];
    if ($qtxt !== '') {
      $lk = like($qtxt);
      $where .= ' AND (v.Alumno LIKE ? OR v.`Matrícula` LIKE ?)';
      $params[] = $lk;
      $params[] = $lk;
    }
    $totalRows = db_query($conexion, 'SELECT COUNT(*) AS n FROM v_alumnos v' . $where, $params);
    $limit = (int)$pl['limit'];
    $offset = (int)$pl['offset'];
    $rows = db_query(
      $conexion,
      "SELECT v.id, v.Alumno AS nombre, v.`Matrícula` AS matricula, v.Sexo AS sexo,
              v.`Programa habitual` AS programa_habitual, v.`Fecha de registro` AS fecha_registro,
              v.`Tesis registradas` AS tesis
       FROM v_alumnos v{$where}
       ORDER BY v.Alumno
       LIMIT {$limit} OFFSET {$offset}",
      $params
    );
    send(200, ['page' => $pl['page'], 'limit' => $pl['limit'], 'total' => (int)$totalRows[0]['n'], 'rows' => array_map('map_alumno_vista', $rows)]);
  }

  if ($p === '/api/alumnos/buscar' && $method === 'GET') {
    $qtxt = trim((string)($_GET['q'] ?? ''));
    if ($qtxt === '') send(200, ['rows' => []]);
    $lk = like($qtxt);
    $rows = db_query(
      $conexion,
      'SELECT id, nombre, matricula, sexo, programa_habitual FROM alumnos WHERE nombre LIKE ? OR matricula LIKE ? ORDER BY nombre LIMIT 12',
      [$lk, $lk]
    );
    send(200, ['rows' => $rows]);
  }

  if ($p === '/api/alumnos' && $method === 'POST') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede registrar alumnos.']);
    $body = read_body();
    $nombre = trim((string)($body['nombre'] ?? ''));
    if ($nombre === '') send(400, ['error' => 'Escribe el nombre del alumno.']);
    $matricula = trim((string)($body['matricula'] ?? ''));
    $sexo = substr(trim((string)($body['sexo'] ?? '')), 0, 1);
    $programa = trim((string)($body['programa_habitual'] ?? ''));
    $fecha = $body['fecha_registro'] ?? null;
    if ($matricula !== '') {
      $dup = db_query($conexion, 'SELECT id FROM alumnos WHERE matricula = ? LIMIT 1', [$matricula]);
      if ($dup) send(409, ['error' => 'Ya existe un alumno con esa matrícula.']);
    }
    $dupN = db_query($conexion, 'SELECT id FROM alumnos WHERE nombre = ? LIMIT 1', [$nombre]);
    if ($dupN) send(409, ['error' => 'Ya existe un alumno con ese nombre exacto.']);
    $ins = db_exec(
      $conexion,
      'INSERT INTO alumnos (nombre, matricula, sexo, programa_habitual, fecha_registro) VALUES (?, ?, ?, ?, ?)',
      [$nombre, $matricula !== '' ? $matricula : null, $sexo !== '' ? $sexo : null, $programa !== '' ? $programa : null, $fecha]
    );
    send(201, ['id' => $ins['insertId'], 'nombre' => $nombre, 'matricula' => $matricula, 'sexo' => $sexo, 'programa_habitual' => $programa, 'fecha_registro' => $fecha]);
  }

  if (preg_match('#^/api/alumnos/(\\d+)$#', $p, $aluId)) {
    $id = (int)$aluId[1];
    if ($method === 'PUT') {
      if (!is_admin()) send(403, ['error' => 'Solo el administrador puede editar alumnos.']);
      $body = read_body();
      $nombre = trim((string)($body['nombre'] ?? ''));
      if ($nombre === '') send(400, ['error' => 'Escribe el nombre del alumno.']);
      $matricula = trim((string)($body['matricula'] ?? ''));
      $sexo = substr(trim((string)($body['sexo'] ?? '')), 0, 1);
      $programa = trim((string)($body['programa_habitual'] ?? ''));
      $fecha = $body['fecha_registro'] ?? null;
      if ($matricula !== '') {
        $dup = db_query($conexion, 'SELECT id FROM alumnos WHERE matricula = ? AND id <> ? LIMIT 1', [$matricula, $id]);
        if ($dup) send(409, ['error' => 'Ya existe un alumno con esa matrícula.']);
      }
      $dupN = db_query($conexion, 'SELECT id FROM alumnos WHERE nombre = ? AND id <> ? LIMIT 1', [$nombre, $id]);
      if ($dupN) send(409, ['error' => 'Ya existe un alumno con ese nombre exacto.']);
      $prev = db_query($conexion, 'SELECT nombre FROM alumnos WHERE id = ?', [$id]);
      if (!$prev) send(404, ['error' => 'Alumno no encontrado']);
      $r = db_exec(
        $conexion,
        'UPDATE alumnos SET nombre=?, matricula=?, sexo=?, programa_habitual=?, fecha_registro=? WHERE id=?',
        [$nombre, $matricula !== '' ? $matricula : null, $sexo !== '' ? $sexo : null, $programa !== '' ? $programa : null, $fecha, $id]
      );
      if (!$r['affectedRows']) send(404, ['error' => 'Alumno no encontrado']);
      if (!empty($prev[0]['nombre']) && $prev[0]['nombre'] !== $nombre) {
        db_exec($conexion, 'UPDATE bd SET alumno = ? WHERE alumno = ?', [$nombre, $prev[0]['nombre']]);
        db_exec($conexion, 'UPDATE bd_asignacion SET nombre_alumno = ? WHERE nombre_alumno = ?', [$nombre, $prev[0]['nombre']]);
      }
      send(200, ['ok' => true]);
    }
    if ($method === 'DELETE') {
      if (!is_admin()) send(403, ['error' => 'Solo el administrador puede borrar alumnos.']);
      $links = db_query($conexion, 'SELECT COUNT(*) AS n FROM bd_alumnos WHERE alumno_id = ?', [$id]);
      if ((int)$links[0]['n'] > 0) send(409, ['error' => 'No se puede borrar: el alumno tiene tesis vinculadas.']);
      $r = db_exec($conexion, 'DELETE FROM alumnos WHERE id = ?', [$id]);
      if (!$r['affectedRows']) send(404, ['error' => 'Alumno no encontrado']);
      send(200, ['ok' => true]);
    }
  }

  if ($p === '/api/bd' && $method === 'GET') {
    $pl = page_limit();
    $anio = (string)($_GET['anio'] ?? '');
    $grado = (string)($_GET['grado'] ?? '');
    $ciudad = (string)($_GET['ciudad'] ?? '');
    $programa = (string)($_GET['programa'] ?? '');
    $punto = (string)($_GET['punto'] ?? '');
    $qtxt = trim((string)($_GET['q'] ?? ''));
    $sortKey = isset($BD_SORT[$_GET['sort'] ?? '']) ? $_GET['sort'] : 'id';
    $dir = (($_GET['dir'] ?? '') === 'desc') ? 'DESC' : 'ASC';
    $where = ' WHERE 1=1';
    $params = [];
    if (preg_match('/^\\d{4}$/', $anio)) { $where .= ' AND anio = ?'; $params[] = (int)$anio; }
    if ($grado !== '' && $grado !== 'Todos') { $where .= ' AND grado = ?'; $params[] = $grado; }
    if ($ciudad !== '' && $ciudad !== 'Todas') { $where .= ' AND ciudad = ?'; $params[] = $ciudad; }
    if ($programa !== '' && $programa !== 'Todos') { $where .= ' AND programa = ?'; $params[] = $programa; }
    if ($punto !== '' && $punto !== 'Todos') { $where .= ' AND punto = ?'; $params[] = $punto; }
    if ($qtxt !== '') {
      $lk = like($qtxt);
      $where .= ' AND (alumno LIKE ? OR titulo_tesis LIKE ? OR docente LIKE ? OR folio LIKE ?)';
      array_push($params, $lk, $lk, $lk, $lk);
    }
    $totalRows = db_query($conexion, 'SELECT COUNT(*) AS n FROM bd' . $where, $params);
    $orderCol = $BD_SORT[$sortKey] ?? 'id';
    $limit = (int)$pl['limit'];
    $offset = (int)$pl['offset'];
    $rows = db_query(
      $conexion,
      "SELECT id, anio, `no`, folio, alumno, grado, titulo_tesis, fecha_elaboracion, docente, fungio,
              punto, ciudad, no_tesis, no_caja, capturo, fecha_captura, archivo, digital, programa,
              no_empleado, observaciones, pdf, cd, docente_id
       FROM bd{$where}
       ORDER BY {$orderCol} {$dir}, id ASC
       LIMIT {$limit} OFFSET {$offset}",
      $params
    );
    send(200, ['page' => $pl['page'], 'limit' => $pl['limit'], 'total' => (int)$totalRows[0]['n'], 'rows' => $rows]);
  }

  if ($p === '/api/bd/siguiente-folio' && $method === 'GET') {
    $rows = db_query($conexion, "SELECT MAX(CAST(folio AS UNSIGNED)) AS mx FROM bd WHERE folio REGEXP '^[0-9]+$'");
    $mx = (int)($rows[0]['mx'] ?? 0);
    send(200, ['folio' => (string)($mx + 1)]);
  }

  if (preg_match('#^/api/bd/(\\d+)/folio$#', $p, $folioPath) && $method === 'PATCH') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede editar folios.']);
    $id = (int)$folioPath[1];
    $body = read_body();
    $folio = trim((string)($body['folio'] ?? ''));
    if (strlen($folio) > 20) send(400, ['error' => 'El folio admite máximo 20 caracteres.']);
    if ($folio === '') $folio = null;
    $rows = db_query($conexion, 'SELECT id, anio, alumno, titulo_tesis, folio FROM bd WHERE id = ?', [$id]);
    if (!$rows) send(404, ['error' => 'Registro no encontrado']);
    $base = $rows[0];
    if ($folio) {
      $others = db_query(
        $conexion,
        'SELECT id, anio, alumno, titulo_tesis FROM bd
         WHERE folio = ? AND NOT (anio <=> ? AND alumno <=> ? AND titulo_tesis <=> ?)
         LIMIT 5',
        [$folio, $base['anio'], $base['alumno'], $base['titulo_tesis']]
      );
      if ($others && empty($body['confirmar'])) {
        send(409, ['duplicate' => true, 'error' => 'Ese folio ya lo usa otra tesis. ¿Deseas guardarlo de todos modos?']);
      }
    }
    $anterior = $base['folio'] === null ? '' : (string)$base['folio'];
    $conexion->begin_transaction();
    try {
      $upd = db_exec(
        $conexion,
        'UPDATE bd SET folio = ? WHERE anio <=> ? AND alumno <=> ? AND titulo_tesis <=> ?',
        [$folio, $base['anio'], $base['alumno'], $base['titulo_tesis']]
      );
      historial_insert($conexion, [
        'tipo' => 'Cambio de folio',
        'valor_anterior' => $anterior,
        'valor_nuevo' => $folio ?: '',
        'usuario' => usuario_de($body),
        'detalle' => 'Tesis ' . ($base['anio'] ?? '') . ' · ' . substr((string)($base['alumno'] ?? ''), 0, 80)
      ]);
      $conexion->commit();
      send(200, ['ok' => true, 'actualizados' => $upd['affectedRows'], 'folio' => $folio ?: '']);
    } catch (Throwable $e) {
      $conexion->rollback();
      throw $e;
    }
  }

  if (preg_match('#^/api/bd/(\\d+)$#', $p, $bdId) && $method === 'PUT') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede editar la base de datos.']);
    $id = (int)$bdId[1];
    $b = read_body();
    $prev = db_query($conexion, 'SELECT * FROM bd WHERE id = ?', [$id]);
    if (!$prev) send(404, ['error' => 'Registro no encontrado']);
    $fecha = empty_to_null($b['fecha_elaboracion'] ?? null);
    $anio = (isset($b['anio']) && $b['anio'] !== '' && $b['anio'] !== null)
      ? (int)$b['anio']
      : ($fecha && preg_match('/^\\d{4}/', $fecha) ? (int)substr($fecha, 0, 4) : $prev[0]['anio']);
    $conexion->begin_transaction();
    try {
      $resD = resolver_docente($conexion, $b['docente'] ?? null, $b['docente_id'] ?? null);
      db_exec(
        $conexion,
        'UPDATE bd SET anio=?, `no`=?, folio=?, alumno=?, grado=?, titulo_tesis=?, fecha_elaboracion=?,
            docente=?, fungio=?, punto=?, ciudad=?, no_caja=?, capturo=?, fecha_captura=?,
            archivo=?, digital=?, programa=?, no_empleado=?, observaciones=?, pdf=?, cd=?, docente_id=?
         WHERE id=?',
        [
          $anio, empty_to_null($b['no'] ?? null), empty_to_null(substr((string)($b['folio'] ?? ''), 0, 20)),
          empty_to_null($b['alumno'] ?? null), empty_to_null($b['grado'] ?? null), empty_to_null($b['titulo_tesis'] ?? null), $fecha,
          $resD['nombre'], empty_to_null($b['fungio'] ?? null), empty_to_null($b['punto'] ?? null), empty_to_null($b['ciudad'] ?? null),
          empty_to_null($b['no_caja'] ?? null), empty_to_null($b['capturo'] ?? null), empty_to_null($b['fecha_captura'] ?? null),
          empty_to_null($b['archivo'] ?? null), empty_to_null($b['digital'] ?? null), empty_to_null($b['programa'] ?? null),
          $resD['noEmp'], empty_to_null($b['observaciones'] ?? null), empty_to_null($b['pdf'] ?? null), empty_to_null($b['cd'] ?? null),
          $resD['id'], $id
        ]
      );
      $viejo = $prev[0]['docente_id'];
      if ($viejo && (int)$viejo !== (int)$resD['id']) renumerar_no_tesis($conexion, $viejo);
      renumerar_no_tesis($conexion, $resD['id']);
      historial_insert($conexion, [
        'tipo' => 'Edición BD',
        'valor_anterior' => ($prev[0]['docente'] ?? '') . ' · ' . ($prev[0]['titulo_tesis'] ?? ''),
        'valor_nuevo' => ($resD['nombre'] ?? '') . ' · ' . ($b['titulo_tesis'] ?? ''),
        'usuario' => usuario_de($b),
        'detalle' => 'Registro id ' . $id
      ]);
      $conexion->commit();
      send(200, ['ok' => true]);
    } catch (Throwable $e) {
      $conexion->rollback();
      throw $e;
    }
  }

  if ($p === '/api/tesis' && $method === 'POST') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede registrar tesis.']);
    $body = read_body();
    $titulo = trim((string)($body['titulo'] ?? ''));
    $grado = trim((string)($body['grado'] ?? ''));
    $folio = substr(trim((string)($body['folio'] ?? '')), 0, 20);
    $slots = [];
    if (!empty($body['docentes']) && is_array($body['docentes'])) {
      foreach ($body['docentes'] as $s) {
        if (trim((string)($s['nombre'] ?? '')) !== '') $slots[] = $s;
      }
    }
    if ($titulo === '' || $grado === '' || !$slots) send(400, ['error' => 'Faltan título, grado o al menos un docente.']);
    $fecha = $body['fecha'] ?? null;
    $anio = ($fecha && preg_match('/^\\d{4}/', (string)$fecha)) ? (int)substr((string)$fecha, 0, 4) : (int)date('Y');
    $alumnoIds = [];
    if (!empty($body['alumno_ids']) && is_array($body['alumno_ids'])) {
      foreach ($body['alumno_ids'] as $aid) {
        $n = (int)$aid;
        if ($n) $alumnoIds[] = $n;
      }
    }
    $nombresRaw = preg_split('/\\r?\\n|\\\\n/', (string)($body['alumno'] ?? '')) ?: [];
    $nombresRaw = array_values(array_filter(array_map('trim', $nombresRaw)));
    $alumnoTxt = implode("\n", $nombresRaw);
    if ($alumnoTxt === '') send(400, ['error' => 'Falta el alumno.']);

    $conexion->begin_transaction();
    try {
      $resolved = [];
      foreach ($alumnoIds as $aid) {
        $rows = db_query($conexion, 'SELECT id, nombre FROM alumnos WHERE id = ?', [$aid]);
        if ($rows) $resolved[] = $rows[0];
      }
      foreach ($nombresRaw as $nom) {
        $ya = false;
        foreach ($resolved as $a) if ($a['nombre'] === $nom) { $ya = true; break; }
        if ($ya) continue;
        $found = db_query($conexion, 'SELECT id, nombre FROM alumnos WHERE nombre = ? LIMIT 1', [$nom]);
        if ($found) $resolved[] = $found[0];
        else {
          $insA = db_exec($conexion, 'INSERT INTO alumnos (nombre, programa_habitual, fecha_registro) VALUES (?, ?, ?)', [$nom, $body['programa'] ?? null, $body['fecha_cap'] ?? $fecha]);
          $resolved[] = ['id' => $insA['insertId'], 'nombre' => $nom];
        }
      }
      $inserted = [];
      $docentesTocados = [];
      foreach ($slots as $s) {
        $resD = resolver_docente($conexion, $s['nombre'] ?? null, $s['id'] ?? null);
        if ($resD['id']) $docentesTocados[$resD['id']] = true;
        $ins = db_exec(
          $conexion,
          'INSERT INTO bd (anio, folio, alumno, grado, titulo_tesis, fecha_elaboracion, docente, fungio,
                           punto, ciudad, capturo, fecha_captura, archivo, digital, programa,
                           no_empleado, observaciones, docente_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            $anio, $folio !== '' ? $folio : null, $alumnoTxt, $grado, $titulo, $fecha, $resD['nombre'], $s['fungio'] ?? null,
            $body['punto'] ?? null, $body['ciudad'] ?? null, $body['capturo'] ?? null, $body['fecha_cap'] ?? null,
            $body['archivo'] ?? null, $body['digital'] ?? null, $body['programa'] ?? null,
            $resD['noEmp'], $body['obs'] ?? null, $resD['id']
          ]
        );
        $inserted[] = $ins['insertId'];
        foreach ($resolved as $a) {
          db_exec($conexion, 'INSERT INTO bd_alumnos (bd_id, alumno_id) VALUES (?, ?)', [$ins['insertId'], $a['id']]);
        }
      }
      foreach (array_keys($docentesTocados) as $did) renumerar_no_tesis($conexion, $did);
      $conexion->commit();
      send(201, ['ok' => true, 'ids' => $inserted]);
    } catch (Throwable $e) {
      $conexion->rollback();
      throw $e;
    }
  }

  if ($p === '/api/docentes' && $method === 'GET') {
    $pl = page_limit(50);
    $qtxt = trim((string)($_GET['q'] ?? ''));
    $where = ' WHERE 1=1';
    $params = [];
    if ($qtxt !== '') {
      $lk = like($qtxt);
      $where .= ' AND (v.Docente LIKE ? OR v.`No. Empleado` LIKE ?)';
      $params[] = $lk;
      $params[] = $lk;
    }
    $totalRows = db_query($conexion, 'SELECT COUNT(*) AS n FROM v_docentes v' . $where, $params);
    $limit = (int)$pl['limit'];
    $offset = (int)$pl['offset'];
    $rows = db_query(
      $conexion,
      "SELECT v.`No.` AS id, v.`No.` AS no_num, v.Docente AS nombre, v.`No. Empleado` AS num_empleado,
              v.`Teléfono` AS telefono, v.Correo AS correo, v.Sexo AS sexo, v.TC AS tc,
              v.`No. Tesis` AS no_tesis
       FROM v_docentes v
       {$where}
       ORDER BY v.`No.`
       LIMIT {$limit} OFFSET {$offset}",
      $params
    );
    send(200, ['page' => $pl['page'], 'limit' => $pl['limit'], 'total' => (int)$totalRows[0]['n'], 'rows' => $rows]);
  }

  if ($p === '/api/docentes/buscar' && $method === 'GET') {
    $qtxt = trim((string)($_GET['q'] ?? ''));
    if ($qtxt === '') send(200, ['rows' => []]);
    $lk = like($qtxt);
    $rows = db_query(
      $conexion,
      'SELECT id, nombre, num_empleado, sexo, tc FROM docentes WHERE nombre LIKE ? OR num_empleado LIKE ? ORDER BY nombre LIMIT 12',
      [$lk, $lk]
    );
    send(200, ['rows' => $rows]);
  }

  if ($p === '/api/docentes' && $method === 'POST') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede registrar docentes.']);
    $body = read_body();
    $nombre = trim((string)($body['nombre'] ?? ''));
    if ($nombre === '') send(400, ['error' => 'Escribe el nombre del docente.']);
    $ins = db_exec(
      $conexion,
      'INSERT INTO docentes (nombre, num_empleado, telefono, correo, sexo, tc) VALUES (?, ?, ?, ?, ?, ?)',
      [$nombre, $body['num_empleado'] ?? null, $body['telefono'] ?? null, $body['correo'] ?? null, $body['sexo'] ?? null, $body['tc'] ?? null]
    );
    send(201, ['id' => $ins['insertId']]);
  }

  if (preg_match('#^/api/docentes/(\\d+)$#', $p, $docenteId)) {
    $id = (int)$docenteId[1];
    if ($method === 'PUT') {
      if (!is_admin()) send(403, ['error' => 'Solo el administrador puede editar docentes.']);
      $body = read_body();
      $nombre = trim((string)($body['nombre'] ?? ''));
      if ($nombre === '') send(400, ['error' => 'Escribe el nombre del docente.']);
      $prev = db_query($conexion, 'SELECT * FROM docentes WHERE id = ?', [$id]);
      if (!$prev) send(404, ['error' => 'Docente no encontrado']);
      db_exec(
        $conexion,
        'UPDATE docentes SET nombre=?, num_empleado=?, telefono=?, correo=?, sexo=?, tc=? WHERE id=?',
        [
          $nombre,
          empty_to_null($body['num_empleado'] ?? null),
          empty_to_null($body['telefono'] ?? null),
          empty_to_null($body['correo'] ?? null),
          empty_to_null($body['sexo'] ?? null),
          empty_to_null($body['tc'] ?? null),
          $id
        ]
      );
      if ($prev[0]['nombre'] !== $nombre) {
        db_exec($conexion, 'UPDATE bd SET docente = ? WHERE docente_id = ?', [$nombre, $id]);
        db_exec($conexion, 'UPDATE bd_asignacion SET nombre_docente = ? WHERE nombre_docente = ?', [$nombre, $prev[0]['nombre']]);
      }
      $emp = empty_to_null($body['num_empleado'] ?? null);
      if ($emp) db_exec($conexion, 'UPDATE bd SET no_empleado = ? WHERE docente_id = ?', [$emp, $id]);
      send(200, ['ok' => true]);
    }
    if ($method === 'GET') {
      $docs = db_query($conexion, 'SELECT * FROM docentes WHERE id = ?', [$id]);
      if (!$docs) send(404, ['error' => 'Docente no encontrado']);
      $filas = db_query(
        $conexion,
        'SELECT anio, alumno, titulo_tesis, fungio, grado, ciudad, folio, no_tesis FROM bd WHERE docente_id = ? ORDER BY anio DESC, id DESC',
        [$id]
      );
      send(200, ['docente' => $docs[0], 'filas' => $filas]);
    }
  }

  if ($p === '/api/actividad' && $method === 'GET') {
    $anio = (string)($_GET['anio'] ?? '');
    $ciudad = (string)($_GET['ciudad'] ?? 'GENERAL');
    if (preg_match('/^\\d{4}$/', $anio) && $ciudad !== '' && $ciudad !== 'GENERAL') {
      $rows = db_query(
        $conexion,
        "SELECT `Año` AS anio, `No` AS no_num, Docente AS docente, Ciudad AS ciudad,
                `L A` AS l_a, `L R` AS l_r, `M A` AS m_a, `M D` AS m_d, `M R` AS m_r,
                `D A` AS d_a, `D D` AS d_d, `D R` AS d_r, TOTAL AS total
         FROM v_actividad_docente
         WHERE `Año` = ? AND Ciudad = ?
         ORDER BY TOTAL DESC, Docente",
        [(int)$anio, $ciudad]
      );
    } elseif (preg_match('/^\\d{4}$/', $anio)) {
      $rows = db_query(
        $conexion,
        "SELECT `Año` AS anio, MIN(`No`) AS no_num, Docente AS docente, 'GENERAL' AS ciudad,
                SUM(`L A`) AS l_a, SUM(`L R`) AS l_r, SUM(`M A`) AS m_a, SUM(`M D`) AS m_d, SUM(`M R`) AS m_r,
                SUM(`D A`) AS d_a, SUM(`D D`) AS d_d, SUM(`D R`) AS d_r, SUM(TOTAL) AS total
         FROM v_actividad_docente
         WHERE `Año` = ?
         GROUP BY `Año`, Docente
         ORDER BY total DESC, Docente",
        [(int)$anio]
      );
    } elseif ($ciudad !== '' && $ciudad !== 'GENERAL') {
      $rows = db_query(
        $conexion,
        "SELECT `Año` AS anio, `No` AS no_num, Docente AS docente, Ciudad AS ciudad,
                `L A` AS l_a, `L R` AS l_r, `M A` AS m_a, `M D` AS m_d, `M R` AS m_r,
                `D A` AS d_a, `D D` AS d_d, `D R` AS d_r, TOTAL AS total
         FROM v_actividad_docente
         WHERE Ciudad = ?
         ORDER BY `Año` DESC, TOTAL DESC, Docente",
        [$ciudad]
      );
    } else {
      $rows = db_query(
        $conexion,
        "SELECT `Año` AS anio, MIN(`No`) AS no_num, Docente AS docente, 'GENERAL' AS ciudad,
                SUM(`L A`) AS l_a, SUM(`L R`) AS l_r, SUM(`M A`) AS m_a, SUM(`M D`) AS m_d, SUM(`M R`) AS m_r,
                SUM(`D A`) AS d_a, SUM(`D D`) AS d_d, SUM(`D R`) AS d_r, SUM(TOTAL) AS total
         FROM v_actividad_docente
         GROUP BY `Año`, Docente
         ORDER BY `Año` DESC, total DESC, Docente"
      );
    }
    $filtros = db_query($conexion, 'SELECT DISTINCT `Año` AS anio FROM v_actividad_docente WHERE `Año` IS NOT NULL ORDER BY `Año` DESC');
    $ciudades = db_query($conexion, "SELECT DISTINCT Ciudad AS ciudad FROM v_actividad_docente WHERE Ciudad IS NOT NULL AND Ciudad <> '' ORDER BY Ciudad");
    send(200, [
      'anios' => array_column($filtros, 'anio'),
      'ciudades' => array_column($ciudades, 'ciudad'),
      'rows' => $rows
    ]);
  }

  if ($p === '/api/constancias' && $method === 'GET') {
    $folio = trim((string)($_GET['folio'] ?? ''));
    if ($folio === '') send(400, ['error' => 'Escribe el folio.']);
    $filas = db_query(
      $conexion,
      "SELECT b.id, b.anio, b.folio, b.alumno, b.grado, b.titulo_tesis, b.fecha_elaboracion, b.docente, b.fungio,
              b.punto, b.ciudad, b.no_tesis, b.no_caja, b.programa, b.docente_id,
              d.sexo AS docente_sexo, d.num_empleado
       FROM bd b LEFT JOIN docentes d ON d.id = b.docente_id
       WHERE b.folio = ? ORDER BY b.id",
      [$folio]
    );
    if (!$filas) send(200, ['found' => false]);
    $groups = [];
    foreach ($filas as $row) {
      $idx = null;
      foreach ($groups as $i => $x) {
        if (same_tesis($x, $row)) { $idx = $i; break; }
      }
      if ($idx === null) {
        $groups[] = [
          'anio' => $row['anio'], 'alumno' => $row['alumno'], 'titulo_tesis' => $row['titulo_tesis'],
          'grado' => $row['grado'], 'fecha_elaboracion' => $row['fecha_elaboracion'],
          'programa' => $row['programa'], 'ciudad' => $row['ciudad'], 'no_tesis' => $row['no_tesis'],
          'no_caja' => $row['no_caja'], 'folio' => $row['folio'], 'punto' => $row['punto'],
          'ids' => [], 'docentes' => [], 'alumnos' => []
        ];
        $idx = count($groups) - 1;
      }
      $groups[$idx]['ids'][] = $row['id'];
      $groups[$idx]['docentes'][] = [
        'nombre' => $row['docente'], 'fungio' => $row['fungio'], 'docente_id' => $row['docente_id'],
        'sexo' => $row['docente_sexo'], 'num_empleado' => $row['num_empleado']
      ];
    }
    foreach ($groups as &$g) {
      $ph = implode(',', array_fill(0, count($g['ids']), '?'));
      $g['alumnos'] = db_query(
        $conexion,
        "SELECT DISTINCT a.id, a.nombre, a.matricula, a.sexo
         FROM bd_alumnos ba JOIN alumnos a ON a.id = ba.alumno_id
         WHERE ba.bd_id IN ({$ph})
         ORDER BY a.nombre",
        $g['ids']
      );
      unset($g['ids']);
    }
    unset($g);
    send(200, ['found' => true, 'tesis' => $groups]);
  }

  if ($p === '/api/historial' && $method === 'GET') {
    $rows = db_query(
      $conexion,
      'SELECT id, tipo, valor_anterior, valor_nuevo, usuario, detalle, creado_en FROM app_historial ORDER BY creado_en DESC, id DESC LIMIT 200'
    );
    send(200, ['rows' => $rows]);
  }

  if ($p === '/api/historial' && $method === 'POST') {
    $body = read_body();
    historial_insert($conexion, [
      'tipo' => substr((string)($body['tipo'] ?? 'Documento'), 0, 60),
      'valor_anterior' => $body['valor_anterior'] ?? null,
      'valor_nuevo' => $body['valor_nuevo'] ?? null,
      'usuario' => usuario_de($body),
      'detalle' => $body['detalle'] ?? null
    ]);
    send(201, ['ok' => true]);
  }

  if ($p === '/api/asignacion' && $method === 'GET') {
    $pl = page_limit(50);
    $anio = (string)($_GET['anio'] ?? '');
    $estatus = (string)($_GET['estatus'] ?? '');
    $qtxt = trim((string)($_GET['q'] ?? ''));
    $where = ' WHERE 1=1';
    $params = [];
    if (preg_match('/^\\d{4}$/', $anio)) { $where .= ' AND anio = ?'; $params[] = (int)$anio; }
    if ($estatus !== '' && $estatus !== 'Todos') { $where .= ' AND estatus = ?'; $params[] = $estatus; }
    if ($qtxt !== '') {
      $lk = like($qtxt);
      $where .= ' AND (nombre_alumno LIKE ? OR matricula LIKE ? OR nombre_docente LIKE ? OR folio_a LIKE ? OR folio_m LIKE ?)';
      array_push($params, $lk, $lk, $lk, $lk, $lk);
    }
    $totalRows = db_query($conexion, 'SELECT COUNT(*) AS n FROM bd_asignacion' . $where, $params);
    $limit = (int)$pl['limit'];
    $offset = (int)$pl['offset'];
    $rows = db_query(
      $conexion,
      "SELECT id, anio, `no`, folio_a, sexo, nombre_alumno, matricula, programa, telefono_a, correo_a,
              folio_m, nombre_docente, telefono_docente, correo_docente, fecha_solicitud, estatus, ea, ed,
              tesis_entregada, observaciones, alumno_id, docente_id
       FROM bd_asignacion{$where}
       ORDER BY anio DESC, id ASC
       LIMIT {$limit} OFFSET {$offset}",
      $params
    );
    $anios = db_query($conexion, 'SELECT DISTINCT anio AS v FROM bd_asignacion WHERE anio IS NOT NULL ORDER BY anio DESC');
    $estatuses = db_query($conexion, "SELECT DISTINCT estatus AS v FROM bd_asignacion WHERE estatus IS NOT NULL AND estatus <> '' ORDER BY estatus");
    send(200, [
      'page' => $pl['page'], 'limit' => $pl['limit'], 'total' => (int)$totalRows[0]['n'], 'rows' => $rows,
      'anios' => array_column($anios, 'v'),
      'estatuses' => array_column($estatuses, 'v')
    ]);
  }

  if ($p === '/api/asignacion' && $method === 'POST') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede agregar asignaciones.']);
    $b = read_body();
    $ins = db_exec(
      $conexion,
      'INSERT INTO bd_asignacion (anio, `no`, folio_a, sexo, nombre_alumno, matricula, programa, telefono_a, correo_a,
          folio_m, nombre_docente, telefono_docente, correo_docente, fecha_solicitud, estatus, ea, ed,
          tesis_entregada, observaciones, alumno_id, docente_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        $b['anio'] ?? null, $b['no'] ?? null, substr((string)($b['folio_a'] ?? ''), 0, 20) ?: null, $b['sexo'] ?? null,
        $b['nombre_alumno'] ?? null, $b['matricula'] ?? null, $b['programa'] ?? null, $b['telefono_a'] ?? null, $b['correo_a'] ?? null,
        substr((string)($b['folio_m'] ?? ''), 0, 20) ?: null, $b['nombre_docente'] ?? null, $b['telefono_docente'] ?? null,
        $b['correo_docente'] ?? null, $b['fecha_solicitud'] ?? null, $b['estatus'] ?? null, $b['ea'] ?? null, $b['ed'] ?? null,
        $b['tesis_entregada'] ?? null, $b['observaciones'] ?? null, $b['alumno_id'] ?? null, $b['docente_id'] ?? null
      ]
    );
    send(201, ['id' => $ins['insertId']]);
  }

  if (preg_match('#^/api/asignacion/(\\d+)$#', $p, $asId) && $method === 'PUT') {
    if (!is_admin()) send(403, ['error' => 'Solo el administrador puede editar asignaciones.']);
    $id = (int)$asId[1];
    $b = read_body();
    $resD = !empty($b['nombre_docente']) ? resolver_docente($conexion, $b['nombre_docente'], $b['docente_id'] ?? null) : ['id' => null];
    $r = db_exec(
      $conexion,
      'UPDATE bd_asignacion SET anio=?, `no`=?, folio_a=?, sexo=?, nombre_alumno=?, matricula=?, programa=?,
          telefono_a=?, correo_a=?, folio_m=?, nombre_docente=?, telefono_docente=?, correo_docente=?,
          fecha_solicitud=?, estatus=?, ea=?, ed=?, tesis_entregada=?, observaciones=?, docente_id=?
       WHERE id=?',
      [
        $b['anio'] ?? null, $b['no'] ?? null, substr((string)($b['folio_a'] ?? ''), 0, 20) ?: null, $b['sexo'] ?? null,
        $b['nombre_alumno'] ?? null, $b['matricula'] ?? null, $b['programa'] ?? null, $b['telefono_a'] ?? null, $b['correo_a'] ?? null,
        substr((string)($b['folio_m'] ?? ''), 0, 20) ?: null, $b['nombre_docente'] ?? null, $b['telefono_docente'] ?? null,
        $b['correo_docente'] ?? null, $b['fecha_solicitud'] ?? null, $b['estatus'] ?? null, $b['ea'] ?? null, $b['ed'] ?? null,
        $b['tesis_entregada'] ?? null, $b['observaciones'] ?? null, $resD['id'], $id
      ]
    );
    if (!$r['affectedRows']) send(404, ['error' => 'Asignación no encontrada']);
    send(200, ['ok' => true]);
  }

  if ($p === '/api/asignacion/oficio' && $method === 'GET') {
    $tipo = trim((string)($_GET['tipo'] ?? 'Alumno'));
    $folio = trim((string)($_GET['folio'] ?? ''));
    if ($folio === '') send(400, ['error' => 'Escribe el folio.']);
    $esDir = preg_match('/^(Doctor|Doctora|Maestro)/i', $tipo);
    $col = $esDir ? 'folio_m' : 'folio_a';
    $rows = db_query($conexion, "SELECT * FROM bd_asignacion WHERE {$col} = ? ORDER BY id", [$folio]);
    if (!$rows) {
      $otra = $esDir ? 'folio_a' : 'folio_m';
      $rows = db_query($conexion, "SELECT * FROM bd_asignacion WHERE {$otra} = ? ORDER BY id", [$folio]);
    }
    if (!$rows) send(200, ['found' => false]);
    $relacionados = [];
    if (preg_match('/^comit/i', $tipo) && !empty($rows[0]['nombre_alumno'])) {
      $alum = trim((string)$rows[0]['nombre_alumno']);
      $relacionados = db_query(
        $conexion,
        'SELECT docente, fungio FROM bd WHERE alumno = ? OR alumno LIKE ? ORDER BY id LIMIT 40',
        [$alum, '%' . $alum . '%']
      );
    }
    send(200, ['found' => true, 'tipo' => $tipo, 'rows' => $rows, 'relacionados' => $relacionados]);
  }

  send(404, ['error' => 'Ruta no encontrada']);
} catch (Throwable $err) {
  send(500, ['error' => conexion_error($err)]);
}
