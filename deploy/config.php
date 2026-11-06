<?php
/**
 * Conexión MySQL — producción (cPanel).
 * Escribe la contraseña en $db_pass.
 * Para XAMPP local, comenta producción y descomenta el bloque local.
 */

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

// --- Producción ---
$db_host = 'localhost';
$db_name = 'josefr41_progest';
$db_user = 'josefr41_progest';
$db_pass = '';

// --- Local XAMPP ---
// $db_host = 'localhost';
// $db_name = 'progest';
// $db_user = 'root';
// $db_pass = '';

$conexion = new mysqli($db_host, $db_user, $db_pass, $db_name);
$conexion->set_charset('utf8mb4');
