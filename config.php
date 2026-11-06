<?php
/**
 * Conexión MySQL del proyecto.
 * Activa: producción. Para volver a XAMPP, comenta el bloque de producción
 * y descomenta el de local (o incluye config.local.php).
 */

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

// --- Producción ---
$db_host = 'localhost';
$db_name = 'josefr41_progest';
$db_user = 'josefr41_progest';
$db_pass = 'E5trella230704';

// --- Local XAMPP ---
// $db_host = 'localhost';
// $db_name = 'progest';
// $db_user = 'root';
// $db_pass = '';

$conexion = new mysqli($db_host, $db_user, $db_pass, $db_name);
$conexion->set_charset('utf8mb4');
