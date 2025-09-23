require('dotenv').config();
const mysql = require('mysql2/promise');

// Criamos um pool de conexões para reutilizar
const pool = mysql.createPool({
  host: process.env.DB_HOST,        // Host do MySQL (Railway injeta)
  port: Number(process.env.DB_PORT || 3306), // Porta do MySQL
  user: process.env.DB_USER,        // Usuário do MySQL
  password: process.env.DB_PASS,    // Senha do MySQL
  database: process.env.DB_NAME,    // Nome do banco
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Caso o Railway peça SSL (alguns planos pedem):
  // ssl: { rejectUnauthorized: true },
});

module.exports = { pool };
