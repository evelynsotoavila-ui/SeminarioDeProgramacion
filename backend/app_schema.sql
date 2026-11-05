-- Tablas propias de la aplicación. No modifica bd, docentes, alumnos,
-- bd_alumnos, bd_asignacion ni las vistas existentes.

CREATE TABLE IF NOT EXISTS app_historial (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tipo VARCHAR(60) NOT NULL,
  valor_anterior TEXT NULL,
  valor_nuevo TEXT NULL,
  usuario VARCHAR(120) NULL,
  detalle TEXT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_app_hist_fecha (creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
