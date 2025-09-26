import mysql from "mysql2/promise";

console.log('=== CONFIGURAÇÃO DO BANCO ===');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'PRESENTE' : 'AUSENTE');
console.log('NODE_ENV:', process.env.NODE_ENV);

// FORÇAR uso da DATABASE_URL do Railway
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL não encontrada! Configure no Railway.');
  process.exit(1);
}

// Configuração explícita
const config = {
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 60000,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  namedPlaceholders: true
};

console.log('Tentando conectar com:', {
  host: new URL(process.env.DATABASE_URL).hostname,
  port: new URL(process.env.DATABASE_URL).port,
  database: new URL(process.env.DATABASE_URL).pathname.replace('/', '')
});

const pool = mysql.createPool(config);

// Teste de conexão imediato
pool.execute('SELECT 1 + 1 AS result')
  .then(([rows]) => {
    console.log('✅ Teste de conexão bem-sucedido:', rows);
  })
  .catch(err => {
    console.error('❌ Falha no teste de conexão:');
    console.error('Mensagem:', err.message);
    console.error('Código:', err.code);
    console.error('Stack:', err.stack);
  });

export { pool };
