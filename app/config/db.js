const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME     || 'save_pvp',
  user:     process.env.DB_USER,
  password: process.env.DB_PASS || process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone: '+01:00',
});

// Test de conexión al arrancar
pool.getConnection()
  .then(conn => {
    console.log('✅  MySQL conectado correctamente');
    conn.release();
  })
  .catch(err => {
    console.error('❌  Error conectando a MySQL:', err.message);
    process.exit(1);
  });

module.exports = pool;
