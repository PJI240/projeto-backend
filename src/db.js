import mysql from "mysql2/promise";

console.log('🔍 Variáveis disponíveis:');
console.log('- MYSQL_URL:', process.env.MYSQL_URL ? '✅' : '❌');
console.log('- DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');

// Use MYSQL_URL (fornecida automaticamente pelo Railway)
const connectionString = process.env.MYSQL_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ Nenhuma URL de banco encontrada!');
  process.exit(1);
}

const pool = mysql.createPool({
  uri: connectionString,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 30000
});

console.log('✅ Pool de conexão criado');

export { pool };
