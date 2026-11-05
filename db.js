const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const q = async (sql, params = []) => {
      const [rows] = await conn.execute(sql, params);
      return rows;
    };
    const result = await fn(q, conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

function conexionError(err) {
  const code = err && err.code ? ` (${err.code})` : '';
  const msg = err && err.sqlMessage ? String(err.sqlMessage) : '';
  if (msg && !/password|passwd/i.test(msg)) {
    return `Error de MySQL${code}: ${msg}`;
  }
  return `No se pudo conectar a MySQL${code}. Revisa que XAMPP (MySQL) esté encendido y que DB_HOST, DB_PORT, DB_NAME y DB_USER en .env sean correctos.`;
}

module.exports = { query, pool, withTransaction, conexionError };
