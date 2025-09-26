import mysql from "mysql2/promise";

function getDbConfig() {
  if (process.env.DATABASE_URL) {
    console.log('📦 Usando DATABASE_URL para conexão externa');
    return {
      uri: process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      namedPlaceholders: true,
    };
  }

  console.log('🔧 Usando variáveis individuais para conexão');
  const host = process.env.MYSQLHOST || "localhost";
  const port = Number(process.env.MYSQLPORT || 3306);
  const user = process.env.MYSQLUSER || "root";
  const password = process.env.MYSQLPASSWORD || "";
  const database = process.env.MYSQLDATABASE || "railway";

  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
  };
}

export const pool = mysql.createPool(getDbConfig());

// Teste de conexão (opcional - remove depois)
pool.getConnection()
  .then(() => console.log('✅ Conexão com MySQL estabelecida'))
  .catch(err => console.error('❌ Erro de conexão MySQL:', err.message));
